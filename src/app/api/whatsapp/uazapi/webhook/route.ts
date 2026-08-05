import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { hashInstanceToken } from '@/lib/whatsapp/uazapi-token'

export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * POST /api/whatsapp/uazapi/webhook
 *
 * PRIMEIRA VERSÃO — DELIBERADAMENTE SÓ OBSERVA.
 *
 * A UAZAPI não assina os callbacks. A autenticação é o próprio `token`
 * da instância, que ela ecoa no corpo: procuramos a conta por
 * sha256(token) contra `uazapi_instance_token_hash`. Nada bate → 404,
 * sem revelar informação.
 *
 * Esta versão não interpreta a mensagem: ela loga o payload cru para
 * capturarmos a forma REAL antes de escrever qualquer parser. A Fase 1
 * inteira foi perdida por escrever cliente contra um contrato suposto
 * que os próprios mocks confirmavam. Task 4 escreve o parser contra o
 * que este log capturar.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // A doc da comunidade diz que o payload é flat e ecoa `token`. Não
  // verificamos isso ao vivo ainda — por isso aceitamos também `owner`
  // (número da própria instância) como chave alternativa, e logamos as
  // duas para a Task 4 saber qual existe de verdade.
  const token = typeof body.token === 'string' ? body.token : null
  const owner = typeof body.owner === 'string' ? body.owner : null

  let accountId: string | null = null
  if (token) {
    const { data } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('uazapi_instance_token_hash', hashInstanceToken(token))
      .maybeSingle()
    accountId = data?.account_id ?? null
  }
  if (!accountId && owner) {
    const { data } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('provider', 'uazapi')
      .eq('uazapi_connected_phone', owner)
      .maybeSingle()
    accountId = data?.account_id ?? null
  }

  // Log de captura. Nunca imprime o token — só se ele veio e se casou.
  console.log('[uazapi/webhook] RAW PAYLOAD', JSON.stringify({
    matchedAccount: accountId,
    routedBy: accountId ? (token ? 'token' : 'owner') : 'none',
    hasToken: token !== null,
    topLevelKeys: Object.keys(body),
    payload: redact(body),
  }))

  if (!accountId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json({ status: 'received' }, { status: 200 })
}

/** Remove o token do que vai para o log, preservando o resto da forma. */
function redact(body: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...body }
  if ('token' in copy) copy.token = '<redacted>'
  return copy
}
