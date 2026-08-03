/**
 * Provider routing layer — the one place that decides "Meta or
 * UAZAPI?" for outbound text and media. Everything else (the manual
 * send route, automations, flows) calls through here instead of
 * importing meta-api.ts / uazapi-api.ts directly, so none of them
 * need to know which encrypted field belongs to which provider.
 *
 * Scope: text + media only, matching the v1 scope in the design doc.
 * Templates, interactive messages, broadcast, and reactions stay
 * Meta-only and keep calling meta-api.ts directly — with a provider
 * guard added at each call site in Fase 3.
 */

import type { WhatsAppConfig } from '@/types'
import {
  sendTextMessage as metaSendTextMessage,
  sendMediaMessage as metaSendMediaMessage,
  type MediaKind,
} from './meta-api'
import { sendText as uazapiSendText, sendMedia as uazapiSendMedia } from './uazapi-api'
import { decrypt } from './encryption'

export type { MediaKind }

export interface ProviderSendResult {
  messageId: string
}

export interface ProviderSendTextArgs {
  to: string
  text: string
  /** Meta-only: quotes a prior message so WhatsApp renders a reply preview. Ignored for UAZAPI (no v1 equivalent). */
  contextMessageId?: string
}

export async function sendText(
  config: WhatsAppConfig,
  args: ProviderSendTextArgs,
): Promise<ProviderSendResult> {
  const { to, text, contextMessageId } = args

  if (config.provider === 'uazapi') {
    if (!config.uazapi_session || !config.uazapi_session_key) {
      throw new Error('UAZAPI session not configured for this account.')
    }
    const result = await uazapiSendText({
      session: config.uazapi_session,
      sessionkey: decrypt(config.uazapi_session_key),
      number: to,
      text,
    })
    return { messageId: result.messageId }
  }

  if (!config.phone_number_id || !config.access_token) {
    throw new Error('Meta WhatsApp not configured for this account.')
  }
  const result = await metaSendTextMessage({
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
    to,
    text,
    contextMessageId,
  })
  return { messageId: result.messageId }
}

export interface ProviderSendMediaArgs {
  to: string
  kind: MediaKind
  link: string
  caption?: string
  /** Meta-only (document filename). Ignored for UAZAPI, which has no equivalent field. */
  filename?: string
  contextMessageId?: string
}

export async function sendMedia(
  config: WhatsAppConfig,
  args: ProviderSendMediaArgs,
): Promise<ProviderSendResult> {
  const { to, kind, link, caption, filename, contextMessageId } = args

  if (config.provider === 'uazapi') {
    if (!config.uazapi_session || !config.uazapi_session_key) {
      throw new Error('UAZAPI session not configured for this account.')
    }
    const result = await uazapiSendMedia({
      session: config.uazapi_session,
      sessionkey: decrypt(config.uazapi_session_key),
      number: to,
      kind,
      path: link,
      caption,
    })
    return { messageId: result.messageId }
  }

  if (!config.phone_number_id || !config.access_token) {
    throw new Error('Meta WhatsApp not configured for this account.')
  }
  const result = await metaSendMediaMessage({
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
    to,
    kind,
    link,
    caption,
    filename,
    contextMessageId,
  })
  return { messageId: result.messageId }
}
