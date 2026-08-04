import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getInstanceStatus } from '@/lib/whatsapp/uazapi-api'
import { hashInstanceToken } from '@/lib/whatsapp/uazapi-token'
import { encrypt } from '@/lib/whatsapp/encryption'
import { resolveAccountId, toStatusPayload } from '@/lib/whatsapp/uazapi-account'

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
 * Salvar troca o provedor da conta para UAZAPI e apaga as credenciais
 * da Meta. Quando existe uma integração Meta viva isso exige
 * `confirm_switch: true` — sem ele a rota devolve 409 para a UI poder
 * pedir confirmação ao operador.
 *
 * Body: { instance_token: string, confirm_switch?: boolean }
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

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, provider, access_token')
      .eq('account_id', accountId)
      .maybeSingle()

    // Gravar aqui zera o lado da Meta (ver `row` abaixo). Se a conta
    // tem uma integração Meta VIVA (provider meta + token gravado),
    // isso destrói credenciais em uso e sem volta — o token cifrado
    // some do banco e só o operador da Meta consegue emitir outro.
    // Exigimos confirmação explícita em vez de fazê-lo calado.
    if (existing?.provider === 'meta' && existing?.access_token && body?.confirm_switch !== true) {
      return NextResponse.json(
        {
          error:
            'This account already has a Meta WhatsApp integration connected. Saving a UAZAPI instance token will disconnect it and permanently erase the stored Meta credentials. Resend with confirm_switch: true to proceed.',
          reason: 'meta_config_will_be_replaced',
          requires_confirmation: true,
        },
        { status: 409 },
      )
    }

    // Cifrar pode falhar com ENCRYPTION_KEY malformada. Sem este
    // catch a falha cai no 500 genérico do fim e o operador não tem
    // como saber que o problema é a chave — mesmo tratamento de
    // /api/whatsapp/config.
    let encryptedToken: string
    try {
      encryptedToken = encrypt(rawToken)
    } catch (err) {
      console.error('[uazapi/config] encryption failed:', err)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 },
      )
    }

    // Uma única fonte para "está conectado?" — a mesma que /connect,
    // /status e /disconnect usam. Calcular à mão aqui já tinha
    // produzido duas fórmulas divergentes para o mesmo conceito.
    const payload = toStatusPayload(state)

    const row = {
      provider: 'uazapi' as const,
      uazapi_instance_token: encryptedToken,
      uazapi_instance_token_hash: tokenHash,
      uazapi_instance_name: payload.instance_name,
      uazapi_status: payload.instance_status,
      uazapi_connected_phone: payload.phone,
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
      status: payload.connected ? 'connected' : 'disconnected',
      connected_at: payload.connected ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }

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
        name: payload.instance_name,
        status: payload.instance_status,
        connected: payload.connected,
        phone: payload.phone,
        profile_name: payload.profile_name,
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
