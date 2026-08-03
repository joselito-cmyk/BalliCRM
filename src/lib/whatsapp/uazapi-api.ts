/**
 * UAZAPI (unofficial WhatsApp API) helpers — QR-code session client.
 *
 * Named-params objects, mirroring meta-api.ts, for the same reason: a
 * typo in positional args surfaces as a silent wrong-argument bug
 * instead of a TypeScript error.
 *
 * Auth model (confirmed against the UAZAPI Postman collection):
 * `apitoken` — the paid subscription's account-level token — is
 * required ONLY on /start, to prove the caller owns the subscription
 * when creating a session. Every other endpoint authenticates with
 * just the per-session `sessionkey` header. There is no request
 * signing; `sessionkey` carries the same trust level as a bearer
 * token for everything after /start.
 */

import type { MediaKind } from './meta-api'

export type { MediaKind }

const UAZAPI_ENDPOINT = process.env.UAZAPI_ENDPOINT!
const UAZAPI_TOKEN = process.env.UAZAPI_TOKEN!

export interface UazapiSendResult {
  messageId: string
}

interface UazapiErrorBody {
  message?: string
  error?: string
}

/**
 * The Postman collection documents the HTTP status codes UAZAPI uses
 * (400/401/404/500) but never shows an error response body. This
 * checks the field names an Express JSON-error middleware commonly
 * uses and falls back to the status code, so a real error still
 * surfaces something useful even if the exact shape turns out to
 * differ once tested against a live session.
 */
async function throwUazapiError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as UazapiErrorBody
    if (typeof data.message === 'string') message = data.message
    else if (typeof data.error === 'string') message = data.error
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

// ============================================================
// Session lifecycle
// ============================================================

export interface UazapiWebhooks {
  connect: string
  qrcode: string
  status: string
  message: string
}

export interface StartSessionArgs {
  /** Our own generated session id — never user input. */
  session: string
  sessionkey: string
  webhooks: UazapiWebhooks
}

export interface StartSessionResult {
  state: string
  status: string
}

/**
 * Starts a session, triggering QR-code generation on UAZAPI's side.
 * Idempotent in practice: calling /start again on an existing session
 * is how UAZAPI issues a fresh QR code after the previous one expired.
 */
export async function startSession(args: StartSessionArgs): Promise<StartSessionResult> {
  const { session, sessionkey, webhooks } = args
  const response = await fetch(`${UAZAPI_ENDPOINT}/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apitoken: UAZAPI_TOKEN,
      sessionkey,
    },
    body: JSON.stringify({
      session,
      wh_connect: webhooks.connect,
      wh_qrcode: webhooks.qrcode,
      wh_status: webhooks.status,
      wh_message: webhooks.message,
    }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  const data = await response.json()
  return { state: data.state, status: data.status }
}

export interface GetQrCodeArgs {
  session: string
  sessionkey: string
}

export interface QrCodeResult {
  /** Ready for an <img src="..."> — see re-encoding note below. */
  dataUri: string
}

/**
 * Fetches the current QR code and re-encodes it as a data URI.
 *
 * Unlike the `wh_qrcode` webhook push (already a `data:image/...`
 * string per the docs' payload example), this endpoint returns the
 * raw image bytes — confirmed by the collection's own description:
 * "Obtém o QR Code (png em bytes) da sessão inicializada." Note
 * `sessionkey` here is a query param, not a header — this is the one
 * UAZAPI endpoint that departs from the header convention every other
 * endpoint uses.
 */
export async function getQrCode(args: GetQrCodeArgs): Promise<QrCodeResult> {
  const { session, sessionkey } = args
  const url = `${UAZAPI_ENDPOINT}/getQrCode?session=${encodeURIComponent(session)}&sessionkey=${encodeURIComponent(sessionkey)}`
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  const bytes = await response.arrayBuffer()
  const base64 = Buffer.from(bytes).toString('base64')
  return { dataUri: `data:image/png;base64,${base64}` }
}

export interface GetSessionStatusArgs {
  session: string
  sessionkey: string
}

export interface SessionStatusResult {
  /** Raw UAZAPI status string (e.g. "notLogged", "inChat", "disconnectedMobile"). Persisted verbatim — see design doc. */
  status: string
  state: string
}

export async function getSessionStatus(args: GetSessionStatusArgs): Promise<SessionStatusResult> {
  const { session, sessionkey } = args
  const response = await fetch(`${UAZAPI_ENDPOINT}/getSessionStatus`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', sessionkey },
    body: JSON.stringify({ session }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  const data = await response.json()
  return { status: data.status, state: data.state }
}

export interface CloseSessionArgs {
  session: string
  sessionkey: string
}

/** Disconnects WhatsApp from the session without deleting the session server-side. */
export async function closeSession(args: CloseSessionArgs): Promise<void> {
  const { session, sessionkey } = args
  const response = await fetch(`${UAZAPI_ENDPOINT}/closeSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', sessionkey },
    body: JSON.stringify({ session }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
}

// ============================================================
// Sending
// ============================================================

export interface UazapiSendTextArgs {
  session: string
  sessionkey: string
  /** Recipient in any UAZAPI-accepted format (with/without +, with/without the trunk 9). */
  number: string
  text: string
}

export async function sendText(args: UazapiSendTextArgs): Promise<UazapiSendResult> {
  const { session, sessionkey, number, text } = args
  const response = await fetch(`${UAZAPI_ENDPOINT}/sendText`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', sessionkey },
    body: JSON.stringify({ session, number, text }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messageId }
}

const MEDIA_ENDPOINT: Record<MediaKind, string> = {
  image: 'sendImage',
  video: 'sendVideo',
  audio: 'sendAudio',
  document: 'sendFile',
}

export interface UazapiSendMediaArgs {
  session: string
  sessionkey: string
  number: string
  kind: MediaKind
  /** Public URL UAZAPI fetches at send time. */
  path: string
  caption?: string
}

/**
 * Sends image, video, audio, or document via a public URL. All four
 * UAZAPI media endpoints share the exact same body shape
 * ({session, number, caption, path}) — only the path segment differs
 * by kind (see MEDIA_ENDPOINT).
 */
export async function sendMedia(args: UazapiSendMediaArgs): Promise<UazapiSendResult> {
  const { session, sessionkey, number, kind, path, caption } = args
  if (!path) throw new Error('sendMedia requires a path.')
  const body: Record<string, unknown> = { session, number, path }
  if (caption) body.caption = caption
  const response = await fetch(`${UAZAPI_ENDPOINT}/${MEDIA_ENDPOINT[kind]}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', sessionkey },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messageId }
}
