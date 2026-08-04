import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UazapiInstanceState } from '@/lib/whatsapp/uazapi-api'

// ---------------------------------------------------------------------------
// Salvar um Instance Token troca o provedor da conta e APAGA as credenciais
// da Meta. Estes testes cobrem o portão de confirmação que impede isso de
// acontecer calado (review final da branch: cinco call sites de envio pela
// Meta quebravam com TypeError depois de uma troca acidental).
// ---------------------------------------------------------------------------

/** Linha atual de whatsapp_config; cada teste define a sua. */
let existingRow: Record<string, unknown> | null = null
/** Payloads efetivamente escritos, para provar que nada foi gravado no 409. */
let writes: Array<{ op: 'update' | 'insert'; payload: Record<string, unknown> }> = []

function makeSupabaseMock() {
  function builder() {
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq', 'neq', 'delete']) b[m] = vi.fn(chain)
    b.update = vi.fn((payload: Record<string, unknown>) => {
      writes.push({ op: 'update', payload })
      return b
    })
    b.insert = vi.fn((payload: Record<string, unknown>) => {
      writes.push({ op: 'insert', payload })
      return b
    })
    b.maybeSingle = vi.fn(async () => ({ data: existingRow, error: null }))
    b.single = vi.fn(async () => ({ data: existingRow, error: null }))
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
    },
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        const b: Record<string, unknown> = {}
        const chain = () => b
        for (const m of ['select', 'eq']) b[m] = vi.fn(chain)
        b.maybeSingle = vi.fn(async () => ({ data: { account_id: 'acct-1' }, error: null }))
        return b
      }
      return builder()
    }),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

// Service role: só a checagem de instância já reivindicada por outra conta.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['select', 'eq', 'neq'] as const) b[m] = vi.fn(chain)
      b.maybeSingle = vi.fn(async () => ({ data: null, error: null }))
      return b
    },
  }),
}))

const { getInstanceStatus } = vi.hoisted(() => ({
  getInstanceStatus: vi.fn(async (): Promise<UazapiInstanceState> => ({
    instance: {
      id: 'inst-1',
      status: 'disconnected',
      qrcode: '',
      name: 'Vendas',
      owner: '',
      profileName: '',
      profilePicUrl: '',
      isBusiness: false,
      lastDisconnect: '',
      lastDisconnectReason: '',
      msg_delay_min: 0,
      msg_delay_max: 0,
    },
    status: { connected: false, loggedIn: false, jid: null },
  })),
}))
vi.mock('@/lib/whatsapp/uazapi-api', () => ({ getInstanceStatus }))

import { POST } from './route'

function post(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/whatsapp/uazapi/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  supabaseMock = makeSupabaseMock()
  existingRow = null
  writes = []
})

describe('POST /api/whatsapp/uazapi/config — portão de troca de provedor', () => {
  it('recusa com 409 quando existe integração Meta viva e falta confirm_switch', async () => {
    existingRow = { id: 'cfg-1', provider: 'meta', access_token: 'enc-meta-token' }

    const res = await post({ instance_token: 'tok-abc' })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.requires_confirmation).toBe(true)
    expect(body.reason).toBe('meta_config_will_be_replaced')
    expect(body.error).toMatch(/disconnect/i)
    // O ponto do portão: nada pode ter sido gravado.
    expect(writes).toHaveLength(0)
  })

  it('prossegue quando confirm_switch: true acompanha o pedido', async () => {
    existingRow = { id: 'cfg-1', provider: 'meta', access_token: 'enc-meta-token' }

    const res = await post({ instance_token: 'tok-abc', confirm_switch: true })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0].op).toBe('update')
    // A troca zera o lado da Meta.
    expect(writes[0].payload.provider).toBe('uazapi')
    expect(writes[0].payload.access_token).toBeNull()
    expect(writes[0].payload.phone_number_id).toBeNull()
  })

  it('não pede confirmação quando a conta nunca configurou a Meta', async () => {
    existingRow = null

    const res = await post({ instance_token: 'tok-abc' })
    expect(res.status).toBe(200)
    expect(writes[0].op).toBe('insert')
  })

  it('não pede confirmação quando a linha existe mas o token da Meta é null', async () => {
    // Provedor meta sem access_token = configuração nunca concluída;
    // não há nada de valor para destruir.
    existingRow = { id: 'cfg-1', provider: 'meta', access_token: null }

    const res = await post({ instance_token: 'tok-abc' })
    expect(res.status).toBe(200)
    expect(writes[0].op).toBe('update')
  })

  it('não pede confirmação ao re-salvar um token numa conta que já é UAZAPI', async () => {
    existingRow = { id: 'cfg-1', provider: 'uazapi', access_token: null }

    const res = await post({ instance_token: 'tok-novo' })
    expect(res.status).toBe(200)
    expect(writes[0].op).toBe('update')
  })
})

describe('POST /api/whatsapp/uazapi/config — estado persistido', () => {
  it('deriva status persistido e resposta do mesmo toStatusPayload', async () => {
    existingRow = null
    getInstanceStatus.mockResolvedValueOnce({
      instance: {
        id: 'inst-1',
        status: 'connected',
        qrcode: '',
        name: 'Vendas',
        owner: '5521984379771',
        profileName: 'Balli',
        profilePicUrl: '',
        isBusiness: false,
        lastDisconnect: '',
        lastDisconnectReason: '',
        msg_delay_min: 0,
        msg_delay_max: 0,
      },
      status: { connected: true, loggedIn: true, jid: '5521984379771@s.whatsapp.net' },
    })

    const res = await post({ instance_token: 'tok-abc' })
    const body = await res.json()

    expect(body.instance.connected).toBe(true)
    expect(writes[0].payload.status).toBe('connected')
    expect(writes[0].payload.uazapi_connected_phone).toBe('5521984379771')
  })

  it('um socket aberto sem sessão não conta como conectado nos dois lugares', async () => {
    existingRow = null
    getInstanceStatus.mockResolvedValueOnce({
      instance: {
        id: 'inst-1',
        status: 'connecting',
        qrcode: 'data:image/png;base64,AAAA',
        name: 'Vendas',
        owner: '',
        profileName: '',
        profilePicUrl: '',
        isBusiness: false,
        lastDisconnect: '',
        lastDisconnectReason: '',
        msg_delay_min: 0,
        msg_delay_max: 0,
      },
      // connected: true + loggedIn: false — a fórmula antiga persistia
      // 'disconnected' e respondia connected: false; agora as duas saem
      // da mesma origem.
      status: { connected: true, loggedIn: false, jid: null },
    })

    const res = await post({ instance_token: 'tok-abc' })
    const body = await res.json()

    expect(body.instance.connected).toBe(false)
    expect(writes[0].payload.status).toBe('disconnected')
    expect(writes[0].payload.connected_at).toBeNull()
  })
})
