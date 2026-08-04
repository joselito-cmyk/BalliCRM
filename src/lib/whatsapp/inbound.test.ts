import { describe, it, expect, vi, beforeEach } from 'vitest'

const inserted: Record<string, unknown[]> = {}
const updated: Record<string, unknown[]> = {}

/**
 * Stub do Supabase que registra o que foi escrito, para as asserções
 * olharem o efeito real (linha inserida) e não a chamada mockada.
 *
 * Estendido além do que o brief mostrava: `findOrCreateConversation`
 * encadeia `.select().eq().eq().order().limit()` (dois `.eq()` antes do
 * `.order()`, não um) e `findOrCreateContact`/`findOrCreateConversation`
 * fazem `.insert(...).select().single()` para ler a linha criada de
 * volta. `leaf()` é recursivo em `.eq()` para cobrir qualquer número de
 * filtros encadeados, e também é "thenable" (tem `.then`) para o caso da
 * contagem de mensagens prévias, que é awaitada direto após dois `.eq()`
 * sem `.order()`/`.maybeSingle()`.
 */
function makeDb(overrides: { priorCustomerCount?: number } = {}) {
  const leaf = (): Record<string, unknown> => {
    const obj: Record<string, unknown> = {
      eq: () => leaf(),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
      in: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
      then: (resolve: (v: unknown) => void) =>
        resolve({ count: overrides.priorCustomerCount ?? 0, data: [], error: null }),
    }
    return obj
  }
  const chain = (table: string) => ({
    select: () => leaf(),
    insert: (row: Record<string, unknown>) => {
      ;(inserted[table] ??= []).push(row)
      const created = { id: `${table}-new-id`, ...row }
      return {
        select: () => ({
          single: () => Promise.resolve({ data: created, error: null }),
        }),
        // Some call sites (e.g. the `messages` insert) await the insert
        // call directly without `.select().single()`.
        then: (resolve: (v: unknown) => void) => resolve({ error: null, data: null }),
      }
    },
    update: (row: unknown) => ({
      eq: () => {
        ;(updated[table] ??= []).push(row)
        return Promise.resolve({ error: null })
      },
    }),
    upsert: (row: unknown) => {
      ;(inserted[table] ??= []).push(row)
      return Promise.resolve({ error: null })
    },
    delete: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
  })
  return { from: (t: string) => chain(t) }
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => makeDb(),
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn().mockResolvedValue({ consumed: false }),
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn().mockResolvedValue({ id: 'contact-1' }),
  isUniqueViolation: () => false,
}))

import { processInboundMessage, type NormalizedInboundMessage } from './inbound'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'

const baseMessage: NormalizedInboundMessage = {
  providerMessageId: 'MSG-1',
  from: '5521984379771',
  contactName: 'Cliente',
  sentAt: new Date('2026-08-04T12:00:00Z'),
  contentType: 'text',
  contentText: 'oi',
  mediaUrl: null,
  interactiveReplyId: null,
  replyToProviderMessageId: null,
  fallbackLabel: 'text',
}

beforeEach(() => {
  for (const k of Object.keys(inserted)) delete inserted[k]
  for (const k of Object.keys(updated)) delete updated[k]
  vi.clearAllMocks()
})

describe('processInboundMessage', () => {
  it('grava a mensagem com o id do provedor e a data informada', async () => {
    await processInboundMessage({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      message: baseMessage,
    })
    const rows = inserted['messages'] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].message_id).toBe('MSG-1')
    expect(rows[0].sender_type).toBe('customer')
    expect(rows[0].content_type).toBe('text')
    expect(rows[0].created_at).toBe('2026-08-04T12:00:00.000Z')
  })

  it('usa fallbackLabel em last_message_text quando não há texto', async () => {
    await processInboundMessage({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      message: { ...baseMessage, contentType: 'image', contentText: null, fallbackLabel: 'image' },
    })
    const conv = (updated['conversations'] as Array<Record<string, unknown>>)[0]
    expect(conv.last_message_text).toBe('[image]')
  })

  it('dispara automações de conteúdo quando nenhum flow consome', async () => {
    await processInboundMessage({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      message: baseMessage,
    })
    const triggers = vi.mocked(runAutomationsForTrigger).mock.calls.map((c) => c[0].triggerType)
    expect(triggers).toContain('new_message_received')
    expect(triggers).toContain('keyword_match')
  })

  it('suprime gatilhos de conteúdo quando um flow consome a mensagem', async () => {
    vi.mocked(dispatchInboundToFlows).mockResolvedValueOnce({ consumed: true })
    await processInboundMessage({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      message: baseMessage,
    })
    const triggers = vi.mocked(runAutomationsForTrigger).mock.calls.map((c) => c[0].triggerType)
    expect(triggers).not.toContain('new_message_received')
    expect(triggers).not.toContain('keyword_match')
  })

  it('não chama a IA quando um flow consumiu', async () => {
    vi.mocked(dispatchInboundToFlows).mockResolvedValueOnce({ consumed: true })
    await processInboundMessage({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      message: baseMessage,
    })
    expect(dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('não chama a IA em resposta interativa', async () => {
    await processInboundMessage({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      message: { ...baseMessage, contentType: 'interactive', interactiveReplyId: 'opt-a' },
    })
    expect(dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('persiste interactive_reply_id quando é toque em botão', async () => {
    await processInboundMessage({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      message: { ...baseMessage, contentType: 'interactive', contentText: 'Sim', interactiveReplyId: 'opt-a' },
    })
    const rows = inserted['messages'] as Array<Record<string, unknown>>
    expect(rows[0].interactive_reply_id).toBe('opt-a')
  })
})
