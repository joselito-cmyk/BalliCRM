import { describe, it, expect, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Guard de provedor do sender do motor de automações. Mesmo motivo do teste
// irmão em src/lib/flows/meta-send.test.ts: depois de uma troca para UAZAPI a
// linha de whatsapp_config fica com access_token null e o decrypt() estourava
// um TypeError cru.
//
// Escopo estreito de propósito — o resto de meta-send.ts continua sem
// cobertura própria e isso está fora deste fix.
// ---------------------------------------------------------------------------

let configRow: Record<string, unknown> = {}

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['select', 'eq', 'insert', 'update']) b[m] = vi.fn(chain)
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
  sendTemplateMessage: vi.fn(),
}))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
}))

import { encrypt } from '@/lib/whatsapp/encryption'
import { engineSendText, engineSendTemplate } from './meta-send'

const args = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'cv-1',
  contactId: 'ct-1',
  text: 'oi',
}

describe('automations engineSendText — provider guard', () => {
  // A conta UAZAPI sem instance_token configurado ainda precisa recusar com
  // mensagem legível (não o TypeError cru que `decrypt(null)` geraria) — a
  // rota de sucesso (instance_token presente) passa a rotear de verdade
  // desde esta task, coberta pelo teste "roteia texto…" abaixo.
  it('falha com mensagem legível (não TypeError) quando a conta está em UAZAPI sem instance token', async () => {
    configRow = {
      id: 'cfg-1',
      provider: 'uazapi',
      access_token: null,
      uazapi_instance_token: null,
    }
    await expect(engineSendText(args)).rejects.toThrow(/UAZAPI instance not configured/i)
    await engineSendText(args).catch((e: unknown) => {
      expect(e).toBeInstanceOf(Error)
      expect(e).not.toBeInstanceOf(TypeError)
    })
    expect(sendTextMessage).not.toHaveBeenCalled()
  })

  it('falha com mensagem legível (não TypeError) numa linha meta com access_token null', async () => {
    configRow = { id: 'cfg-1', provider: 'meta', access_token: null }
    await expect(engineSendText(args)).rejects.toThrow(/WhatsApp not configured/i)
    await engineSendText(args).catch((e: unknown) => {
      expect(e).toBeInstanceOf(Error)
      expect(e).not.toBeInstanceOf(TypeError)
    })
  })

  it('roteia texto para UAZAPI quando a conta usa esse provedor', async () => {
    configRow = {
      id: 'cfg-1',
      provider: 'uazapi',
      access_token: null,
      uazapi_instance_token: encrypt('tok-instancia'),
    }
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 200, json: async () => ({ messageid: 'UAZ-1' }) }
    }))
    await engineSendText(args)
    expect(calls[0].url).toContain('/send/text')
  })

  it('recusa template pelo UAZAPI mesmo com instance token', async () => {
    configRow = {
      id: 'cfg-1',
      provider: 'uazapi',
      access_token: null,
      uazapi_instance_token: encrypt('tok-instancia'),
    }
    await expect(
      engineSendTemplate({ ...args, templateName: 'oi_cliente' })
    ).rejects.toThrow(/only available.*Meta/i)
  })
})
