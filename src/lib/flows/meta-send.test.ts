import { describe, it, expect, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Guard de provedor dos senders do runner de Flows.
//
// Trocar uma conta para UAZAPI reaproveita a linha de whatsapp_config e zera
// todas as colunas da Meta. Sem o guard, `decrypt(config.access_token)` logo
// abaixo estourava um TypeError cru ("Cannot read properties of null"), que o
// runner registrava como falha sem causa legível.
//
// Escopo deliberadamente estreito: o resto de meta-send.ts (retry de variantes
// de telefone, persistência da mensagem) segue sem cobertura própria e está
// fora deste fix.
// ---------------------------------------------------------------------------

let configRow: Record<string, unknown> = {}

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['select', 'eq']) b[m] = vi.fn(chain)
      b.maybeSingle = vi.fn(async () =>
        table === 'contacts'
          ? { data: { id: 'ct-1', phone: '+14155550123' }, error: null }
          : { data: null, error: null },
      )
      b.single = vi.fn(async () => ({ data: configRow, error: null }))
      return b
    },
  }),
}))

const { sendTextMessage } = vi.hoisted(() => ({
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid-1' })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage,
  sendMediaMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
}))

import { engineSendText } from './meta-send'

const args = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'cv-1',
  contactId: 'ct-1',
  text: 'oi',
}

describe('flows engineSendText — provider guard', () => {
  it('falha com mensagem legível (não TypeError) quando a conta está em UAZAPI', async () => {
    configRow = {
      id: 'cfg-1',
      provider: 'uazapi',
      access_token: null,
      uazapi_instance_token: 'enc-instance-token',
    }
    await expect(engineSendText(args)).rejects.toThrow(/different provider/i)
    await engineSendText(args).catch((e: unknown) => {
      expect(e).toBeInstanceOf(Error)
      expect(e).not.toBeInstanceOf(TypeError)
    })
    expect(sendTextMessage).not.toHaveBeenCalled()
  })

  it('falha igual numa linha meta com access_token null', async () => {
    configRow = { id: 'cfg-1', provider: 'meta', access_token: null }
    await expect(engineSendText(args)).rejects.toThrow(/different provider/i)
  })
})
