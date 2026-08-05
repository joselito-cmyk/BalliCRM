import { describe, it, expect } from 'vitest'
import { parseUazapiInbound } from './uazapi-inbound'

// Payload real de texto, capturado em produção em 2026-08-05
// (docs/superpowers/specs/uazapi-inbound-payloads.md).
const textPayload = {
  BaseUrl: 'https://balligroup.uazapi.com',
  EventType: 'messages',
  instanceName: 'Novo Rio',
  owner: '5521984379771',
  token: 'b0223b8a-f1e5-4d2e-9894-dbfc53c1dec9',
  chat: { name: 'Joselito', owner: '5521984379771' },
  message: {
    id: '5521984379771:3EB08AE438DA9A60CE0F1C',
    messageid: '3EB08AE438DA9A60CE0F1C',
    chatid: '557581076740@s.whatsapp.net',
    sender: '30545824219325@lid',
    sender_pn: '557581076740@s.whatsapp.net',
    senderName: 'Joselito',
    owner: '5521984379771',
    fromMe: false,
    isGroup: false,
    type: 'text',
    mediaType: '',
    messageType: 'Conversation',
    messageTimestamp: 1785921889000,
    text: 'teste 1',
    content: 'teste 1',
    quoted: '',
    reaction: '',
    vote: '',
    buttonOrListid: '',
  },
}

// Payload real de imagem — mesma casca, `content` vira objeto, sem legenda
// (a foto de teste não tinha uma — ver nota "Ainda não verificado").
const imagePayload = {
  ...textPayload,
  message: {
    ...textPayload.message,
    id: '5521984379771:3EB0C4ED0F216235E7AF1C',
    messageid: '3EB0C4ED0F216235E7AF1C',
    type: 'media',
    mediaType: 'image',
    messageType: 'ImageMessage',
    messageTimestamp: 1785921906000,
    text: '',
    content: { URL: 'https://mmg.whatsapp.net/...', mimetype: 'image/jpeg' },
  },
}

// Payload real de áudio — mediaType é "ptt", NÃO "audio".
const audioPayload = {
  ...textPayload,
  message: {
    ...textPayload.message,
    id: '5521984379771:3A7F9ED2A67660672895',
    messageid: '3A7F9ED2A67660672895',
    type: 'media',
    mediaType: 'ptt',
    messageType: 'AudioMessage',
    messageTimestamp: 1785921926000,
    text: '',
    content: { URL: 'https://mmg.whatsapp.net/...', mimetype: 'audio/ogg; codecs=opus' },
  },
}

describe('parseUazapiInbound', () => {
  it('extrai uma mensagem de texto (payload real capturado)', () => {
    const r = parseUazapiInbound(textPayload)
    if (r?.kind !== 'message') throw new Error('esperava message')
    // messageid "puro", sem o prefixo "<instância>:" que `id` carrega.
    expect(r.message.providerMessageId).toBe('3EB08AE438DA9A60CE0F1C')
    expect(r.message.from).toBe('557581076740')
    expect(r.message.contactName).toBe('Joselito')
    expect(r.message.contentType).toBe('text')
    expect(r.message.contentText).toBe('teste 1')
    expect(r.message.sentAt.getTime()).toBe(1785921889000)
  })

  it('extrai uma imagem — mediaType manda, mesmo com content como objeto', () => {
    const r = parseUazapiInbound(imagePayload)
    if (r?.kind !== 'message') throw new Error('esperava message')
    expect(r.message.contentType).toBe('image')
    // content é objeto aqui — nunca deve virar contentText.
    expect(r.message.contentText).toBeNull()
  })

  // Armadilha confirmada ao vivo: mediaType de áudio é "ptt", não "audio".
  it('mapeia mediaType "ptt" para audio', () => {
    const r = parseUazapiInbound(audioPayload)
    if (r?.kind !== 'message') throw new Error('esperava message')
    expect(r.message.contentType).toBe('audio')
  })

  // Armadilha confirmada ao vivo: sender_pn TEM o sufixo @s.whatsapp.net
  // (a documentação da comunidade dizia que vinha "puro" — não vem).
  it('remove o sufixo @s.whatsapp.net de sender_pn', () => {
    const r = parseUazapiInbound(textPayload)
    if (r?.kind !== 'message') throw new Error('esperava message')
    expect(r.message.from).toBe('557581076740')
    expect(r.message.from).not.toContain('@')
  })

  // Armadilha confirmada ao vivo: `sender` vem como @lid; sender_pn é o
  // número de verdade — mas TAMBÉM tem sufixo (coberto pelo teste acima).
  it('ignora sender (@lid) e usa sender_pn', () => {
    const r = parseUazapiInbound({
      ...textPayload,
      message: { ...textPayload.message, sender: '999999999@lid', sender_pn: '5511777776666@s.whatsapp.net' },
    })
    if (r?.kind !== 'message') throw new Error('esperava message')
    expect(r.message.from).toBe('5511777776666')
  })

  // Confirmado ao vivo: messageTimestamp vem em milissegundos (13 dígitos).
  // O parser mantém a heurística >1e12 por segurança (mesma do resto do
  // apêndice), mas o valor real observado sempre foi ms.
  it('lê messageTimestamp (não timestamp) em milissegundos', () => {
    const r = parseUazapiInbound(textPayload)
    if (r?.kind !== 'message') throw new Error('esperava message')
    expect(r.message.sentAt.toISOString()).toBe(new Date(1785921889000).toISOString())
  })

  it('ignora mensagens enviadas por nós (fromMe)', () => {
    expect(parseUazapiInbound({
      ...textPayload,
      message: { ...textPayload.message, fromMe: true },
    })).toBeNull()
  })

  it('ignora mensagens de grupo', () => {
    expect(parseUazapiInbound({
      ...textPayload,
      message: { ...textPayload.message, isGroup: true },
    })).toBeNull()
  })

  it('devolve null para payload sem mensagem (ex.: evento connection)', () => {
    expect(parseUazapiInbound({ owner: '55', instanceName: 'x', token: 't', EventType: 'connection' })).toBeNull()
  })

  // Não verificado ao vivo (nenhum toque em botão foi testado) — os nomes
  // de campo (`buttonOrListid`, `vote`) vêm confirmados como EXISTENTES
  // nos payloads reais (vazios lá), mas o valor populado é inferência.
  it('mapeia resposta de botão para interactive (campos confirmados, valor inferido)', () => {
    const r = parseUazapiInbound({
      ...textPayload,
      message: {
        ...textPayload.message,
        messageType: 'ButtonsResponseMessage',
        buttonOrListid: 'opt-a',
        vote: 'Sim',
      },
    })
    if (r?.kind !== 'message') throw new Error('esperava message')
    expect(r.message.contentType).toBe('interactive')
    expect(r.message.interactiveReplyId).toBe('opt-a')
    expect(r.message.contentText).toBe('Sim')
  })

  // Nenhum payload real de localização foi capturado, então o parser NÃO
  // tenta ler lat/lng/endereço (chutar nomes de campo é o erro que este
  // projeto evitou o tempo todo). O contrato aqui é só: a bolha nunca fica
  // em branco. Quem capturar um payload real deve trocar isto por asserções
  // sobre o conteúdo de verdade.
  it('usa um placeholder rotulado para localização (forma real ainda não capturada)', () => {
    const r = parseUazapiInbound({
      ...textPayload,
      message: {
        ...textPayload.message,
        type: 'location',
        mediaType: '',
        messageType: 'LocationMessage',
        text: '',
        content: { algumCampoDesconhecido: 1 },
      },
    })
    if (r?.kind !== 'message') throw new Error('esperava message')
    expect(r.message.contentType).toBe('location')
    expect(r.message.contentText).toBe('[location]')
    expect(r.message.mediaUrl).toBeNull()
  })

  it('não aplica o placeholder de localização a outros tipos sem texto', () => {
    const r = parseUazapiInbound(imagePayload)
    if (r?.kind !== 'message') throw new Error('esperava message')
    expect(r.message.contentText).toBeNull()
  })
})
