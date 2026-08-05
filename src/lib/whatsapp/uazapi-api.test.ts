import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ENDPOINT = 'https://uazapi.test'
process.env.UAZAPI_ENDPOINT = ENDPOINT

import {
  getInstanceStatus,
  connectInstance,
  disconnectInstance,
  sendText,
  sendMedia,
  setWebhook,
  downloadMessageMedia,
} from './uazapi-api'
import { hashInstanceToken } from './uazapi-token'

const TOKEN = 'b0223b8a-f1e5-4d2e-9894-dbfc53c1dec9'

/** Resposta real capturada do servidor (ver apêndice do design). */
const connectedBody = {
  instance: {
    id: 'r76b15a4a3614b4',
    token: TOKEN,
    status: 'connected',
    paircode: '',
    qrcode: '',
    name: 'Novo Rio',
    profileName: 'Victor Corretor De Imóveis',
    profilePicUrl: 'https://pps.whatsapp.net/v/abc.jpg',
    isBusiness: true,
    plataform: 'smba',
    owner: '5521984379771',
    lastDisconnect: '2026-08-04 13:23:13.455Z',
    lastDisconnectReason: 'QR Code timeout',
    msg_delay_min: 1,
    msg_delay_max: 3,
  },
  status: { connected: true, jid: '5521984379771:1@s.whatsapp.net', loggedIn: true, resetting: false },
}

const connectingBody = {
  connected: false,
  instance: { ...connectedBody.instance, status: 'connecting', qrcode: 'data:image/png;base64,iVBORw0KGgo=', owner: '', profileName: '' },
  jid: null,
  loggedIn: false,
  response: 'Connecting',
  status: { connected: false, jid: null, loggedIn: false },
}

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true
  return vi.fn().mockResolvedValue({
    ok,
    status: init.status ?? (ok ? 200 : 400),
    json: async () => body,
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetchOnce(connectedBody))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('hashInstanceToken', () => {
  it('é determinístico e hex de 64 chars', () => {
    expect(hashInstanceToken(TOKEN)).toBe(hashInstanceToken(TOKEN))
    expect(hashInstanceToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('ignora espaços em volta (token colado da área de transferência)', () => {
    expect(hashInstanceToken(`  ${TOKEN}\n`)).toBe(hashInstanceToken(TOKEN))
  })

  it('tokens diferentes dão hashes diferentes', () => {
    expect(hashInstanceToken('a')).not.toBe(hashInstanceToken('b'))
  })
})

describe('getInstanceStatus', () => {
  it('chama GET /instance/status com o header token', async () => {
    const f = mockFetchOnce(connectedBody)
    vi.stubGlobal('fetch', f)

    await getInstanceStatus({ token: TOKEN })

    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${ENDPOINT}/instance/status`)
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.headers.token).toBe(TOKEN)
    // o admin token nunca entra numa chamada de instância
    expect(init.headers.admintoken).toBeUndefined()
  })

  it('extrai o estado conectado', async () => {
    const r = await getInstanceStatus({ token: TOKEN })
    expect(r.status.connected).toBe(true)
    expect(r.status.loggedIn).toBe(true)
    expect(r.instance.owner).toBe('5521984379771')
    expect(r.instance.status).toBe('connected')
    expect(r.instance.name).toBe('Novo Rio')
  })

  it('rejeita corpo sem o objeto status', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ instance: connectedBody.instance }))
    await expect(getInstanceStatus({ token: TOKEN })).rejects.toThrow(/unexpected response/i)
  })

  it('propaga erro HTTP com a mensagem do corpo', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ error: 'Invalid Token Header' }, { ok: false, status: 401 }))
    await expect(getInstanceStatus({ token: 'errado' })).rejects.toThrow('Invalid Token Header')
  })

  it('não vaza o token na mensagem de erro', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({}, { ok: false, status: 500 }))
    await expect(getInstanceStatus({ token: TOKEN })).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(TOKEN) }),
    )
  })
})

describe('connectInstance', () => {
  it('chama POST /instance/connect e devolve o QR', async () => {
    const f = mockFetchOnce(connectingBody)
    vi.stubGlobal('fetch', f)

    const r = await connectInstance({ token: TOKEN })

    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${ENDPOINT}/instance/connect`)
    expect(init.method).toBe('POST')
    expect(r.instance.qrcode).toMatch(/^data:image\/png;base64,/)
    expect(r.instance.status).toBe('connecting')
    expect(r.status.loggedIn).toBe(false)
  })

  it('lê o status pelo objeto aninhado, não pelos campos de topo', async () => {
    // O /connect duplica connected/loggedIn na raiz E em `status`.
    // Um corpo divergente prova qual dos dois o parser usa.
    vi.stubGlobal('fetch', mockFetchOnce({
      ...connectingBody,
      connected: true,
      loggedIn: true,
      status: { connected: false, jid: null, loggedIn: false },
    }))
    const r = await connectInstance({ token: TOKEN })
    expect(r.status.connected).toBe(false)
    expect(r.status.loggedIn).toBe(false)
  })
})

describe('disconnectInstance', () => {
  it('chama POST /instance/disconnect', async () => {
    const f = mockFetchOnce({ response: 'ok' })
    vi.stubGlobal('fetch', f)

    await disconnectInstance({ token: TOKEN })

    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${ENDPOINT}/instance/disconnect`)
    expect(init.method).toBe('POST')
    expect(init.headers.token).toBe(TOKEN)
  })
})

describe('sendText', () => {
  it('posta em /send/text com number e text', async () => {
    const f = mockFetchOnce({ messageid: 'MSG123' })
    vi.stubGlobal('fetch', f)

    const r = await sendText({ token: TOKEN, number: '5521984379771', text: 'oi' })

    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${ENDPOINT}/send/text`)
    expect(JSON.parse(init.body)).toEqual({ number: '5521984379771', text: 'oi' })
    expect(r.messageId).toBe('MSG123')
  })

  it('aceita messageId como alias de messageid', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ messageId: 'ALIAS' }))
    const r = await sendText({ token: TOKEN, number: '55', text: 'x' })
    expect(r.messageId).toBe('ALIAS')
  })

  it('falha quando não vem id nenhum', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ ok: true }))
    await expect(sendText({ token: TOKEN, number: '55', text: 'x' })).rejects.toThrow(/no message id/i)
  })
})

describe('sendMedia', () => {
  it('usa /send/media com type discriminando o tipo', async () => {
    const f = mockFetchOnce({ messageid: 'M1' })
    vi.stubGlobal('fetch', f)

    await sendMedia({ token: TOKEN, number: '55', kind: 'image', path: 'https://x/y.jpg', caption: 'legenda' })

    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${ENDPOINT}/send/media`)
    expect(JSON.parse(init.body)).toEqual({
      number: '55', type: 'image', file: 'https://x/y.jpg', text: 'legenda',
    })
  })

  it('mapeia document para type=document e omite text sem legenda', async () => {
    const f = mockFetchOnce({ messageid: 'M2' })
    vi.stubGlobal('fetch', f)

    await sendMedia({ token: TOKEN, number: '55', kind: 'document', path: 'https://x/y.pdf' })

    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({
      number: '55', type: 'document', file: 'https://x/y.pdf',
    })
  })

  it('exige path', async () => {
    await expect(
      sendMedia({ token: TOKEN, number: '55', kind: 'image', path: '' }),
    ).rejects.toThrow(/path/i)
  })
})

describe('setWebhook', () => {
  it('posta em /webhook com url, events e enabled', async () => {
    const f = mockFetchOnce([{
      id: 'r458e3509defb83',
      url: 'https://app.example/hook',
      enabled: true,
      events: ['messages'],
      addUrlEvents: false,
      addUrlTypesMessages: false,
      excludeMessages: [],
    }])
    vi.stubGlobal('fetch', f)

    const r = await setWebhook({ token: TOKEN, url: 'https://app.example/hook', events: ['messages'] })

    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${ENDPOINT}/webhook`)
    expect(init.method).toBe('POST')
    expect(init.headers.token).toBe(TOKEN)
    expect(JSON.parse(init.body)).toEqual({
      url: 'https://app.example/hook',
      events: ['messages'],
      enabled: true,
    })
    expect(r.url).toBe('https://app.example/hook')
    expect(r.enabled).toBe(true)
  })

  // Contrato verificado ao vivo: a resposta é um ARRAY de um elemento,
  // não um objeto. Ler `data.url` direto devolveria undefined.
  it('extrai o primeiro elemento do array de resposta', async () => {
    vi.stubGlobal('fetch', mockFetchOnce([{ id: 'x', url: 'https://a', enabled: true, events: [] }]))
    const r = await setWebhook({ token: TOKEN, url: 'https://a', events: [] })
    expect(r.id).toBe('x')
  })

  it('falha claro se a UAZAPI devolver array vazio', async () => {
    vi.stubGlobal('fetch', mockFetchOnce([]))
    await expect(
      setWebhook({ token: TOKEN, url: 'https://a', events: [] })
    ).rejects.toThrow(/unexpected response/i)
  })
})

describe('downloadMessageMedia', () => {
  it('posta em /message/download com o id da mensagem', async () => {
    const f = mockFetchOnce({ fileURL: 'https://cdn.uazapi/x.jpg', mimetype: 'image/jpeg' })
    vi.stubGlobal('fetch', f)

    const r = await downloadMessageMedia({ token: TOKEN, messageId: 'ABC123' })

    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${ENDPOINT}/message/download`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ id: 'ABC123' })
    expect(r.fileUrl).toBe('https://cdn.uazapi/x.jpg')
    expect(r.mimeType).toBe('image/jpeg')
  })

  // Armadilha documentada: o campo é base64Data, NÃO base64. E o que
  // usamos é fileURL — ler `base64` devolveria undefined sempre.
  it('falha claro quando não vem fileURL', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ base64: 'AAAA' }))
    await expect(
      downloadMessageMedia({ token: TOKEN, messageId: 'X' })
    ).rejects.toThrow(/no file url/i)
  })
})
