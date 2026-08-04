import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Guard de provedor do download de mídia (Graph API da Meta).
//
// Trocar uma conta para UAZAPI zera access_token na mesma linha de
// whatsapp_config, então `decrypt(config.access_token)` estourava um TypeError
// cru que o catch da rota devolvia como 500 "Failed to fetch media".
//
// Escopo deliberadamente estreito: o caminho feliz de download (getMediaUrl +
// downloadMedia, headers de cache) segue sem cobertura própria.
// ---------------------------------------------------------------------------

let configRow: Record<string, unknown> = {}

function makeSupabaseMock() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['select', 'eq']) b[m] = vi.fn(chain)
      const result = () =>
        table === 'profiles'
          ? { data: { account_id: 'acct-1' }, error: null }
          : { data: configRow, error: null }
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

const { getMediaUrl, downloadMedia } = vi.hoisted(() => ({
  getMediaUrl: vi.fn(async () => ({
    url: 'https://lookaside.fb/media',
    mimeType: 'image/jpeg',
  })),
  downloadMedia: vi.fn(async () => ({
    buffer: Buffer.from('bytes'),
    contentType: 'image/jpeg',
  })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({ getMediaUrl, downloadMedia }))

const { decrypt } = vi.hoisted(() => ({ decrypt: vi.fn(() => 'plaintext') }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt }))

import { GET } from './route'

function get() {
  return GET(new Request('http://localhost/api/whatsapp/media/MID-1'), {
    params: Promise.resolve({ mediaId: 'MID-1' }),
  })
}

beforeEach(() => {
  supabaseMock = makeSupabaseMock()
  getMediaUrl.mockClear()
  decrypt.mockClear()
})

describe('GET /api/whatsapp/media/[mediaId] — provider guard', () => {
  it('responde 400 legível (não 500) quando a conta está em UAZAPI', async () => {
    configRow = { id: 'cfg-1', provider: 'uazapi', access_token: null }

    const res = await get()

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/different provider/i)
    expect(decrypt).not.toHaveBeenCalled()
    expect(getMediaUrl).not.toHaveBeenCalled()
  })

  it('responde igual numa linha meta com access_token null', async () => {
    configRow = { id: 'cfg-1', provider: 'meta', access_token: null }

    const res = await get()

    expect(res.status).toBe(400)
    expect(getMediaUrl).not.toHaveBeenCalled()
  })

  it('não interfere numa conta meta saudável', async () => {
    configRow = { id: 'cfg-1', provider: 'meta', access_token: 'enc-token' }

    const res = await get()

    expect(res.status).toBe(200)
    expect(getMediaUrl).toHaveBeenCalledTimes(1)
  })
})
