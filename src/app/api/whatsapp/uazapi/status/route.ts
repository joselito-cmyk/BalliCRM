import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getInstanceStatus } from '@/lib/whatsapp/uazapi-api'
import {
  resolveAccountId,
  loadUazapiToken,
  toStatusPayload,
  UAZAPI_ERROR_MESSAGE,
} from '@/lib/whatsapp/uazapi-account'

/**
 * GET /api/whatsapp/uazapi/status
 *
 * Alvo do polling do painel. Devolve estado E QR vigente numa chamada
 * só — a UAZAPI rotaciona o QR por conta própria, então não existe
 * (nem é preciso) um endpoint de "renovar QR".
 *
 * Erros de configuração voltam como 200 com ok:false, no mesmo padrão
 * de /api/whatsapp/config: a UI mostra a remediação certa em vez de um
 * 500 genérico. Só falha de auth vira status HTTP de erro.
 *
 * Persiste o estado observado (status e número) para a página de
 * Configurações conseguir mostrar algo sem bater na UAZAPI no
 * carregamento.
 */
export async function GET() {
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
      state = await getInstanceStatus({ token: loaded.token })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown UAZAPI error'
      return NextResponse.json({ ok: false, reason: 'uazapi_error', message }, { status: 200 })
    }

    const payload = toStatusPayload(state)

    await supabase
      .from('whatsapp_config')
      .update({
        uazapi_status: payload.instance_status,
        uazapi_connected_phone: payload.phone,
        status: payload.connected ? 'connected' : 'disconnected',
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId)

    return NextResponse.json(payload)
  } catch (error) {
    console.error('[uazapi/status] failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
