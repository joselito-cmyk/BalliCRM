import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Guard de provedor da rota de reações (Meta-only, sem equivalente na v2 da
// UAZAPI).
//
// Trocar uma conta para UAZAPI zera access_token na mesma linha de
// whatsapp_config, então `decrypt(config.access_token)` estourava um TypeError
// cru que o catch da rota devolvia como 500 opaco.
//
// Escopo deliberadamente estreito: o espelhamento em message_reactions
// (insert/delete no emoji vazio) segue sem cobertura própria.
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
      for (const m of ['select', 'eq', 'insert', 'delete', 'upsert']) {
        b[m] = vi.fn(chain)
      }
      const result = () => {
        switch (table) {
          case 'profiles':
            return { data: { account_id: 'acct-1' }, error: null }
          case 'messages':
            return {
              data: {
                id: 'msg-1',
                message_id: 'wamid-target',
                conversation_id: 'cv-1',
              },
              error: null,
            }
          case 'conversations':
            return {
              data: {
                id: 'cv-1',
                account_id: 'acct-1',
                contact: { phone: '+14155550123' },
              },
              error: null,
            }
          case 'whatsapp_config':
            return { data: configRow, error: null }
          default:
            return { data: null, error: null }
        }
      }
      b.single = vi.fn(async () => result())
      b.maybeSingle = vi.fn(async () => result())
      b.then = (resolve: (v: unknown) => unknown) => resolve(result())
      return b
    }),
  }
}

let supabaseMock = makeSupabaseMock()
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

const { sendReactionMessage } = vi.hoisted(() => ({
  sendReactionMessage: vi.fn(async () => ({ messageId: 'wamid-react' })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({ sendReactionMessage }))

const { decrypt } = vi.hoisted(() => ({ decrypt: vi.fn(() => 'plaintext') }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt }))

import { POST } from './route'

function post() {
  return POST(
    new Request('http://localhost/api/whatsapp/react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: 'msg-1', emoji: '👍' }),
    }),
  )
}

beforeEach(() => {
  supabaseMock = makeSupabaseMock()
  sendReactionMessage.mockClear()
  decrypt.mockClear()
})

describe('POST /api/whatsapp/react — provider guard', () => {
  it('responde 400 legível (não 500) quando a conta está em UAZAPI', async () => {
    configRow = { provider: 'uazapi', access_token: null, phone_number_id: null }

    const res = await post()

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/different provider/i)
    expect(decrypt).not.toHaveBeenCalled()
    expect(sendReactionMessage).not.toHaveBeenCalled()
  })

  it('responde igual numa linha meta com access_token null', async () => {
    configRow = { provider: 'meta', access_token: null, phone_number_id: 'PNID-1' }

    const res = await post()

    expect(res.status).toBe(400)
    expect(sendReactionMessage).not.toHaveBeenCalled()
  })

  it('não interfere numa conta meta saudável', async () => {
    configRow = {
      provider: 'meta',
      access_token: 'enc-token',
      phone_number_id: 'PNID-1',
    }

    const res = await post()

    expect(sendReactionMessage).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
  })
})
