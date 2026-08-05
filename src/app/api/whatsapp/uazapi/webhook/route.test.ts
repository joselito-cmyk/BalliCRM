import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// A rota do webhook da UAZAPI é a ÚNICA dona de duas coisas que nenhum teste
// de unidade do parser cobre:
//
//   1. o roteamento por sha256(token) — e o fato de que não existe mais
//      fallback nenhum (o antigo fallback por `owner`, o telefone comercial
//      público da conta, permitia injeção de mensagem sem autenticação);
//   2. a construção do `mediaUrl` (`/api/whatsapp/uazapi/media/<messageid>`).
//      `uazapi-inbound.test.ts` só afirma que o parser puro deixa
//      `mediaUrl: null`; nada ligava um payload real de imagem até o valor
//      que de fato aterrissa em `messages.media_url`.
//
// Padrão de mock copiado dos testes de rota já existentes (config/route.test.ts
// para o Supabase encadeado, webhook/route.test.ts da Meta para o mock de
// `@/lib/whatsapp/inbound`).
// ---------------------------------------------------------------------------

/** Linha de whatsapp_config devolvida pelo lookup por hash do token. */
let configRow: Record<string, unknown> | null = null
/** Filtros aplicados na query, para provar por qual coluna a rota roteou. */
let filters: Array<[string, unknown]> = []

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.eq = vi.fn((col: string, val: unknown) => {
        filters.push([col, val])
        return b
      })
      b.maybeSingle = vi.fn(async () => ({ data: configRow, error: null }))
      return b
    },
  }),
}))

const { processInboundMessage, processInboundReaction } = vi.hoisted(() => ({
  processInboundMessage: vi.fn(async (_args: unknown) => {}),
  processInboundReaction: vi.fn(async (_args: unknown) => {}),
}))
vi.mock('@/lib/whatsapp/inbound', () => ({
  processInboundMessage,
  processInboundReaction,
}))

// `after()` só enfileira o trabalho fora do ciclo da resposta; nos testes
// executamos na hora para poder inspecionar o que o pipeline recebeu.
const { pending } = vi.hoisted(() => ({ pending: [] as Array<Promise<unknown>> }))
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return {
    ...actual,
    after: (fn: () => unknown | Promise<unknown>) => {
      pending.push(Promise.resolve().then(fn))
    },
  }
})

import { POST } from './route'
import { hashInstanceToken } from '@/lib/whatsapp/uazapi-token'

const TOKEN = 'tok-instancia-abc'

function post(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/whatsapp/uazapi/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

/** Envelope com a forma das capturas reais (ver docs/…/uazapi-inbound-payloads.md). */
function imagePayload(messageid: string, overrides: Record<string, unknown> = {}) {
  return {
    BaseUrl: 'https://balligroup.uazapi.com',
    EventType: 'messages',
    instanceName: 'Novo Rio',
    owner: '5521984379771',
    token: TOKEN,
    chat: { name: 'Joselito', wa_chatid: '557581076740@s.whatsapp.net' },
    message: {
      id: `5521984379771:${messageid}`,
      messageid,
      chatid: '557581076740@s.whatsapp.net',
      sender: '30545824219325@lid',
      sender_pn: '557581076740@s.whatsapp.net',
      senderName: 'Joselito',
      owner: '5521984379771',
      fromMe: false,
      isGroup: false,
      type: 'media',
      mediaType: 'image',
      messageType: 'ImageMessage',
      messageTimestamp: 1785921889000,
      text: '',
      content: {
        URL: 'https://mmg.whatsapp.net/enc',
        mimetype: 'image/jpeg',
        mediaKey: 'k',
        fileLength: 5084,
      },
      quoted: '',
      reaction: '',
      vote: '',
      buttonOrListid: '',
      wasSentByApi: false,
      source: 'web',
      ...overrides,
    },
  }
}

beforeEach(() => {
  configRow = { account_id: 'acct-1', user_id: 'user-1' }
  filters = []
  pending.length = 0
  processInboundMessage.mockClear()
  processInboundReaction.mockClear()
})

describe('POST /api/whatsapp/uazapi/webhook — roteamento', () => {
  it('roteia pelo hash sha256 do token e por mais nada', async () => {
    const res = await post(imagePayload('3EB08AE438DA9A60CE0F1C'))

    expect(res.status).toBe(200)
    expect(filters).toEqual([['uazapi_instance_token_hash', hashInstanceToken(TOKEN)]])
  })

  it('devolve 404 quando o token não casa com nenhuma conta', async () => {
    configRow = null

    const res = await post(imagePayload('3EB08AE438DA9A60CE0F1C'))
    const body = await res.json()

    await Promise.all(pending)
    expect(res.status).toBe(404)
    expect(body.error).toBe('Not found')
    expect(processInboundMessage).not.toHaveBeenCalled()
  })

  it('devolve 404 para um payload sem token, mesmo com `owner` de uma conta real', async () => {
    // Regressão do buraco de segurança: `owner` é o número comercial PÚBLICO
    // da conta e esta rota não tem verificação de assinatura. Sem token não
    // pode existir consulta ao banco nem processamento.
    configRow = null
    const payload = imagePayload('3EB08AE438DA9A60CE0F1C') as Record<string, unknown>
    delete payload.token

    const res = await post(payload)

    await Promise.all(pending)
    expect(res.status).toBe(404)
    expect(filters).toEqual([]) // nem chegou a consultar
    expect(processInboundMessage).not.toHaveBeenCalled()
  })
})

describe('POST /api/whatsapp/uazapi/webhook — mediaUrl', () => {
  it('entrega ao pipeline o caminho do proxy montado a partir do messageid', async () => {
    const res = await post(imagePayload('3EB08AE438DA9A60CE0F1C'))
    await Promise.all(pending)

    expect(res.status).toBe(200)
    expect(processInboundMessage).toHaveBeenCalledTimes(1)
    const arg = processInboundMessage.mock.calls[0][0] as {
      accountId: string
      configOwnerUserId: string
      message: { mediaUrl: string | null; contentType: string; providerMessageId: string }
    }
    expect(arg.accountId).toBe('acct-1')
    expect(arg.configOwnerUserId).toBe('user-1')
    expect(arg.message.contentType).toBe('image')
    expect(arg.message.providerMessageId).toBe('3EB08AE438DA9A60CE0F1C')
    expect(arg.message.mediaUrl).toBe('/api/whatsapp/uazapi/media/3EB08AE438DA9A60CE0F1C')
  })

  it('escapa o messageid para a URL (ids com / ou + não quebram a rota do proxy)', async () => {
    await post(imagePayload('abc/def+ghi=='))
    await Promise.all(pending)

    const arg = processInboundMessage.mock.calls[0][0] as {
      message: { mediaUrl: string | null }
    }
    expect(arg.message.mediaUrl).toBe('/api/whatsapp/uazapi/media/abc%2Fdef%2Bghi%3D%3D')
  })

  it('não monta mediaUrl para mensagem de texto', async () => {
    await post(
      imagePayload('TXT-1', {
        type: 'text',
        mediaType: '',
        messageType: 'Conversation',
        text: 'teste 1',
        content: 'teste 1',
      }),
    )
    await Promise.all(pending)

    const arg = processInboundMessage.mock.calls[0][0] as {
      message: { mediaUrl: string | null; contentText: string | null }
    }
    expect(arg.message.mediaUrl).toBeNull()
    expect(arg.message.contentText).toBe('teste 1')
  })
})

describe('POST /api/whatsapp/uazapi/webhook — eventos ignorados', () => {
  it('responde 200 {status:"ignored"} para um evento sem `message` (ex. connection)', async () => {
    const res = await post({
      BaseUrl: 'https://balligroup.uazapi.com',
      EventType: 'connection',
      instanceName: 'Novo Rio',
      owner: '5521984379771',
      token: TOKEN,
    })
    const body = await res.json()

    await Promise.all(pending)
    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'ignored' })
    expect(processInboundMessage).not.toHaveBeenCalled()
    expect(processInboundReaction).not.toHaveBeenCalled()
  })

  it('responde 400 para corpo que não é JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/whatsapp/uazapi/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'não é json',
      }),
    )
    expect(res.status).toBe(400)
  })
})
