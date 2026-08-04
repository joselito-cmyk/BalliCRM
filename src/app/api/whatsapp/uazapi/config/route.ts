import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getInstanceStatus } from '@/lib/whatsapp/uazapi-api'
import { hashInstanceToken } from '@/lib/whatsapp/uazapi-token'
import { encrypt } from '@/lib/whatsapp/encryption'
import { resolveAccountId } from '@/lib/whatsapp/uazapi-account'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

/**
 * POST /api/whatsapp/uazapi/config
 *
 * Salva o Instance Token que o operador colou. Valida contra a UAZAPI
 * ANTES de gravar — um token inválido é recusado na hora, em vez de
 * virar uma config quebrada que só falha na hora de conectar.
 *
 * Body: { instance_token: string }
 */
export async function POST(request: Request) {
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

    const body = await request.json()
    const rawToken = typeof body?.instance_token === 'string' ? body.instance_token.trim() : ''
    if (!rawToken) {
      return NextResponse.json({ error: 'instance_token is required' }, { status: 400 })
    }

    // Valida contra a UAZAPI antes de qualquer escrita.
    let state
    try {
      state = await getInstanceStatus({ token: rawToken })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown UAZAPI error'
      return NextResponse.json(
        { error: `UAZAPI rejected this token: ${message}` },
        { status: 400 },
      )
    }

    const tokenHash = hashInstanceToken(rawToken)

    // Uma instância não pode servir duas contas: o webhook da Fase 3
    // busca a linha pelo hash com .maybeSingle(), e duas linhas fariam
    // ele descartar as mensagens das duas. Sob RLS a conta não enxerga
    // linhas alheias, daí o service role.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('uazapi_instance_token_hash', tokenHash)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('[uazapi/config] ownership check failed:', claimedError)
      return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
    }
    if (claimed) {
      return NextResponse.json(
        { error: 'This UAZAPI instance is already linked to another account.' },
        { status: 409 },
      )
    }

    const row = {
      provider: 'uazapi' as const,
      uazapi_instance_token: encrypt(rawToken),
      uazapi_instance_token_hash: tokenHash,
      uazapi_instance_name: state.instance.name || null,
      uazapi_status: state.instance.status,
      uazapi_connected_phone: state.instance.owner || null,
      // Trocar de provedor zera o lado da Meta: manter credenciais
      // órfãs faria o CHECK de coerência da 038 passar por acidente e
      // deixaria um token da Meta cifrado no banco sem dono.
      phone_number_id: null,
      waba_id: null,
      access_token: null,
      verify_token: null,
      registered_at: null,
      subscribed_apps_at: null,
      last_registration_error: null,
      status: state.status.loggedIn ? 'connected' : 'disconnected',
      connected_at: state.status.loggedIn ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    const { error: writeError } = existing
      ? await supabase.from('whatsapp_config').update(row).eq('account_id', accountId)
      : await supabase.from('whatsapp_config').insert({ account_id: accountId, user_id: user.id, ...row })

    if (writeError) {
      console.error('[uazapi/config] write failed:', writeError)
      return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      instance: {
        name: state.instance.name,
        status: state.instance.status,
        connected: state.status.connected && state.status.loggedIn,
        phone: state.instance.owner || null,
        profile_name: state.instance.profileName || null,
      },
    })
  } catch (error) {
    console.error('[uazapi/config] POST failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/uazapi/config
 *
 * Esquece a instância — apaga a linha do CRM. NÃO chama DELETE
 * /instance na UAZAPI: a instância continua existindo no painel, e é
 * lá que ela se apaga. Deletar daqui queimaria a única vaga da
 * assinatura por engano.
 */
export async function DELETE() {
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

    const { error } = await supabase.from('whatsapp_config').delete().eq('account_id', accountId)
    if (error) {
      console.error('[uazapi/config] delete failed:', error)
      return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[uazapi/config] DELETE failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
