/**
 * Parser do payload de entrada da UAZAPI → forma normalizada.
 *
 * Puro de propósito: sem banco, sem rede. Toda decisão que precise de
 * I/O (baixar mídia) fica na rota. Isso é o que torna o parser testável
 * contra payloads capturados de verdade.
 *
 * Campos confirmados contra 3 payloads reais (texto, imagem, áudio —
 * ver docs/superpowers/specs/uazapi-inbound-payloads.md):
 *   - `owner`, em todos os níveis, é o número da PRÓPRIA instância, nunca
 *     o remetente. Não usar para identificar quem mandou a mensagem.
 *   - `sender` vem como `<id>@lid`; o número de verdade está em
 *     `sender_pn` — que TEM o sufixo `@s.whatsapp.net` (a documentação
 *     da comunidade dizia que vinha "puro"; não vem).
 *   - `type` vem genérico ('media') para qualquer mídia; o tipo real
 *     está em `mediaType` — e para áudio o valor é `'ptt'`, não
 *     `'audio'`.
 *   - O campo de data é `messageTimestamp` (não `timestamp`), sempre em
 *     milissegundos nas capturas reais — mas a heurística `>1e12`
 *     continua aplicada por segurança.
 *   - `content` é uma STRING para texto (duplica `text`) e um OBJETO
 *     para mídia (`URL`, `mimetype`, `mediaKey`, …) — nunca ler
 *     `content` como texto sem checar o tipo primeiro.
 *   - Resposta citada é `quoted` (não `quotedMessageId`); reação é
 *     `reaction` — ambos strings vazias quando não aplicável. A FORMA
 *     quando populados não foi verificada ao vivo (nenhum teste real
 *     de resposta citada ou reação foi capturado).
 */

import type {
  NormalizedInboundMessage,
  NormalizedInboundReaction,
  InboundContentType,
} from './inbound'

export type ParsedUazapiInbound =
  | { kind: 'message'; message: NormalizedInboundMessage }
  | { kind: 'reaction'; reaction: NormalizedInboundReaction }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** `> 1e12` só pode ser milissegundos — segundos nessa ordem seriam ano ~33658. */
function toDate(ts: unknown): Date {
  const n = typeof ts === 'number' ? ts : Number(ts)
  if (!Number.isFinite(n) || n <= 0) return new Date()
  return new Date(n > 1e12 ? n : n * 1000)
}

/** Telefone da outra parte, só dígitos — sender_pn sempre tem sufixo @…, remover. */
function senderPhone(m: Record<string, unknown>): string {
  const pn = str(m.sender_pn)
  const raw = pn || str(m.sender) || str(m.chatid)
  return raw.replace(/@.*$/, '').replace(/\D/g, '')
}

/** Mapeia o tipo da UAZAPI para os valores aceitos pela CHECK do banco. */
function contentTypeOf(m: Record<string, unknown>): InboundContentType {
  const media = str(m.mediaType).toLowerCase()
  const type = str(m.type).toLowerCase()
  const t = media || type
  if (t.includes('image') || t === 'sticker') return 'image'
  if (t.includes('video')) return 'video'
  if (t.includes('audio') || t.includes('ptt')) return 'audio'
  if (t.includes('document')) return 'document'
  if (t.includes('location')) return 'location'
  return 'text'
}

/**
 * `content` é string quando é texto puro (duplica `text`) e objeto
 * quando é mídia — nunca usar como contentText sem essa checagem.
 */
function textOf(m: Record<string, unknown>): string | null {
  if (typeof m.text === 'string' && m.text) return m.text
  if (typeof m.content === 'string' && m.content) return m.content
  return null
}

export function parseUazapiInbound(payload: unknown): ParsedUazapiInbound | null {
  const p = payload as Record<string, unknown> | null
  const m = p?.message as Record<string, unknown> | undefined
  if (!m || typeof m !== 'object') return null

  // Eco da nossa própria mensagem, ou grupo: fora do escopo do CRM.
  if (m.fromMe === true) return null
  if (m.isGroup === true) return null

  // messageid é o id "puro"; `id` vem prefixado com "<instância>:".
  const providerMessageId = str(m.messageid) || str(m.id)
  if (!providerMessageId) return null

  const from = senderPhone(m)
  if (!from) return null

  const chat = (p?.chat as Record<string, unknown> | undefined) ?? {}
  const contactName = str(m.senderName) || str(chat.name) || ''

  // Reação: vira estado, não mensagem. NÃO VERIFICADO AO VIVO — nenhuma
  // reação real foi capturada; `messageType` provavelmente vira algo como
  // "ReactionMessage" por analogia com ImageMessage/AudioMessage, mas isso
  // é inferência.
  const messageType = str(m.messageType)
  if (messageType === 'ReactionMessage' || str(m.type) === 'reaction') {
    const target = str(m.quoted) || str(m.reaction)
    if (!target) return null
    return {
      kind: 'reaction',
      reaction: {
        from,
        contactName,
        targetProviderMessageId: target,
        emoji: str(m.reaction) || '',
      },
    }
  }

  // Toque em botão / linha de lista. Nomes de campo confirmados (existem
  // vazios nos 3 payloads reais); valor quando populado não testado.
  const isInteractive =
    messageType === 'ButtonsResponseMessage' || messageType === 'ListResponseMessage'
  if (isInteractive) {
    const replyId = str(m.buttonOrListid)
    return {
      kind: 'message',
      message: {
        providerMessageId,
        from,
        contactName,
        sentAt: toDate(m.messageTimestamp),
        contentType: 'interactive',
        contentText: str(m.vote) || replyId || null,
        mediaUrl: null,
        interactiveReplyId: replyId || null,
        // `quoted` — forma quando populado não verificada ao vivo.
        replyToProviderMessageId: str(m.quoted) || null,
        fallbackLabel: 'interactive',
      },
    }
  }

  const contentType = contentTypeOf(m)

  return {
    kind: 'message',
    message: {
      providerMessageId,
      from,
      contactName,
      sentAt: toDate(m.messageTimestamp),
      contentType,
      // Legenda em mídia NÃO VERIFICADA AO VIVO (o teste real não tinha
      // legenda) — `text` é o candidato mais plausível por consistência
      // com a mensagem de texto, mas não confirmado.
      contentText: textOf(m),
      // Mídia é resolvida pela rota (precisa de I/O). Task 5 preenche.
      mediaUrl: null,
      interactiveReplyId: null,
      replyToProviderMessageId: str(m.quoted) || null,
      fallbackLabel: contentType,
    },
  }
}
