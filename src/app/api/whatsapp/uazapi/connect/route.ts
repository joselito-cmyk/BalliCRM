import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { connectInstance } from '@/lib/whatsapp/uazapi-api'
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

    return NextResponse.json(toStatusPayload(state))
  } catch (error) {
    console.error('[uazapi/connect] failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
