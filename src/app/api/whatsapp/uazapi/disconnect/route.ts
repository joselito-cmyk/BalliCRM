import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { disconnectInstance } from '@/lib/whatsapp/uazapi-api'
import {
  resolveAccountId,
  loadUazapiToken,
  UAZAPI_ERROR_MESSAGE,
} from '@/lib/whatsapp/uazapi-account'

/**
 * POST /api/whatsapp/uazapi/disconnect
 *
 * Desloga o telefone. A instância continua existindo na UAZAPI e o
 * token segue salvo, então reconectar é só clicar em Conectar de novo.
 * Para esquecer a instância de vez, use DELETE /api/whatsapp/uazapi/config.
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

    try {
      await disconnectInstance({ token: loaded.token })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown UAZAPI error'
      return NextResponse.json({ ok: false, reason: 'uazapi_error', message }, { status: 200 })
    }

    await supabase
      .from('whatsapp_config')
      .update({
        uazapi_status: 'disconnected',
        uazapi_connected_phone: null,
        status: 'disconnected',
        connected_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId)

    return NextResponse.json({ ok: true, connected: false, instance_status: 'disconnected' })
  } catch (error) {
    console.error('[uazapi/disconnect] failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
