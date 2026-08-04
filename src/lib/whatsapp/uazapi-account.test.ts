import { describe, it, expect } from 'vitest'
import { loadUazapiToken, toStatusPayload } from './uazapi-account'
import { encrypt } from './encryption'
import type { UazapiInstanceState } from './uazapi-api'

/** Supabase stub: só o encadeamento que loadUazapiToken usa. */
function stubSupabase(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => result }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('loadUazapiToken', () => {
  it('decifra o token quando a config existe', async () => {
    const s = stubSupabase({
      data: { provider: 'uazapi', uazapi_instance_token: encrypt('tok-123') },
      error: null,
    })
    expect(await loadUazapiToken(s, 'acc')).toEqual({ token: 'tok-123' })
  })

  it('devolve no_config quando não há linha', async () => {
    expect(await loadUazapiToken(stubSupabase({ data: null, error: null }), 'acc'))
      .toEqual({ error: 'no_config' })
  })

  it('devolve wrong_provider para conta Meta', async () => {
    const s = stubSupabase({ data: { provider: 'meta', uazapi_instance_token: null }, error: null })
    expect(await loadUazapiToken(s, 'acc')).toEqual({ error: 'wrong_provider' })
  })

  it('devolve token_corrupted quando a decifragem falha', async () => {
    const s = stubSupabase({
      data: { provider: 'uazapi', uazapi_instance_token: 'lixo-nao-cifrado' },
      error: null,
    })
    expect(await loadUazapiToken(s, 'acc')).toEqual({ error: 'token_corrupted' })
  })
})

/** Estado da UAZAPI com os campos vazios que ela devolve por padrão. */
function makeState(
  instance: Partial<UazapiInstanceState['instance']>,
  status: Partial<UazapiInstanceState['status']>,
): UazapiInstanceState {
  return {
    instance: {
      id: 'inst-1',
      status: 'disconnected',
      qrcode: '',
      name: '',
      owner: '',
      profileName: '',
      profilePicUrl: '',
      isBusiness: false,
      lastDisconnect: '',
      lastDisconnectReason: '',
      msg_delay_min: 0,
      msg_delay_max: 0,
      ...instance,
    },
    status: { connected: false, loggedIn: false, jid: null, ...status },
  }
}

describe('toStatusPayload', () => {
  it('marca connected só quando connected E loggedIn são verdadeiros', () => {
    const p = toStatusPayload(
      makeState(
        { status: 'connected', name: 'Vendas', owner: '5521984379771', profileName: 'Balli' },
        { connected: true, loggedIn: true, jid: '5521984379771@s.whatsapp.net' },
      ),
    )
    expect(p).toEqual({
      ok: true,
      connected: true,
      instance_status: 'connected',
      qrcode: null,
      phone: '5521984379771',
      profile_name: 'Balli',
      instance_name: 'Vendas',
      last_disconnect_reason: null,
    })
  })

  it('não considera conectado um socket aberto sem sessão (connected sem loggedIn)', () => {
    const p = toStatusPayload(
      makeState({ status: 'connecting' }, { connected: true, loggedIn: false }),
    )
    expect(p.connected).toBe(false)
  })

  it('expõe o QR vigente enquanto connecting', () => {
    const p = toStatusPayload(
      makeState(
        { status: 'connecting', qrcode: 'data:image/png;base64,AAAA' },
        { connected: true, loggedIn: false },
      ),
    )
    expect(p.connected).toBe(false)
    expect(p.instance_status).toBe('connecting')
    expect(p.qrcode).toBe('data:image/png;base64,AAAA')
  })

  it('normaliza o QR vazio para null — string vazia renderizaria um <img> quebrado', () => {
    const p = toStatusPayload(
      makeState(
        { status: 'disconnected', qrcode: '', lastDisconnectReason: 'QR Code timeout' },
        { connected: false, loggedIn: false },
      ),
    )
    expect(p.qrcode).toBeNull()
    expect(p.connected).toBe(false)
    expect(p.phone).toBeNull()
    expect(p.profile_name).toBeNull()
    expect(p.instance_name).toBeNull()
    expect(p.last_disconnect_reason).toBe('QR Code timeout')
  })
})
