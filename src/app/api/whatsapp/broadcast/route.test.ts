import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Guard de provedor da rota de broadcast da UI.
//
// Esta é a rota que a tela de Broadcasts do CRM chama de fato — o
// broadcast-core.ts já coberto atende só a API pública /api/v1/broadcasts.
// Trocar uma conta para UAZAPI reaproveita a linha de whatsapp_config e zera
// todas as colunas da Meta, então `decrypt(config.access_token)` estourava um
// TypeError cru que o catch da rota transformava num 500 opaco
// ("Failed to process broadcast"), sem dizer ao usuário o que fazer.
//
// Escopo deliberadamente estreito: o resto da rota (fan-out, retry de
// variantes de telefone, shape legado) segue sem cobertura própria e está
// fora deste fix.
// ---------------------------------------------------------------------------

let configRow: Record<string, unknown> = {}

function makeSupabaseMock() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: `user-${Math.random()}` } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['select', 'eq']) b[m] = vi.fn(chain)
      const result = () => {
        switch (table) {
          case 'profiles':
            return { data: { account_id: 'acct-1' }, error: null }
          case 'whatsapp_config':
            return { data: configRow, error: null }
          default:
            return { data: null, error: null }
        }
      }
      b.single = vi.fn(async () => result())
      b.maybeSingle = vi.fn(async () => result())
      return b
    }),
  }
}

let supabaseMock = makeSupabaseMock()
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

const { sendTemplateMessage } = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid-1' })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTemplateMessage }))

const { decrypt } = vi.hoisted(() => ({ decrypt: vi.fn(() => 'plaintext') }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt }))

import { POST } from './route'

function post() {
  return POST(
    new Request('http://localhost/api/whatsapp/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipients: [{ phone: '+14155550123', params: [] }],
        template_name: 'order_update',
        template_language: 'en_US',
      }),
    }),
  )
}

beforeEach(() => {
  supabaseMock = makeSupabaseMock()
  sendTemplateMessage.mockClear()
  decrypt.mockClear()
})

describe('POST /api/whatsapp/broadcast — provider guard', () => {
  it('responde 400 legível (não 500) quando a conta está em UAZAPI', async () => {
    configRow = {
      id: 'cfg-1',
      provider: 'uazapi',
      access_token: null,
      phone_number_id: null,
      uazapi_instance_token: 'enc-instance-token',
    }

    const res = await post()

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/different provider/i)
    // Nem decripta nem chega a disparar envio para a Meta.
    expect(decrypt).not.toHaveBeenCalled()
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('responde igual numa linha meta com access_token null', async () => {
    configRow = {
      id: 'cfg-1',
      provider: 'meta',
      access_token: null,
      phone_number_id: 'PNID-1',
    }

    const res = await post()

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/different provider/i)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('não interfere numa conta meta saudável', async () => {
    configRow = {
      id: 'cfg-1',
      provider: 'meta',
      access_token: 'enc-token',
      phone_number_id: 'PNID-1',
    }

    const res = await post()

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, sent: 1, failed: 0 })
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
  })
})
