import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { connectInstance, setWebhook } from '@/lib/whatsapp/uazapi-api'
import {
  resolveAccountId,
  loadUazapiToken,
  toStatusPayload,
  UAZAPI_ERROR_MESSAGE,
} from '@/lib/whatsapp/uazapi-account'

/**
 * POST /api/whatsapp/uazapi/connect
 *
 * Dispara a conexão e devolve o primeiro QR. Chamado uma vez por
 * tentativa — a partir daí o painel só faz polling em /status, que
 * entrega o QR rotacionado pela UAZAPI.
 *
 * Também é o botão "tentar de novo" quando a janela expira ("QR Code
 * timeout"): rechamar aqui abre uma janela nova.
 */
export async function POST() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'Your profile is not linked to an account.' }, { status: 403 })
    }

    const loaded = await loadUazapiToken(supabase, accountId)
    if ('error' in loaded) {
      return NextResponse.json(
        { ok: false, reason: loaded.error, message: UAZAPI_ERROR_MESSAGE[loaded.error] },
        { status: 200 },
      )
    }

    let state
    try {
      state = await connectInstance({ token: loaded.token })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown UAZAPI error'
      return NextResponse.json({ ok: false, reason: 'uazapi_error', message }, { status: 200 })
    }

    // Registra o webhook desta conta na instância. Idempotente
    // (verificado: /webhook é upsert e mantém uma entrada só), então
    // rodar a cada conexão é seguro e conserta um registro perdido.
    //
    // A URL precisa ser pública — a UAZAPI não alcança localhost. Em
    // desenvolvimento sem túnel isto falha, e falhar aqui NÃO pode
    // impedir a conexão: logamos e seguimos.
    const publicBase = process.env.NEXT_PUBLIC_SITE_URL
    if (publicBase) {
      try {
        await setWebhook({
          token: loaded.token,
          url: `${publicBase.replace(/\/$/, '')}/api/whatsapp/uazapi/webhook`,
          events: ['messages', 'connection'],
        })
      } catch (err) {
        console.error(
          '[uazapi/connect] webhook registration failed (connection still OK):',
          err instanceof Error ? err.message : err
        )
      }
    } else {
      console.warn('[uazapi/connect] NEXT_PUBLIC_SITE_URL unset — webhook not registered')
    }

    return NextResponse.json(toStatusPayload(state))
  } catch (error) {
    console.error('[uazapi/connect] failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
