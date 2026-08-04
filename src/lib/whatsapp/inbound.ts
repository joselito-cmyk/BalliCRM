/**
 * Pipeline de entrada de mensagens, provedor-agnóstico.
 *
 * Extraído de src/app/api/whatsapp/webhook/route.ts, onde vivia acoplado
 * ao formato de payload da Meta. O que era específico da Meta (verificar
 * assinatura, ler `entry[].changes[].value`, baixar mídia pelo Graph API)
 * fica na rota; o que é comum a qualquer provedor mora aqui.
 *
 * A fronteira é o `NormalizedInboundMessage`: cada provedor traduz o seu
 * payload para essa forma e entrega. Nada aqui sabe se veio da Meta ou da
 * UAZAPI.
 */

import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from './phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

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
 * Valores aceitos pela CHECK constraint de `messages.content_type`
 * (001_initial_schema.sql, alargada na 010 para incluir 'interactive').
 * Um valor fora desta lista faz o INSERT falhar.
 */
export type InboundContentType =
  | 'text' | 'image' | 'document' | 'audio'
  | 'video' | 'location' | 'template' | 'interactive'

/**
 * Uma mensagem recebida, já traduzida do formato do provedor.
 *
 * Regra para quem escreve um parser novo: TODOS os campos são
 * responsabilidade do parser. O pipeline não adivinha nada — se
 * `contentText` vier null e `mediaUrl` também, a mensagem entra vazia.
 */
export interface NormalizedInboundMessage {
  /** Id da mensagem no provedor (wamid da Meta, messageid da UAZAPI). */
  providerMessageId: string
  /** Telefone de quem enviou, só dígitos com código do país. */
  from: string
  /** Nome de exibição informado pelo provedor; '' quando desconhecido. */
  contactName: string
  /** Quando o provedor diz que foi enviada. */
  sentAt: Date
  contentType: InboundContentType
  contentText: string | null
  /** URL servida pelo NOSSO app (rota de proxy), nunca a do provedor. */
  mediaUrl: string | null
  /** Id da opção tocada num botão/lista; null fora disso. */
  interactiveReplyId: string | null
  /** Id (no provedor) da mensagem citada numa resposta; null fora disso. */
  replyToProviderMessageId: string | null
  /** Rótulo usado em `last_message_text` quando não há texto. Ex.: 'image'. */
  fallbackLabel: string
}

/** Reação não é mensagem: vira estado em `message_reactions`. */
export interface NormalizedInboundReaction {
  from: string
  contactName: string
  /** Id (no provedor) da mensagem reagida. */
  targetProviderMessageId: string
  /** String vazia significa remoção da reação. */
  emoji: string
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByProviderId(
  providerId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', providerId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[inbound] lookupInternalIdByProviderId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone,
  )

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — Meta retries a delivery, or a
  // batch fans out to concurrent runs), every subsequent inbound
  // message errored on the lookup and created yet another conversation,
  // snowballing into a wall of duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036) keeps, so any
  // pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

export interface ProcessReactionArgs {
  accountId: string
  configOwnerUserId: string
  reaction: NormalizedInboundReaction
}

/**
 * Persiste uma reação recebida. Reações não são mensagens — são estado
 * por (alvo, autor). Fazemos upsert/delete em `message_reactions` e
 * nunca inserimos em `messages`.
 *
 * Best-effort: alvo ausente (nunca recebemos a mensagem original) é
 * logado e ignorado, para o webhook ainda responder 200 ao provedor.
 */
export async function processInboundReaction(args: ProcessReactionArgs): Promise<void> {
  const { accountId, configOwnerUserId, reaction } = args

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    normalizePhone(reaction.from),
    reaction.contactName
  )
  if (!contactOutcome) return

  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactOutcome.contact.id
  )
  if (!convResult) return
  const conversationId = convResult.conversation.id

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversationId,
      contact_id: contactOutcome.contact.id,
    })
  }

  const targetInternalId = await lookupInternalIdByProviderId(
    reaction.targetProviderMessageId,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[inbound] reaction target message not found; skipping',
      reaction.targetProviderMessageId
    )
    return
  }

  // Emoji vazio = remoção (spec da Cloud API da Meta; a UAZAPI usa a
  // mesma convenção no campo de reação).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactOutcome.contact.id)
    if (delError) {
      console.error('[inbound] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactOutcome.contact.id,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[inbound] reaction upsert failed:', upsertError.message)
  }
}

export interface ProcessInboundArgs {
  /** Tenancy: toda linha criada abaixo é carimbada com esta conta. */
  accountId: string
  /**
   * Sender-of-record para os INSERTs que exigem user_id NOT NULL
   * (contacts, conversations). Sempre o admin que salvou a config do
   * WhatsApp; a escolha é arbitrária pós-017 mas estável.
   */
  configOwnerUserId: string
  message: NormalizedInboundMessage
}

export async function processInboundMessage(args: ProcessInboundArgs): Promise<void> {
  const { accountId, configOwnerUserId, message } = args
  const senderPhone = normalizePhone(message.from)

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    message.contactName
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  // Emite conversation.created assim que a thread abre, para um
  // assinante sempre ver a thread aberta antes da primeira
  // message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Resposta com citação: pai ausente é aceitável — guardamos NULL e a
  // UI renderiza sem a citação.
  let replyToInternalId: string | null = null
  if (message.replyToProviderMessageId) {
    replyToInternalId = await lookupInternalIdByProviderId(
      message.replyToProviderMessageId,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[inbound] reply context parent not found:',
        message.replyToProviderMessageId
      )
    }
  }

  // Descobrir se é a primeira mensagem do contato ANTES do insert, para
  // a contagem ser exata. Cobre o caso de contato já existente (import
  // manual / CSV) que nunca mandou mensagem.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: message.contentType,
    content_text: message.contentText,
    media_url: message.mediaUrl,
    message_id: message.providerMessageId,
    status: 'delivered',
    created_at: message.sentAt.toISOString(),
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: message.interactiveReplyId,
  })

  if (msgError) {
    console.error('[inbound] Error inserting message:', msgError)
    return
  }

  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: message.contentText || `[${message.fallbackLabel}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('[inbound] Error updating conversation:', convError)
  }

  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // Flows: se o runner consumiu a mensagem (avançou ou iniciou um run),
  // suprimimos os gatilhos de conteúdo — o cliente está navegando o menu
  // do bot, não mandando palavra-chave nova. Gatilhos de relacionamento
  // (new_contact_created, first_inbound_message) disparam mesmo assim:
  // são sobre QUEM mandou, não sobre o que foi dito.
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: message.interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: message.interactiveReplyId,
          reply_title: message.contentText ?? '',
          meta_message_id: message.providerMessageId,
        }
      : {
          kind: 'text',
          text: message.contentText ?? '',
          meta_message_id: message.providerMessageId,
        },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = message.contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (message.interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: message.interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // Resposta por IA: só para texto puro que o runner determinístico NÃO
  // consumiu (flows ganham do LLM) e só quando a conta habilitou.
  if (!flowConsumed && !message.interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.providerMessageId,
    content_type: message.contentType,
    text: message.contentText,
  })
}
