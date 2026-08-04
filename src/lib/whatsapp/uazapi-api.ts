/**
 * UAZAPI (WhatsApp não oficial) — client HTTP da API v2 (uazapiGO).
 *
 * Contratos verificados ao vivo contra balligroup.uazapi.com em
 * 2026-08-04; ver o apêndice de
 * docs/superpowers/specs/2026-08-03-uazapi-provider-design.md. Onde a
 * documentação pública da UAZAPI divergir, vale o apêndice — ela já
 * errou em cinco pontos.
 *
 * Autenticação: header `token` (o Instance Token). O `admintoken`, que
 * controla a assinatura inteira, NÃO é usado aqui: o app não cria nem
 * apaga instâncias — isso é feito no painel da UAZAPI.
 *
 * Client puro: nenhum acesso a banco, nenhuma decisão de negócio.
 */

import type { MediaKind } from './meta-api'

export type { MediaKind }

const UAZAPI_ENDPOINT = process.env.UAZAPI_ENDPOINT!

// ============================================================
// Tipos
// ============================================================

/**
 * O objeto `instance` que vem em /instance/status e /instance/connect.
 *
 * Só os campos que usamos são tipados — a UAZAPI devolve dezenas
 * (chatbot nativo, proxy, adminFields) que não nos interessam.
 *
 * Os campos marcados "só quando conectado" chegam vazios ou ausentes
 * enquanto a instância está disconnected/connecting: o objeto muda de
 * forma entre os estados.
 */
export interface UazapiInstance {
  id: string
  status: string
  /** Data URI completo (`data:image/png;base64,…`) enquanto connecting; '' fora disso. */
  qrcode: string
  /** Rótulo definido no painel na criação. */
  name: string
  /** Só quando conectado: número da instância, apenas dígitos. */
  owner: string
  profileName: string
  profilePicUrl: string
  isBusiness: boolean
  lastDisconnect: string
  lastDisconnectReason: string
  msg_delay_min: number
  msg_delay_max: number
}

export interface UazapiConnectionStatus {
  connected: boolean
  loggedIn: boolean
  jid: string | null
  /** Ausente na resposta do /instance/connect; presente no /instance/status. */
  resetting?: boolean
}

export interface UazapiInstanceState {
  instance: UazapiInstance
  status: UazapiConnectionStatus
}

export interface UazapiSendResult {
  messageId: string
}

// ============================================================
// Infra
// ============================================================

interface UazapiErrorBody {
  message?: string
  error?: string
  response?: string
}

/**
 * A UAZAPI não documenta o corpo de erro. Observado ao vivo:
 * `Invalid AdminToken Header` como texto puro em alguns casos, JSON em
 * outros. Tentamos os três campos que ela usa e caímos no status code.
 *
 * Nunca inclui o token na mensagem: ela sobe até a UI.
 */
async function throwUazapiError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as UazapiErrorBody
    const found = data.message ?? data.error ?? data.response
    if (typeof found === 'string' && found.length > 0) message = found
  } catch {
    // corpo não era JSON — mantém o fallback
  }
  throw new Error(message)
}

async function uazapiFetch(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const method = init.method ?? 'GET'
  const response = await fetch(`${UAZAPI_ENDPOINT}${path}`, {
    method,
    headers: { 'content-type': 'application/json', token },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  return response.json()
}

/**
 * Parser único para /instance/status e /instance/connect, que
 * compartilham a forma `{ instance, status }`.
 *
 * Lê SEMPRE o objeto `status` aninhado. O /connect também expõe
 * `connected`/`loggedIn` na raiz, mas o /status não — usar os campos
 * de topo daria `undefined` silencioso num dos dois caminhos.
 */
function parseInstanceState(data: unknown, context: string): UazapiInstanceState {
  const d = data as { instance?: Record<string, unknown>; status?: Record<string, unknown> }
  if (!d?.instance || typeof d.instance !== 'object' || !d.status || typeof d.status !== 'object') {
    throw new Error(`UAZAPI returned an unexpected response shape for ${context}.`)
  }
  const i = d.instance
  const s = d.status

  if (typeof s.connected !== 'boolean' || typeof s.loggedIn !== 'boolean') {
    throw new Error(`UAZAPI returned an unexpected response shape for ${context}.`)
  }

  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

  return {
    instance: {
      id: str(i.id),
      status: str(i.status),
      qrcode: str(i.qrcode),
      name: str(i.name),
      owner: str(i.owner),
      profileName: str(i.profileName),
      profilePicUrl: str(i.profilePicUrl),
      isBusiness: i.isBusiness === true,
      lastDisconnect: str(i.lastDisconnect),
      lastDisconnectReason: str(i.lastDisconnectReason),
      msg_delay_min: num(i.msg_delay_min),
      msg_delay_max: num(i.msg_delay_max),
    },
    status: {
      connected: s.connected,
      loggedIn: s.loggedIn,
      jid: typeof s.jid === 'string' ? s.jid : null,
      ...(typeof s.resetting === 'boolean' ? { resetting: s.resetting } : {}),
    },
  }
}

// ============================================================
// Ciclo de vida da instância
// ============================================================

export interface InstanceTokenArgs {
  /** Instance Token cru (já decifrado). */
  token: string
}

/**
 * Estado atual da instância — inclui o QR vigente quando connecting.
 *
 * É também o endpoint de validação: um token inválido responde 401, o
 * que torna esta a chamada certa para conferir um token colado antes
 * de gravá-lo.
 */
export async function getInstanceStatus(args: InstanceTokenArgs): Promise<UazapiInstanceState> {
  const data = await uazapiFetch('/instance/status', args.token)
  return parseInstanceState(data, 'getInstanceStatus')
}

/**
 * Inicia a conexão: status vai para "connecting" e o primeiro QR é
 * gerado.
 *
 * Chamado UMA vez por tentativa. Não existe "renovar QR" — a UAZAPI
 * rotaciona sozinha e o /instance/status entrega o vigente (medido:
 * o QR mudou entre duas leituras separadas por 22s, sem chamada
 * nossa). A janela expira sozinha depois de alguns minutos, voltando a
 * "disconnected" com lastDisconnectReason "QR Code timeout".
 */
export async function connectInstance(args: InstanceTokenArgs): Promise<UazapiInstanceState> {
  const data = await uazapiFetch('/instance/connect', args.token, { method: 'POST', body: {} })
  return parseInstanceState(data, 'connectInstance')
}

/**
 * Desloga o telefone mantendo a instância viva (dá para reconectar
 * lendo um QR novo).
 *
 * Deliberadamente NÃO existe um deleteInstance() aqui: DELETE
 * /instance apagaria a instância e liberaria a única vaga da
 * assinatura. Isso é operação de painel, não de aplicação.
 */
export async function disconnectInstance(args: InstanceTokenArgs): Promise<void> {
  await uazapiFetch('/instance/disconnect', args.token, { method: 'POST', body: {} })
}

// ============================================================
// Envio (usado a partir da Fase 3)
// ============================================================

/**
 * A UAZAPI não documenta o corpo de sucesso do /send/*, e ele não foi
 * verificado ao vivo (exigiria enviar uma mensagem real). Aceitamos os
 * dois nomes plausíveis; a Fase 3 confirma e simplifica.
 */
function parseSendResult(data: unknown): UazapiSendResult {
  const d = data as { messageid?: unknown; messageId?: unknown; id?: unknown }
  const id = d?.messageid ?? d?.messageId ?? d?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('UAZAPI accepted the send but returned no message id.')
  }
  return { messageId: id }
}

export interface UazapiSendTextArgs extends InstanceTokenArgs {
  /** Só dígitos, com código do país. Ex: '5521984379771'. */
  number: string
  text: string
}

export async function sendText(args: UazapiSendTextArgs): Promise<UazapiSendResult> {
  const { token, number, text } = args
  const data = await uazapiFetch('/send/text', token, { method: 'POST', body: { number, text } })
  return parseSendResult(data)
}

/**
 * Na v2 os quatro tipos de mídia passam por um endpoint só; o campo
 * `type` discrimina. `file` aceita URL pública — que é exatamente o
 * que já guardamos no Supabase Storage — ou base64.
 */
const MEDIA_TYPE: Record<MediaKind, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
}

export interface UazapiSendMediaArgs extends InstanceTokenArgs {
  number: string
  kind: MediaKind
  /** URL pública que a UAZAPI busca na hora do envio. */
  path: string
  caption?: string
}

export async function sendMedia(args: UazapiSendMediaArgs): Promise<UazapiSendResult> {
  const { token, number, kind, path, caption } = args
  if (!path) throw new Error('sendMedia requires a path.')
  const body: Record<string, unknown> = { number, type: MEDIA_TYPE[kind], file: path }
  if (caption) body.text = caption
  const data = await uazapiFetch('/send/media', token, { method: 'POST', body })
  return parseSendResult(data)
}
