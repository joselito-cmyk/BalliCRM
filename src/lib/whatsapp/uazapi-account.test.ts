import { describe, it, expect, vi } from 'vitest'
import { loadUazapiToken } from './uazapi-account'
import { encrypt } from './encryption'

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
