import { describe, it, expect, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Cobertura das duas funções puras de normalização Meta que route.ts carrega:
// metaContentType (mapeamento sticker->image e desconhecido->text, para não
// estourar a CHECK de messages.content_type) e normalizeMetaMessage (inclui
// a matemática do timestamp: segundos Unix da Meta -> Date).
//
// Tudo o que route.ts importa e tem efeito colateral em módulo é mockado
// abaixo só para permitir o import; nenhum desses mocks é exercitado pelos
// testes, que chamam apenas as duas funções puras exportadas.
// ---------------------------------------------------------------------------

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({}),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  isLegacyFormat: vi.fn(),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}))
vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: vi.fn(),
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn(),
}))
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  handleTemplateWebhookChange: vi.fn(),
  isTemplateWebhookField: vi.fn(),
}))
vi.mock('@/lib/whatsapp/inbound', () => ({
  processInboundMessage: vi.fn(),
  processInboundReaction: vi.fn(),
}))

import { metaContentType, normalizeMetaMessage } from './route'

describe('metaContentType', () => {
  it('mapeia sticker para image', () => {
    expect(metaContentType('sticker')).toBe('image')
  })

  it('mapeia um tipo desconhecido para text (protege a CHECK constraint)', () => {
    expect(metaContentType('unknown_future_type')).toBe('text')
  })

  it('mantém um tipo reconhecido inalterado', () => {
    expect(metaContentType('video')).toBe('video')
  })

  it('mantém text inalterado', () => {
    expect(metaContentType('text')).toBe('text')
  })
})

describe('normalizeMetaMessage', () => {
  it('converte o timestamp em segundos Unix para o Date correto', async () => {
    const result = await normalizeMetaMessage(
      {
        id: 'wamid-1',
        from: '5511999999999',
        // 1000000000 (segundos) = 2001-09-09T01:46:40.000Z
        timestamp: '1000000000',
        type: 'text',
        text: { body: 'hi' },
      },
      { profile: { name: 'Test' }, wa_id: '5511999999999' },
      'token'
    )

    expect(result.sentAt.toISOString()).toBe('2001-09-09T01:46:40.000Z')
    expect(result.providerMessageId).toBe('wamid-1')
    expect(result.contentType).toBe('text')
    expect(result.contentText).toBe('hi')
    expect(result.fallbackLabel).toBe('text')
  })

  it('mapeia sticker para image na mensagem normalizada', async () => {
    const result = await normalizeMetaMessage(
      {
        id: 'wamid-2',
        from: '5511999999999',
        timestamp: '1000000000',
        type: 'sticker',
        // sem `.id` — pula a verificação de mídia, que não é o foco deste teste.
      },
      { profile: { name: 'Test' }, wa_id: '5511999999999' },
      'token'
    )

    expect(result.contentType).toBe('image')
    expect(result.fallbackLabel).toBe('sticker')
  })

  it('mapeia um tipo desconhecido para text na mensagem normalizada', async () => {
    const result = await normalizeMetaMessage(
      {
        id: 'wamid-3',
        from: '5511999999999',
        timestamp: '1000000000',
        type: 'unknown_future_type',
      },
      { profile: { name: 'Test' }, wa_id: '5511999999999' },
      'token'
    )

    expect(result.contentType).toBe('text')
  })
})
