import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { hashInstanceToken } from '@/lib/whatsapp/uazapi-token'
import { parseUazapiInbound } from '@/lib/whatsapp/uazapi-inbound'
import { processInboundMessage, processInboundReaction } from '@/lib/whatsapp/inbound'

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
 * A UAZAPI não assina os callbacks. A autenticação é o próprio `token`
 * da instância, que ela ecoa no corpo: procuramos a conta por
 * sha256(token) contra `uazapi_instance_token_hash`. Nada bate → 404,
 * sem revelar informação.
 *
 * `parseUazapiInbound` (Task 4, escrito contra payloads reais capturados
 * em produção — ver docs/superpowers/specs/uazapi-inbound-payloads.md)
 * traduz o payload cru para a forma normalizada que o pipeline
 * provedor-agnóstico (`processInboundMessage`/`processInboundReaction`,
 * Task 1) consome.
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
  let configOwnerUserId: string | null = null
  if (token) {
    const { data } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id, user_id')
      .eq('uazapi_instance_token_hash', hashInstanceToken(token))
      .maybeSingle()
    accountId = data?.account_id ?? null
    configOwnerUserId = data?.user_id ?? null
  }
  if (!accountId && owner) {
    const { data } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id, user_id')
      .eq('provider', 'uazapi')
      .eq('uazapi_connected_phone', owner)
      .maybeSingle()
    accountId = data?.account_id ?? null
    configOwnerUserId = data?.user_id ?? null
  }

  // Log de captura, reduzido agora que a Task 4 interpreta a mensagem.
  // Nunca imprime o token — só se ele veio e se casou.
  console.log('[uazapi/webhook] payload recebido', JSON.stringify({
    matchedAccount: accountId,
    routedBy: accountId ? (token ? 'token' : 'owner') : 'none',
    hasToken: token !== null,
    topLevelKeys: Object.keys(body),
  }))

  if (!accountId || !configOwnerUserId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const parsed = parseUazapiInbound(body)
  if (!parsed) {
    // Evento que não é mensagem (connection), eco nosso, ou grupo.
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  if (parsed.kind === 'message') {
    const t = parsed.message.contentType
    if (t === 'image' || t === 'video' || t === 'audio' || t === 'document') {
      // O arquivo é resolvido sob demanda pela rota de proxy; aqui só
      // gravamos o caminho. Assim uma URL temporária da UAZAPI nunca
      // vaza para o banco nem expira dentro de uma mensagem salva.
      parsed.message.mediaUrl = `/api/whatsapp/uazapi/media/${encodeURIComponent(parsed.message.providerMessageId)}`
    }
  }

  // Processa DEPOIS de responder, como o webhook da Meta faz: em
  // serverless a função pode ser congelada assim que a resposta sai, e
  // uma promise solta perderia as escritas. `after()` mantém viva.
  after(async () => {
    try {
      if (parsed.kind === 'reaction') {
        await processInboundReaction({ accountId, configOwnerUserId, reaction: parsed.reaction })
      } else {
        await processInboundMessage({ accountId, configOwnerUserId, message: parsed.message })
      }
    } catch (error) {
      console.error('[uazapi/webhook] processing failed:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
