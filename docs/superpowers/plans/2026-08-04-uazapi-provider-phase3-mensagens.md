# UAZAPI Fase 3 — Mensagens (enviar e receber) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uma conta conectada por QR Code envia e recebe mensagens (texto e
mídia) pelo UAZAPI, alimentando caixa de entrada, automações, flows e resposta
por IA exatamente como já acontece pela Meta.

**Architecture:** O miolo do webhook da Meta (`processMessage`) é extraído para
`src/lib/whatsapp/inbound.ts` operando sobre uma mensagem **normalizada**,
provedor-agnóstica. Cada provedor mantém só o seu parser: a rota da Meta
converte o payload da Meta, uma rota nova converte o payload da UAZAPI, e as
duas chamam o mesmo pipeline. Na saída, os três call sites de envio deixam de
importar `meta-api.ts` e passam a chamar `provider.ts`, que já sabe rotear.

**Tech Stack:** Next.js (App Router, route handlers), TypeScript, Supabase
(Postgres + RLS + service role), Vitest, next-intl.

## Global Constraints

- **Não quebrar a Meta.** Nenhum teste existente do caminho Meta pode ser
  editado para passar. Se um quebrar, é regressão de comportamento — não teste
  desatualizado. A extração da Task 1 é refatoração pura: comportamento
  idêntico, byte a byte no que for movido.
- **Contratos são os do apêndice** de
  `docs/superpowers/specs/2026-08-03-uazapi-provider-design.md`, seção
  "Apêndice — contratos verificados ao vivo". Onde a documentação pública da
  UAZAPI divergir, vale o apêndice — ela já errou em 7 pontos verificados.
- **Nenhum contrato entra em código sem verificação ao vivo.** É a lição da
  Fase 1, onde um cliente inteiro foi escrito contra endpoints que não existiam
  e passou em todos os testes porque os mocks codificavam o contrato errado.
  A Task 3 existe só para capturar o payload real antes de qualquer parser.
- **Segredos:** o Instance Token é cifrado (`encrypt()` de
  `src/lib/whatsapp/encryption.ts`) e nunca aparece em log, em URL ou em
  mensagem de erro devolvida ao cliente. O lookup do webhook é sempre pela
  coluna `uazapi_instance_token_hash` (SHA-256 determinístico) — a coluna
  cifrada é AES-GCM com IV aleatório e não é consultável.
- **O app não cria nem apaga instâncias UAZAPI.** Sem `UAZAPI_TOKEN` (admin
  token) em lugar nenhum. Só `UAZAPI_ENDPOINT` e o token por conta.
- **i18n:** todo texto visível vai para `messages/pt.json`, `en.json` e
  `ko.json`, sob `Settings.*` (namespace com **S maiúsculo**). Nenhuma string
  literal em componente.
- **Testes:** Vitest, ao lado do fonte (`src/lib/whatsapp/foo.test.ts`), **sem**
  pasta `__tests__/`. `fetch` mockado no padrão de `uazapi-api.test.ts`.
- **Formato de número na UAZAPI:** só dígitos, com código do país, sem `+` e sem
  espaços (`5521984379771`). O retry de variantes de telefone da Meta
  (`phoneVariants`) **não se aplica** ao caminho UAZAPI.

---

## Estado de partida (verificado em 2026-08-04)

Fatos que o implementador não tem como adivinhar e que mudam o trabalho:

- **`provider.ts` existe e está pronto, mas não tem nenhum chamador em
  produção.** `grep -rl "whatsapp/provider'" src/` devolve só o próprio teste.
  Ligar os call sites nele é metade desta fase.
- **Os guards de provedor já existem.** As duas rodadas de correção da Fase 2
  já protegeram *todos* os pontos que faziam `decrypt(config.access_token)`:
  `send-message.ts`, `broadcast-core.ts`, `automations/meta-send.ts`,
  `flows/meta-send.ts`, `broadcast/route.ts`, `react/route.ts`,
  `media/[mediaId]/route.ts`, `templates/{sync,submit,[id]}/route.ts` e o
  próprio `webhook/route.ts`. Eles hoje **recusam** UAZAPI com erro claro. As
  Tasks 2 e 5 convertem em roteamento os que devem passar a funcionar
  (texto/mídia); os demais (templates, interativos, broadcast, reações)
  **continuam recusando de propósito** — é o comportamento desejado.
- **A instância de teste está conectada** ao número `5521984379771`
  (`Novo Rio`, token `uazapi_instance_token` da conta de teste), e o webhook
  dela está registrado porém **desabilitado** (`enabled:false`, `url:""`).
- **Só existe 1 vaga de instância** na assinatura. Testar Meta e UAZAPI ao mesmo
  tempo exige **duas contas** no CRM: a linha `whatsapp_config` é uma por conta
  e trocar de provedor zera o lado do outro.

### Contratos UAZAPI verificados ao vivo para esta fase

`POST /webhook` **[header `token`]** — registra/atualiza o webhook da instância:

```jsonc
// request
{ "url": "https://…", "events": ["messages","connection"], "enabled": true }

// response 200 — ARRAY, não objeto
[{ "id": "r458e3509defb83", "url": "https://…", "enabled": true,
   "events": ["messages","connection"],
   "addUrlEvents": false, "addUrlTypesMessages": false, "excludeMessages": [] }]
```

Três descobertas que o desenho anterior não previa:

1. **É upsert, não create.** Um `POST` com URL diferente mantém o **mesmo `id`**
   e substitui a URL. Só existe **uma** entrada por instância. Logo, registrar é
   idempotente e pode rodar a cada conexão sem acumular lixo.
2. **`DELETE /webhook` não existe** (405). Para desligar, `POST` com
   `{"url":"","events":[],"enabled":false}`.
3. **`GET /webhook` devolve `null`** quando nunca foi configurado, e um array de
   um elemento depois disso.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `src/lib/whatsapp/inbound.ts` | **Novo.** Pipeline de entrada provedor-agnóstico: contato → conversa → mensagem → automações/flows/IA/webhooks. Recebe `NormalizedInboundMessage`. |
| `src/lib/whatsapp/inbound.test.ts` | **Novo.** Prova que o pipeline preserva o comportamento e trata cada tipo. |
| `src/app/api/whatsapp/webhook/route.ts` | **Modificado.** Fica só com: verificação de assinatura, parsing do payload da Meta, normalização, e delega a `inbound.ts`. |
| `src/app/api/whatsapp/uazapi/webhook/route.ts` | **Novo.** Recebe callbacks da UAZAPI, roteia a conta pelo hash do token, normaliza e delega a `inbound.ts`. |
| `src/lib/whatsapp/uazapi-inbound.ts` | **Novo.** Só o parser: payload cru da UAZAPI → `NormalizedInboundMessage`. Sem banco, sem rede — testável puro. |
| `src/lib/whatsapp/uazapi-inbound.test.ts` | **Novo.** Testes do parser contra payloads reais capturados na Task 3. |
| `src/app/api/whatsapp/uazapi/media/[messageId]/route.ts` | **Novo.** Proxy de mídia recebida, via `POST /message/download`. |
| `src/lib/whatsapp/uazapi-api.ts` | **Modificado.** Ganha `setWebhook()` e `downloadMessageMedia()`. |
| `src/lib/whatsapp/send-message.ts` | **Modificado.** Passa a rotear por `provider.ts` em vez de recusar UAZAPI. |
| `src/lib/automations/meta-send.ts` | **Modificado.** Idem. |
| `src/lib/flows/meta-send.ts` | **Modificado.** Idem (3 call sites). |
| `src/app/api/whatsapp/uazapi/connect/route.ts` | **Modificado.** Registra o webhook ao conectar. |
| `src/components/settings/whatsapp-config-uazapi.tsx` | **Modificado.** Avisa quais recursos não existem no UAZAPI. |
| `messages/{pt,en,ko}.json` | **Modificado.** Strings novas. |

---

## Task 1: Extrair o pipeline de entrada para `inbound.ts`

Refatoração pura. Nenhuma mudança de comportamento. É a tarefa mais sensível do
plano porque mexe no caminho de produção da Meta.

**Files:**
- Create: `src/lib/whatsapp/inbound.ts`
- Create: `src/lib/whatsapp/inbound.test.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts`

**Interfaces:**
- Consumes: nada de tarefas anteriores.
- Produces:
  - `interface NormalizedInboundMessage`
  - `interface NormalizedInboundReaction`
  - `processInboundMessage(args: ProcessInboundArgs): Promise<void>`
  - `processInboundReaction(args: ProcessReactionArgs): Promise<void>`

- [ ] **Step 1: Criar `inbound.ts` com o tipo normalizado e as funções movidas**

Crie `src/lib/whatsapp/inbound.ts`. O cliente Supabase segue o mesmo padrão
lazy já usado em `webhook/route.ts` e em `uazapi/config/route.ts` — assim os
corpos movidos ficam **idênticos**, que é o que torna esta refatoração segura.

```ts
/**
 * Pipeline de entrada de mensagens, provedor-agnóstico.
 *
 * Extraído de src/app/api/whatsapp/webhook/route.ts, onde vivia acoplado
 * ao formato de payload da Meta. O que era específico da Meta (verificar
 * assinatura, ler `entry[].changes[].value`, baixar mídia pelo Graph API)
 * fica na rota; o que é comum a qualquer provedor mora aqui.
 *
 * A fronteira é o `NormalizedInboundMessage`: cada provedor traduz o seu
 * payload para essa forma e entrega. Nada aqui sabe se veio da Meta ou da
 * UAZAPI.
 */

import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from './phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * Valores aceitos pela CHECK constraint de `messages.content_type`
 * (001_initial_schema.sql, alargada na 010 para incluir 'interactive').
 * Um valor fora desta lista faz o INSERT falhar.
 */
export type InboundContentType =
  | 'text' | 'image' | 'document' | 'audio'
  | 'video' | 'location' | 'template' | 'interactive'

/**
 * Uma mensagem recebida, já traduzida do formato do provedor.
 *
 * Regra para quem escreve um parser novo: TODOS os campos são
 * responsabilidade do parser. O pipeline não adivinha nada — se
 * `contentText` vier null e `mediaUrl` também, a mensagem entra vazia.
 */
export interface NormalizedInboundMessage {
  /** Id da mensagem no provedor (wamid da Meta, messageid da UAZAPI). */
  providerMessageId: string
  /** Telefone de quem enviou, só dígitos com código do país. */
  from: string
  /** Nome de exibição informado pelo provedor; '' quando desconhecido. */
  contactName: string
  /** Quando o provedor diz que foi enviada. */
  sentAt: Date
  contentType: InboundContentType
  contentText: string | null
  /** URL servida pelo NOSSO app (rota de proxy), nunca a do provedor. */
  mediaUrl: string | null
  /** Id da opção tocada num botão/lista; null fora disso. */
  interactiveReplyId: string | null
  /** Id (no provedor) da mensagem citada numa resposta; null fora disso. */
  replyToProviderMessageId: string | null
  /** Rótulo usado em `last_message_text` quando não há texto. Ex.: 'image'. */
  fallbackLabel: string
}

/** Reação não é mensagem: vira estado em `message_reactions`. */
export interface NormalizedInboundReaction {
  from: string
  contactName: string
  /** Id (no provedor) da mensagem reagida. */
  targetProviderMessageId: string
  /** String vazia significa remoção da reação. */
  emoji: string
}
```

- [ ] **Step 2: Mover as quatro funções auxiliares, verbatim**

Ainda em `inbound.ts`, mova **sem alterar uma linha do corpo**:

| Função | Origem em `webhook/route.ts` |
|---|---|
| `flagBroadcastReplyIfAny` | linhas 465-494 |
| `lookupInternalIdByMetaId` | linhas 501-516 |
| `findOrCreateContact` (+ `ContactRow`, `ContactOutcome`) | linhas 991-1060 |
| `findOrCreateConversation` | linhas 1061 até o fim do arquivo |

Duas mudanças cirúrgicas, e só estas:

1. `lookupInternalIdByMetaId` passa a se chamar `lookupInternalIdByProviderId`
   (o parâmetro `metaId` vira `providerId`) — o nome antigo mente agora que
   serve os dois provedores. Atualize o texto do `console.error` de
   `'[webhook] lookupInternalIdByMetaId failed:'` para
   `'[inbound] lookupInternalIdByProviderId failed:'`.
2. Nenhuma delas é exportada, exceto se um teste precisar — mantenha privadas.

Delete as quatro de `webhook/route.ts`.

- [ ] **Step 3: Escrever `processInboundReaction`**

```ts
export interface ProcessReactionArgs {
  accountId: string
  configOwnerUserId: string
  reaction: NormalizedInboundReaction
}

/**
 * Persiste uma reação recebida. Reações não são mensagens — são estado
 * por (alvo, autor). Fazemos upsert/delete em `message_reactions` e
 * nunca inserimos em `messages`.
 *
 * Best-effort: alvo ausente (nunca recebemos a mensagem original) é
 * logado e ignorado, para o webhook ainda responder 200 ao provedor.
 */
export async function processInboundReaction(args: ProcessReactionArgs): Promise<void> {
  const { accountId, configOwnerUserId, reaction } = args

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    normalizePhone(reaction.from),
    reaction.contactName
  )
  if (!contactOutcome) return

  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactOutcome.contact.id
  )
  if (!convResult) return
  const conversationId = convResult.conversation.id

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversationId,
      contact_id: contactOutcome.contact.id,
    })
  }

  const targetInternalId = await lookupInternalIdByProviderId(
    reaction.targetProviderMessageId,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[inbound] reaction target message not found; skipping',
      reaction.targetProviderMessageId
    )
    return
  }

  // Emoji vazio = remoção (spec da Cloud API da Meta; a UAZAPI usa a
  // mesma convenção no campo de reação).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactOutcome.contact.id)
    if (delError) {
      console.error('[inbound] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactOutcome.contact.id,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[inbound] reaction upsert failed:', upsertError.message)
  }
}
```

- [ ] **Step 4: Escrever `processInboundMessage`**

Este é o corpo de `processMessage` (webhook/route.ts:577-844) com três
diferenças, e só três: (a) recebe `NormalizedInboundMessage` em vez de
`WhatsAppMessage` + `accessToken`; (b) não chama `parseMessageContent` — o
parser do provedor já fez isso; (c) não trata reação — isso é
`processInboundReaction`.

```ts
export interface ProcessInboundArgs {
  /** Tenancy: toda linha criada abaixo é carimbada com esta conta. */
  accountId: string
  /**
   * Sender-of-record para os INSERTs que exigem user_id NOT NULL
   * (contacts, conversations). Sempre o admin que salvou a config do
   * WhatsApp; a escolha é arbitrária pós-017 mas estável.
   */
  configOwnerUserId: string
  message: NormalizedInboundMessage
}

export async function processInboundMessage(args: ProcessInboundArgs): Promise<void> {
  const { accountId, configOwnerUserId, message } = args
  const senderPhone = normalizePhone(message.from)

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    message.contactName
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  // Emite conversation.created assim que a thread abre, para um
  // assinante sempre ver a thread aberta antes da primeira
  // message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Resposta com citação: pai ausente é aceitável — guardamos NULL e a
  // UI renderiza sem a citação.
  let replyToInternalId: string | null = null
  if (message.replyToProviderMessageId) {
    replyToInternalId = await lookupInternalIdByProviderId(
      message.replyToProviderMessageId,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[inbound] reply context parent not found:',
        message.replyToProviderMessageId
      )
    }
  }

  // Descobrir se é a primeira mensagem do contato ANTES do insert, para
  // a contagem ser exata. Cobre o caso de contato já existente (import
  // manual / CSV) que nunca mandou mensagem.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: message.contentType,
    content_text: message.contentText,
    media_url: message.mediaUrl,
    message_id: message.providerMessageId,
    status: 'delivered',
    created_at: message.sentAt.toISOString(),
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: message.interactiveReplyId,
  })

  if (msgError) {
    console.error('[inbound] Error inserting message:', msgError)
    return
  }

  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: message.contentText || `[${message.fallbackLabel}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('[inbound] Error updating conversation:', convError)
  }

  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // Flows: se o runner consumiu a mensagem (avançou ou iniciou um run),
  // suprimimos os gatilhos de conteúdo — o cliente está navegando o menu
  // do bot, não mandando palavra-chave nova. Gatilhos de relacionamento
  // (new_contact_created, first_inbound_message) disparam mesmo assim:
  // são sobre QUEM mandou, não sobre o que foi dito.
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: message.interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: message.interactiveReplyId,
          reply_title: message.contentText ?? '',
          meta_message_id: message.providerMessageId,
        }
      : {
          kind: 'text',
          text: message.contentText ?? '',
          meta_message_id: message.providerMessageId,
        },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = message.contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (message.interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: message.interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // Resposta por IA: só para texto puro que o runner determinístico NÃO
  // consumiu (flows ganham do LLM) e só quando a conta habilitou.
  if (!flowConsumed && !message.interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.providerMessageId,
    content_type: message.contentType,
    text: message.contentText,
  })
}
```

- [ ] **Step 5: Adaptar o webhook da Meta para normalizar e delegar**

Em `src/app/api/whatsapp/webhook/route.ts`:

1. Troque os imports de `runAutomationsForTrigger`, `dispatchInboundToFlows`,
   `dispatchInboundToAiReply`, `findExistingContact`, `isUniqueViolation` por:
   ```ts
   import {
     processInboundMessage,
     processInboundReaction,
     type NormalizedInboundMessage,
     type InboundContentType,
   } from '@/lib/whatsapp/inbound'
   ```
   Mantenha `dispatchWebhookEvent` (ainda usado por `handleStatusUpdate`) e
   `normalizePhone` se algum outro trecho usar; remova o que ficar órfão —
   `npx tsc --noEmit` aponta.
2. Apague `processMessage` (577-844) e `handleReaction` (526-575).
3. Escreva a normalização no lugar:

```ts
/**
 * Mapeia o `type` da Meta para os valores que a CHECK de
 * messages.content_type aceita. Sticker vira image (é imagem por baixo);
 * qualquer coisa desconhecida vira text, para o INSERT não estourar a
 * constraint.
 */
function metaContentType(type: string): InboundContentType {
  const allowed = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  if (allowed.has(type)) return type as InboundContentType
  if (type === 'sticker') return 'image'
  return 'text'
}

/**
 * Traduz uma mensagem da Meta para a forma normalizada, incluindo a
 * verificação de mídia (que é específica da Meta: valida o media id no
 * Graph API e devolve a URL do nosso proxy).
 */
async function normalizeMetaMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  accessToken: string
): Promise<NormalizedInboundMessage> {
  const { contentText, mediaUrl, interactiveReplyId } =
    await parseMessageContent(message, accessToken)

  return {
    providerMessageId: message.id,
    from: message.from,
    contactName: contact.profile.name,
    sentAt: new Date(parseInt(message.timestamp) * 1000),
    contentType: metaContentType(message.type),
    contentText,
    mediaUrl,
    interactiveReplyId,
    replyToProviderMessageId: message.context?.id ?? null,
    fallbackLabel: message.type,
  }
}
```

4. No laço de `processWebhook` (hoje faz `decrypt` uma vez fora do laço e itera
   por **índice**, casando `contact` por posição — `value.contacts[i] ||
   value.contacts[0]`, não por `wa_id`), troque só a chamada, preservando essa
   forma exatamente:

```ts
      const decryptedAccessToken = decrypt(config.access_token)

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        if (message.type === 'reaction') {
          if (!message.reaction?.message_id) continue
          await processInboundReaction({
            accountId: config.account_id,
            configOwnerUserId: config.user_id,
            reaction: {
              from: message.from,
              contactName: contact.profile.name,
              targetProviderMessageId: message.reaction.message_id,
              emoji: message.reaction.emoji ?? '',
            },
          })
          continue
        }

        await processInboundMessage({
          accountId: config.account_id,
          configOwnerUserId: config.user_id,
          message: await normalizeMetaMessage(message, contact, decryptedAccessToken),
        })
      }
```

> Isto reproduz o laço real de `webhook/route.ts` (linhas ~304-322 na versão
> pré-Fase-3): `decrypt` uma vez antes do laço, `contact` casado por índice. Só
> a chamada interna mudou — de `processMessage(...)` posicional para
> `processInboundMessage`/`processInboundReaction` normalizados. Não troque o
> casamento de contato para `.find(wa_id)` — não é assim que o código atual
> funciona, e mudar isso seria uma alteração de comportamento não pedida.

- [ ] **Step 6: Escrever os testes do pipeline**

Crie `src/lib/whatsapp/inbound.test.ts`.

> Sobre o stub do Supabase abaixo: ele reproduz as cadeias de query que
> `findOrCreateContact` / `findOrCreateConversation` usam hoje. Se alguma delas
> encadear um método a mais do que o stub prevê, o teste quebra com
> `x is not a function` — **estenda o stub** para cobrir a cadeia real, nunca
> enfraqueça a asserção. As asserções olham a linha efetivamente inserida
> (`inserted['messages'][0]`), não a chamada mockada, justamente para o teste
> falhar quando o comportamento mudar.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const inserted: Record<string, unknown[]> = {}
const updated: Record<string, unknown[]> = {}

/**
 * Stub do Supabase que registra o que foi escrito, para as asserções
 * olharem o efeito real (linha inserida) e não a chamada mockada.
 */
function makeDb(overrides: { priorCustomerCount?: number } = {}) {
  const chain = (table: string) => ({
    select: () => ({
      eq: () => ({
        eq: () => Promise.resolve({ count: overrides.priorCustomerCount ?? 0, data: [], error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
        in: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
      }),
    }),
    insert: (row: unknown) => {
      ;(inserted[table] ??= []).push(row)
      return Promise.resolve({ error: null, data: null })
    },
    update: (row: unknown) => ({
      eq: () => {
        ;(updated[table] ??= []).push(row)
        return Promise.resolve({ error: null })
      },
    }),
    upsert: (row: unknown) => {
      ;(inserted[table] ??= []).push(row)
      return Promise.resolve({ error: null })
    },
    delete: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
  })
  return { from: (t: string) => chain(t) }
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => makeDb(),
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn().mockResolvedValue({ consumed: false }),
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn().mockResolvedValue({ id: 'contact-1' }),
  isUniqueViolation: () => false,
}))

import { processInboundMessage, type NormalizedInboundMessage } from './inbound'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'

const baseMessage: NormalizedInboundMessage = {
  providerMessageId: 'MSG-1',
  from: '5521984379771',
  contactName: 'Cliente',
  sentAt: new Date('2026-08-04T12:00:00Z'),
  contentType: 'text',
  contentText: 'oi',
  mediaUrl: null,
  interactiveReplyId: null,
  replyToProviderMessageId: null,
  fallbackLabel: 'text',
}

beforeEach(() => {
  for (const k of Object.keys(inserted)) delete inserted[k]
  for (const k of Object.keys(updated)) delete updated[k]
  vi.clearAllMocks()
})

describe('processInboundMessage', () => {
  it('grava a mensagem com o id do provedor e a data informada', async () => {
    await processInboundMessage({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      message: baseMessage,
    })
    const rows = inserted['messages'] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].message_id).toBe('MSG-1')
    expect(rows[0].sender_type).toBe('customer')
    expect(rows[0].content_type).toBe('text')
    expect(rows[0].created_at).toBe('2026-08-04T12:00:00.000Z')
  })

  it('usa fallbackLabel em last_message_text quando não há texto', async () => {
    await processInboundMessage({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      message: { ...baseMessage, contentType: 'image', contentText: null, fallbackLabel: 'image' },
    })
    const conv = (updated['conversations'] as Array<Record<string, unknown>>)[0]
    expect(conv.last_message_text).toBe('[image]')
  })

  it('dispara automações de conteúdo quando nenhum flow consome', async () => {
    await processInboundMessage({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      message: baseMessage,
    })
    const triggers = vi.mocked(runAutomationsForTrigger).mock.calls.map((c) => c[0].triggerType)
    expect(triggers).toContain('new_message_received')
    expect(triggers).toContain('keyword_match')
  })

  it('suprime gatilhos de conteúdo quando um flow consome a mensagem', async () => {
    vi.mocked(dispatchInboundToFlows).mockResolvedValueOnce({ consumed: true })
    await processInboundMessage({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      message: baseMessage,
    })
    const triggers = vi.mocked(runAutomationsForTrigger).mock.calls.map((c) => c[0].triggerType)
    expect(triggers).not.toContain('new_message_received')
    expect(triggers).not.toContain('keyword_match')
  })

  it('não chama a IA quando um flow consumiu', async () => {
    vi.mocked(dispatchInboundToFlows).mockResolvedValueOnce({ consumed: true })
    await processInboundMessage({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      message: baseMessage,
    })
    expect(dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('não chama a IA em resposta interativa', async () => {
    await processInboundMessage({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      message: { ...baseMessage, contentType: 'interactive', interactiveReplyId: 'opt-a' },
    })
    expect(dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('persiste interactive_reply_id quando é toque em botão', async () => {
    await processInboundMessage({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      message: { ...baseMessage, contentType: 'interactive', contentText: 'Sim', interactiveReplyId: 'opt-a' },
    })
    const rows = inserted['messages'] as Array<Record<string, unknown>>
    expect(rows[0].interactive_reply_id).toBe('opt-a')
  })
})
```

- [ ] **Step 7: Rodar os testes novos**

Run: `npx vitest run src/lib/whatsapp/inbound.test.ts`
Esperado: PASS, 7/7.

- [ ] **Step 8: Rodar a suíte inteira — a prova de que a Meta não regrediu**

Run: `npx tsc --noEmit && npx vitest run`
Esperado: zero erros de tipo; suíte verde. **Nenhum teste existente pode ter
sido editado.** Se algum falhar, a extração mudou comportamento — corrija a
extração, não o teste.

- [ ] **Step 9: Commit**

```bash
git add src/lib/whatsapp/inbound.ts src/lib/whatsapp/inbound.test.ts src/app/api/whatsapp/webhook/route.ts
git commit -m "refactor(whatsapp): extract provider-agnostic inbound pipeline

processMessage lived inside the Meta webhook route and spoke Meta's
payload shape. It now takes a NormalizedInboundMessage, so a second
provider can feed the same contact/conversation/automation/flow/AI
pipeline without duplicating it. Meta behaviour is unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Rotear os envios por `provider.ts`

**Files:**
- Modify: `src/lib/whatsapp/send-message.ts`
- Modify: `src/lib/automations/meta-send.ts`
- Modify: `src/lib/flows/meta-send.ts`
- Test: `src/lib/whatsapp/send-message.test.ts`, `src/lib/automations/meta-send.test.ts`, `src/lib/flows/meta-send.test.ts`

**Interfaces:**
- Consumes: `sendText(config, { to, text, contextMessageId? })` e
  `sendMedia(config, { to, kind, link, caption?, filename?, contextMessageId? })`
  de `src/lib/whatsapp/provider.ts`, ambos devolvendo `{ messageId: string }`.
- Produces: envio funcionando nos dois provedores para texto e mídia.

> Contexto que economiza tempo: os três arquivos hoje têm um guard
> `if (config.provider !== 'meta' || !config.access_token) → erro` adicionado
> na Fase 2. Esta task **substitui** esse guard por roteamento nos caminhos de
> texto e mídia. Os guards de templates/interativos/broadcast/reações ficam
> como estão — recusar é o comportamento desejado lá.

- [ ] **Step 1: Escrever o teste que falha em `send-message.test.ts`**

```ts
it('roteia envio de texto para UAZAPI quando a conta usa esse provedor', async () => {
  const uazapiConfig = {
    ...BASE_CONFIG,
    provider: 'uazapi',
    phone_number_id: null,
    access_token: null,
    uazapi_instance_token: encrypt('tok-instancia'),
  }
  const calls: Array<{ url: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ messageid: 'UAZ-1' }) }
  }))

  await sendMessageToConversation({ ...baseParams, config: uazapiConfig })

  expect(calls[0].url).toContain('/send/text')
  expect(calls[0].body).toMatchObject({ number: expect.any(String), text: expect.any(String) })
})
```

> Ajuste `BASE_CONFIG` / `baseParams` aos nomes que o arquivo já usa — não
> invente fixtures novas se as existentes servem.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp/send-message.test.ts`
Esperado: FAIL com a mensagem do guard atual (`wrong_provider` / "Meta sends
are unavailable").

- [ ] **Step 3: Substituir o guard por roteamento em `send-message.ts`**

Troque o bloco do guard (`if (config.provider !== 'meta' || !config.access_token) { throw new SendMessageError('wrong_provider', …) }`)
e a chamada direta a `meta-api` por:

```ts
import { sendText as providerSendText, sendMedia as providerSendMedia } from './provider'
```

```ts
  // Roteamento por provedor. provider.ts decide entre meta-api.ts e
  // uazapi-api.ts e cuida de decifrar a credencial certa; este arquivo
  // não precisa mais saber qual coluna pertence a quem.
  //
  // Recursos exclusivos da Meta (templates, interativos) continuam
  // barrados nos seus próprios call sites — só texto e mídia roteiam.
  if (config.provider !== 'meta' && config.provider !== 'uazapi') {
    throw new SendMessageError(
      'wrong_provider',
      `Unknown WhatsApp provider "${config.provider}".`,
      400
    )
  }
  if (config.provider === 'meta' && !config.access_token) {
    throw new SendMessageError(
      'not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    )
  }
  if (config.provider === 'uazapi' && !config.uazapi_instance_token) {
    throw new SendMessageError(
      'not_configured',
      'UAZAPI instance not configured. Paste the instance token in Settings.',
      400
    )
  }
```

E onde hoje chama `sendTextMessage({ phoneNumberId, accessToken, … })`, use
`providerSendText(config, { to, text, contextMessageId })`. Idem para mídia com
`providerSendMedia(config, { to, kind, link, caption, filename, contextMessageId })`.

> O `decrypt(config.access_token)` e o self-heal de ciphertext legado (bloco
> `isLegacyFormat`) só fazem sentido para Meta — mantenha-os **dentro** de um
> `if (config.provider === 'meta')`, não os apague.

- [ ] **Step 4: Rodar os testes do arquivo**

Run: `npx vitest run src/lib/whatsapp/send-message.test.ts`
Esperado: PASS, incluindo os testes Meta já existentes, sem editá-los.

- [ ] **Step 5: Repetir em `automations/meta-send.ts`**

Mesmo padrão. Adicione antes o teste:

```ts
it('envia por UAZAPI quando a conta usa esse provedor', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    return { ok: true, status: 200, json: async () => ({ messageid: 'UAZ-1' }) }
  }))
  await sendViaMeta({
    ...baseArgs,
    config: { ...baseArgs.config, provider: 'uazapi', access_token: null, uazapi_instance_token: encrypt('tok') },
  })
  expect(calls[0]).toContain('/send/text')
})
```

> Ajuste o nome da função exportada ao que o arquivo realmente exporta.

- [ ] **Step 6: Repetir em `flows/meta-send.ts` (3 call sites)**

O arquivo tem `assertMetaConfig(config)` chamado em três pontos, cada um antes
de um `decrypt`. Substitua os três pelo roteamento via `provider.ts`, do mesmo
modo. Adicione um teste equivalente ao do Step 5 em `flows/meta-send.test.ts`.

- [ ] **Step 7: Suíte inteira**

Run: `npx tsc --noEmit && npx vitest run`
Esperado: verde. Se um teste Meta quebrou, é regressão real.

- [ ] **Step 8: Commit**

```bash
git add src/lib/whatsapp/send-message.ts src/lib/whatsapp/send-message.test.ts src/lib/automations/meta-send.ts src/lib/automations/meta-send.test.ts src/lib/flows/meta-send.ts src/lib/flows/meta-send.test.ts
git commit -m "feat(whatsapp): route text and media sends through the provider layer

provider.ts shipped in Fase 1 with no production callers. The three send
call sites now go through it, so a UAZAPI-connected account can send.
Meta-only features (templates, interactive, broadcast, reactions) keep
their existing provider guards — refusing there is intended.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Rota de webhook UAZAPI (só registra e loga) + registro + **captura do payload real**

Esta task existe por causa da Fase 1. Ela **não escreve parser nenhum** — ela
publica um receptor que loga o payload cru, e termina com você mandando uma
mensagem de verdade para capturar a forma real. A Task 4 escreve o parser
contra o que foi capturado.

**Files:**
- Modify: `src/lib/whatsapp/uazapi-api.ts`
- Create: `src/app/api/whatsapp/uazapi/webhook/route.ts`
- Modify: `src/app/api/whatsapp/uazapi/connect/route.ts`
- Test: `src/lib/whatsapp/uazapi-api.test.ts`

**Interfaces:**
- Consumes: `hashInstanceToken(token)` de `src/lib/whatsapp/uazapi-token.ts`.
- Produces:
  - `setWebhook({ token, url, events }): Promise<UazapiWebhookConfig>`
  - `POST /api/whatsapp/uazapi/webhook` — aceita e loga; sempre 200.

- [ ] **Step 1: Escrever o teste de `setWebhook`**

Em `src/lib/whatsapp/uazapi-api.test.ts`:

```ts
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
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp/uazapi-api.test.ts`
Esperado: FAIL — `setWebhook is not a function`.

- [ ] **Step 3: Implementar `setWebhook` em `uazapi-api.ts`**

```ts
/** Eventos que a UAZAPI sabe emitir. Só usamos os dois primeiros. */
export type UazapiWebhookEvent =
  | 'messages' | 'connection' | 'presence' | 'group' | 'chat' | 'poll' | 'label'

export interface UazapiWebhookConfig {
  id: string
  url: string
  enabled: boolean
  events: string[]
}

export interface SetWebhookArgs extends InstanceTokenArgs {
  /** URL pública. A UAZAPI não alcança localhost. */
  url: string
  events: UazapiWebhookEvent[]
}

/**
 * Registra (ou atualiza) o webhook da instância.
 *
 * Verificado ao vivo: é UPSERT, não create. Um POST com URL diferente
 * mantém o mesmo `id` e substitui a URL — existe no máximo uma entrada
 * por instância. Logo, chamar isto a cada conexão é idempotente e não
 * acumula webhooks órfãos.
 *
 * Também verificado: a resposta é um ARRAY de um elemento (a doc sugere
 * objeto), e `DELETE /webhook` não existe (405) — para desligar, poste
 * `{ url: '', events: [], enabled: false }`.
 */
export async function setWebhook(args: SetWebhookArgs): Promise<UazapiWebhookConfig> {
  const { token, url, events } = args
  const data = await uazapiFetch('/webhook', token, {
    method: 'POST',
    body: { url, events, enabled: true },
  })
  const first = Array.isArray(data) ? data[0] : null
  if (!first || typeof first !== 'object') {
    throw new Error('UAZAPI returned an unexpected response shape for setWebhook.')
  }
  const w = first as Record<string, unknown>
  return {
    id: typeof w.id === 'string' ? w.id : '',
    url: typeof w.url === 'string' ? w.url : '',
    enabled: w.enabled === true,
    events: Array.isArray(w.events) ? (w.events as string[]) : [],
  }
}
```

- [ ] **Step 4: Rodar os testes**

Run: `npx vitest run src/lib/whatsapp/uazapi-api.test.ts`
Esperado: PASS.

- [ ] **Step 5: Criar a rota receptora (só loga)**

`src/app/api/whatsapp/uazapi/webhook/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { hashInstanceToken } from '@/lib/whatsapp/uazapi-token'

export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * POST /api/whatsapp/uazapi/webhook
 *
 * PRIMEIRA VERSÃO — DELIBERADAMENTE SÓ OBSERVA.
 *
 * A UAZAPI não assina os callbacks. A autenticação é o próprio `token`
 * da instância, que ela ecoa no corpo: procuramos a conta por
 * sha256(token) contra `uazapi_instance_token_hash`. Nada bate → 404,
 * sem revelar informação.
 *
 * Esta versão não interpreta a mensagem: ela loga o payload cru para
 * capturarmos a forma REAL antes de escrever qualquer parser. A Fase 1
 * inteira foi perdida por escrever cliente contra um contrato suposto
 * que os próprios mocks confirmavam. Task 4 escreve o parser contra o
 * que este log capturar.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // A doc da comunidade diz que o payload é flat e ecoa `token`. Não
  // verificamos isso ao vivo ainda — por isso aceitamos também `owner`
  // (número da própria instância) como chave alternativa, e logamos as
  // duas para a Task 4 saber qual existe de verdade.
  const token = typeof body.token === 'string' ? body.token : null
  const owner = typeof body.owner === 'string' ? body.owner : null

  let accountId: string | null = null
  if (token) {
    const { data } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('uazapi_instance_token_hash', hashInstanceToken(token))
      .maybeSingle()
    accountId = data?.account_id ?? null
  }
  if (!accountId && owner) {
    const { data } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('provider', 'uazapi')
      .eq('uazapi_connected_phone', owner)
      .maybeSingle()
    accountId = data?.account_id ?? null
  }

  // Log de captura. Nunca imprime o token — só se ele veio e se casou.
  console.log('[uazapi/webhook] RAW PAYLOAD', JSON.stringify({
    matchedAccount: accountId,
    routedBy: accountId ? (token ? 'token' : 'owner') : 'none',
    hasToken: token !== null,
    topLevelKeys: Object.keys(body),
    payload: redact(body),
  }))

  if (!accountId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json({ status: 'received' }, { status: 200 })
}

/** Remove o token do que vai para o log, preservando o resto da forma. */
function redact(body: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...body }
  if ('token' in copy) copy.token = '<redacted>'
  return copy
}
```

- [ ] **Step 6: Registrar o webhook ao conectar**

Em `src/app/api/whatsapp/uazapi/connect/route.ts`, depois do
`connectInstance` bem-sucedido e antes do `return`:

```ts
    // Registra o webhook desta conta na instância. Idempotente
    // (verificado: /webhook é upsert e mantém uma entrada só), então
    // rodar a cada conexão é seguro e conserta um registro perdido.
    //
    // A URL precisa ser pública — a UAZAPI não alcança localhost. Em
    // desenvolvimento sem túnel isto falha, e falhar aqui NÃO pode
    // impedir a conexão: logamos e seguimos.
    const publicBase = process.env.NEXT_PUBLIC_SITE_URL
    if (publicBase) {
      try {
        await setWebhook({
          token: loaded.token,
          url: `${publicBase.replace(/\/$/, '')}/api/whatsapp/uazapi/webhook`,
          events: ['messages', 'connection'],
        })
      } catch (err) {
        console.error(
          '[uazapi/connect] webhook registration failed (connection still OK):',
          err instanceof Error ? err.message : err
        )
      }
    } else {
      console.warn('[uazapi/connect] NEXT_PUBLIC_SITE_URL unset — webhook not registered')
    }
```

Acrescente `setWebhook` ao import de `@/lib/whatsapp/uazapi-api`.

- [ ] **Step 7: Verificar build e suíte**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Esperado: verde; a rota `/api/whatsapp/uazapi/webhook` aparece na listagem.

- [ ] **Step 8: Commit**

```bash
git add src/lib/whatsapp/uazapi-api.ts src/lib/whatsapp/uazapi-api.test.ts src/app/api/whatsapp/uazapi/webhook/route.ts src/app/api/whatsapp/uazapi/connect/route.ts
git commit -m "feat(whatsapp): add UAZAPI webhook receiver and registration

The receiver deliberately only logs the raw payload for now. UAZAPI's
inbound shape has never been verified against the real server, and Fase 1
was lost to writing a client against an assumed contract that its own
mocks agreed with. The parser lands in the next task, written against
what this captures.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 9: ⛔ CHECKPOINT MANUAL — publicar e capturar o payload real**

Esta etapa **não é código**. Ela precisa acontecer antes da Task 4, e precisa de
uma pessoa.

1. Enviar o trabalho: `git push origin main`
2. Publicar na Hostinger (o deploy do projeto).
3. Confirmar que `NEXT_PUBLIC_SITE_URL` está definido no ambiente publicado,
   apontando para o domínio real (ex.: `https://ballicrm.com`).
4. No CRM publicado, em Configurações → WhatsApp → QR Code (UAZAPI), clicar em
   **Conectar** (ou reconectar) para disparar o registro do webhook.
5. Confirmar o registro:
   ```bash
   curl -s -X GET "https://balligroup.uazapi.com/webhook" \
     -H "token: <INSTANCE_TOKEN>"
   ```
   Esperado: `enabled: true` e `url` apontando para o domínio publicado.
6. **Do seu celular pessoal, mandar uma mensagem de texto** para o número
   conectado (+55 21 98437-9771).
7. Abrir os logs do servidor publicado e copiar a linha
   `[uazapi/webhook] RAW PAYLOAD`.
8. Repetir mandando **uma foto com legenda** e **um áudio**, capturando os três
   payloads.
9. Salvar os três JSONs em
   `docs/superpowers/specs/uazapi-inbound-payloads.md` e commitar. **Este
   arquivo é a entrada da Task 4.**

Esperado: `routedBy: "token"` (confirma que o roteamento por token funciona) e
`matchedAccount` preenchido. Se vier `routedBy: "owner"`, o payload **não** tem
`token` — anote isso, porque muda o roteamento definitivo da Task 4.

---

## Task 4: Parser de entrada da UAZAPI (texto e interativo)

**Files:**
- Create: `src/lib/whatsapp/uazapi-inbound.ts`
- Create: `src/lib/whatsapp/uazapi-inbound.test.ts`
- Modify: `src/app/api/whatsapp/uazapi/webhook/route.ts`

**Interfaces:**
- Consumes: `NormalizedInboundMessage`, `NormalizedInboundReaction`,
  `InboundContentType`, `processInboundMessage`, `processInboundReaction`
  (Task 1); os payloads capturados na Task 3.
- Produces:
  - `parseUazapiInbound(payload: unknown): ParsedUazapiInbound | null`
  - `type ParsedUazapiInbound = { kind: 'message'; message: NormalizedInboundMessage } | { kind: 'reaction'; reaction: NormalizedInboundReaction }`

> **Pré-requisito obrigatório:** `docs/superpowers/specs/uazapi-inbound-payloads.md`
> existe e contém pelo menos o payload de texto capturado ao vivo. Se não
> existir, **pare** e conclua o checkpoint da Task 3. Escrever este parser sem
> ele repete exatamente o erro da Fase 1.

- [ ] **Step 1: Escrever os testes contra os payloads capturados**

Crie `src/lib/whatsapp/uazapi-inbound.test.ts`. **Cole o payload real
capturado** como fixture — não invente um. O exemplo abaixo usa a forma que a
documentação da comunidade descreve; substitua campo a campo pelo que o arquivo
de captura mostrar, e ajuste as asserções.

```ts
import { describe, it, expect } from 'vitest'
import { parseUazapiInbound } from './uazapi-inbound'

// ⚠️ SUBSTITUA por docs/superpowers/specs/uazapi-inbound-payloads.md
const textPayload = {
  owner: '5521984379771',
  instanceName: 'Novo Rio',
  token: 'b0223b8a-f1e5-4d2e-9894-dbfc53c1dec9',
  chat: { phone: '5511999998888', name: 'Cliente Teste', owner: '5521984379771' },
  message: {
    messageid: 'ABC123',
    chatid: '5511999998888@s.whatsapp.net',
    sender: '5511999998888@s.whatsapp.net',
    sender_pn: '5511999998888',
    owner: '5521984379771',
    fromMe: false,
    isGroup: false,
    type: 'conversation',
    text: 'oi tudo bem',
    timestamp: 1785000000,
  },
}

describe('parseUazapiInbound', () => {
  it('extrai uma mensagem de texto', () => {
    const r = parseUazapiInbound(textPayload)
    expect(r?.kind).toBe('message')
    if (r?.kind !== 'message') throw new Error('esperava message')
    expect(r.message.providerMessageId).toBe('ABC123')
    expect(r.message.from).toBe('5511999998888')
    expect(r.message.contactName).toBe('Cliente Teste')
    expect(r.message.contentType).toBe('text')
    expect(r.message.contentText).toBe('oi tudo bem')
  })

  // Armadilha documentada: `sender` pode vir como @lid (id interno do
  // WhatsApp) em vez do telefone. `sender_pn` é o número de verdade.
  it('prefere sender_pn quando sender vem como @lid', () => {
    const r = parseUazapiInbound({
      ...textPayload,
      message: { ...textPayload.message, sender: '123456789@lid', sender_pn: '5511777776666' },
    })
    if (r?.kind !== 'message') throw new Error('esperava message')
    expect(r.message.from).toBe('5511777776666')
  })

  // Armadilha documentada: timestamp vem em segundos OU milissegundos.
  it('aceita timestamp em segundos e em milissegundos', () => {
    const seg = parseUazapiInbound({ ...textPayload, message: { ...textPayload.message, timestamp: 1785000000 } })
    const ms = parseUazapiInbound({ ...textPayload, message: { ...textPayload.message, timestamp: 1785000000000 } })
    if (seg?.kind !== 'message' || ms?.kind !== 'message') throw new Error('esperava message')
    expect(seg.message.sentAt.getTime()).toBe(ms.message.sentAt.getTime())
  })

  // Nossa própria mensagem ecoada de volta não pode virar mensagem
  // recebida — duplicaria a thread.
  it('ignora mensagens enviadas por nós (fromMe)', () => {
    expect(parseUazapiInbound({ ...textPayload, message: { ...textPayload.message, fromMe: true } })).toBeNull()
  })

  it('ignora mensagens de grupo', () => {
    expect(parseUazapiInbound({ ...textPayload, message: { ...textPayload.message, isGroup: true } })).toBeNull()
  })

  it('devolve null para payload sem mensagem (ex.: evento connection)', () => {
    expect(parseUazapiInbound({ owner: '55', instanceName: 'x', token: 't' })).toBeNull()
  })

  it('mapeia resposta de botão para interactive', () => {
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
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp/uazapi-inbound.test.ts`
Esperado: FAIL — `parseUazapiInbound is not a function`.

- [ ] **Step 3: Implementar o parser**

```ts
/**
 * Parser do payload de entrada da UAZAPI → forma normalizada.
 *
 * Puro de propósito: sem banco, sem rede. Toda decisão que precise de
 * I/O (baixar mídia) fica na rota. Isso é o que torna o parser testável
 * contra payloads capturados de verdade.
 *
 * Armadilhas confirmadas em integrações reais, todas cobertas aqui:
 *   - `owner`, nos três níveis, é o número da PRÓPRIA instância, nunca
 *     o remetente nem o dono de um grupo.
 *   - `sender` pode vir como `<id>@lid`; o número real está em
 *     `sender_pn`.
 *   - `type` costuma vir genérico ('media'); o tipo real está em
 *     `mediaType`.
 *   - `timestamp` pode ser segundos ou milissegundos.
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

/** Telefone da outra parte, só dígitos. */
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

export function parseUazapiInbound(payload: unknown): ParsedUazapiInbound | null {
  const p = payload as Record<string, unknown> | null
  const m = p?.message as Record<string, unknown> | undefined
  if (!m || typeof m !== 'object') return null

  // Eco da nossa própria mensagem, ou grupo: fora do escopo do CRM.
  if (m.fromMe === true) return null
  if (m.isGroup === true) return null

  const providerMessageId = str(m.messageid) || str(m.id)
  if (!providerMessageId) return null

  const from = senderPhone(m)
  if (!from) return null

  const chat = (p?.chat as Record<string, unknown> | undefined) ?? {}
  const contactName = str(chat.name) || str(m.senderName) || ''

  // Reação: vira estado, não mensagem.
  const messageType = str(m.messageType)
  if (messageType === 'ReactionMessage' || str(m.type) === 'reaction') {
    const target = str(m.reactionTargetId) || str((m.reaction as Record<string, unknown> | undefined)?.key)
    if (!target) return null
    return {
      kind: 'reaction',
      reaction: {
        from,
        contactName,
        targetProviderMessageId: target,
        emoji: str(m.text) || str(m.body) || '',
      },
    }
  }

  // Toque em botão / linha de lista.
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
        sentAt: toDate(m.timestamp),
        contentType: 'interactive',
        contentText: str(m.vote) || replyId || null,
        mediaUrl: null,
        interactiveReplyId: replyId || null,
        replyToProviderMessageId: str(m.quotedMessageId) || null,
        fallbackLabel: 'interactive',
      },
    }
  }

  const contentType = contentTypeOf(m)
  const text = str(m.text) || str(m.body) || str(m.caption) || null

  return {
    kind: 'message',
    message: {
      providerMessageId,
      from,
      contactName,
      sentAt: toDate(m.timestamp),
      contentType,
      contentText: text,
      // Mídia é resolvida pela rota (precisa de I/O). Task 5 preenche.
      mediaUrl: null,
      interactiveReplyId: null,
      replyToProviderMessageId: str(m.quotedMessageId) || null,
      fallbackLabel: contentType,
    },
  }
}
```

- [ ] **Step 4: Rodar os testes**

Run: `npx vitest run src/lib/whatsapp/uazapi-inbound.test.ts`
Esperado: PASS. **Se algum falhar por o payload real ter campo com outro nome,
corrija o parser — não o teste.** O teste carrega o payload de verdade.

- [ ] **Step 5: Ligar o parser à rota**

Em `src/app/api/whatsapp/uazapi/webhook/route.ts`, substitua o bloco de log +
`return` por processamento real, mantendo o log (agora reduzido) para
diagnóstico:

```ts
import { after } from 'next/server'
import { parseUazapiInbound } from '@/lib/whatsapp/uazapi-inbound'
import { processInboundMessage, processInboundReaction } from '@/lib/whatsapp/inbound'
```

```ts
  if (!accountId || !configOwnerUserId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const parsed = parseUazapiInbound(body)
  if (!parsed) {
    // Evento que não é mensagem (connection), eco nosso, ou grupo.
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  // Processa DEPOIS de responder, como o webhook da Meta faz: em
  // serverless a função pode ser congelada assim que a resposta sai, e
  // uma promise solta perderia as escritas. `after()` mantém viva.
  after(async () => {
    try {
      if (parsed.kind === 'reaction') {
        await processInboundReaction({ accountId, configOwnerUserId, reaction: parsed.reaction })
      } else {
        await processInboundMessage({ accountId, configOwnerUserId, message: parsed.message })
      }
    } catch (error) {
      console.error('[uazapi/webhook] processing failed:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
```

Amplie o `select` do lookup para trazer também o dono:
`.select('account_id, user_id')`, e guarde em `configOwnerUserId`.

- [ ] **Step 6: Suíte e build**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Esperado: verde.

- [ ] **Step 7: Commit**

```bash
git add src/lib/whatsapp/uazapi-inbound.ts src/lib/whatsapp/uazapi-inbound.test.ts src/app/api/whatsapp/uazapi/webhook/route.ts
git commit -m "feat(whatsapp): parse UAZAPI inbound messages into the shared pipeline

Parser written against payloads captured from the live server (see
docs/superpowers/specs/uazapi-inbound-payloads.md), not from docs.
Covers the confirmed traps: @lid senders, seconds-vs-milliseconds
timestamps, generic type with the real one in mediaType, and fromMe
echoes that would otherwise duplicate the thread.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Mídia recebida pelo UAZAPI

**Files:**
- Modify: `src/lib/whatsapp/uazapi-api.ts`
- Create: `src/app/api/whatsapp/uazapi/media/[messageId]/route.ts`
- Modify: `src/app/api/whatsapp/uazapi/webhook/route.ts`
- Test: `src/lib/whatsapp/uazapi-api.test.ts`

**Interfaces:**
- Consumes: `loadUazapiToken`, `resolveAccountId` de
  `src/lib/whatsapp/uazapi-account.ts`; `parseUazapiInbound` (Task 4).
- Produces: `downloadMessageMedia({ token, messageId }): Promise<{ fileUrl: string; mimeType: string }>`

- [ ] **Step 1: Escrever o teste de `downloadMessageMedia`**

```ts
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
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp/uazapi-api.test.ts`
Esperado: FAIL — `downloadMessageMedia is not a function`.

- [ ] **Step 3: Implementar em `uazapi-api.ts`**

```ts
export interface DownloadMediaArgs extends InstanceTokenArgs {
  /** `messageid` do payload de entrada. */
  messageId: string
}

/**
 * Resolve a URL do arquivo de uma mensagem de mídia recebida.
 *
 * Na v1 o arquivo vinha em base64 dentro do webhook, o que estourava o
 * limite de corpo da hospedagem e tirava "receber mídia" do escopo. Na
 * v2 o webhook traz só metadados e o arquivo é buscado aqui — a
 * requisição parte de nós, então não há limite de corpo de entrada.
 *
 * Usamos `fileURL`. A resposta também pode trazer `base64Data` (com
 * "Data" no fim — `base64` puro não existe e devolve undefined).
 */
export async function downloadMessageMedia(
  args: DownloadMediaArgs
): Promise<{ fileUrl: string; mimeType: string }> {
  const { token, messageId } = args
  const data = await uazapiFetch('/message/download', token, {
    method: 'POST',
    body: { id: messageId },
  })
  const d = data as Record<string, unknown>
  const fileUrl = typeof d?.fileURL === 'string' ? d.fileURL : ''
  if (!fileUrl) {
    throw new Error('UAZAPI returned no file url for this message.')
  }
  return {
    fileUrl,
    mimeType: typeof d.mimetype === 'string' ? d.mimetype : 'application/octet-stream',
  }
}
```

- [ ] **Step 4: Rodar os testes**

Run: `npx vitest run src/lib/whatsapp/uazapi-api.test.ts`
Esperado: PASS.

- [ ] **Step 5: Criar a rota de proxy**

`src/app/api/whatsapp/uazapi/media/[messageId]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { downloadMessageMedia } from '@/lib/whatsapp/uazapi-api'
import { resolveAccountId, loadUazapiToken } from '@/lib/whatsapp/uazapi-account'

/**
 * GET /api/whatsapp/uazapi/media/[messageId]
 *
 * Espelha /api/whatsapp/media/[mediaId] (o proxy da Meta): o navegador
 * nunca fala com o provedor direto, porque buscar o arquivo exige a
 * credencial da conta — que não pode ir para o cliente.
 *
 * A URL que a UAZAPI devolve é temporária, então não a persistimos: o
 * que fica em `messages.media_url` é o caminho desta rota, e ela
 * resolve o arquivo a cada leitura.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ messageId: string }> }
) {
  try {
    const { messageId } = await params
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'Your profile is not linked to an account.' }, { status: 403 })
    }

    const loaded = await loadUazapiToken(supabase, accountId)
    if ('error' in loaded) {
      return NextResponse.json({ error: 'UAZAPI not configured for this account' }, { status: 400 })
    }

    const { fileUrl, mimeType } = await downloadMessageMedia({
      token: loaded.token,
      messageId,
    })

    const upstream = await fetch(fileUrl)
    if (!upstream.ok) {
      return NextResponse.json({ error: 'Failed to fetch media' }, { status: 502 })
    }
    const buffer = await upstream.arrayBuffer()

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || mimeType,
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('[uazapi/media] failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 6: Apontar as mensagens de mídia para a rota**

No webhook UAZAPI, antes de chamar `processInboundMessage`, preencha
`mediaUrl` quando o tipo for de mídia:

```ts
  if (parsed.kind === 'message') {
    const t = parsed.message.contentType
    if (t === 'image' || t === 'video' || t === 'audio' || t === 'document') {
      // O arquivo é resolvido sob demanda pela rota de proxy; aqui só
      // gravamos o caminho. Assim uma URL temporária da UAZAPI nunca
      // vaza para o banco nem expira dentro de uma mensagem salva.
      parsed.message.mediaUrl = `/api/whatsapp/uazapi/media/${encodeURIComponent(parsed.message.providerMessageId)}`
    }
  }
```

- [ ] **Step 7: Suíte e build**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Esperado: verde; a rota de mídia aparece na listagem.

- [ ] **Step 8: Commit**

```bash
git add src/lib/whatsapp/uazapi-api.ts src/lib/whatsapp/uazapi-api.test.ts "src/app/api/whatsapp/uazapi/media/[messageId]/route.ts" src/app/api/whatsapp/uazapi/webhook/route.ts
git commit -m "feat(whatsapp): receive media over UAZAPI

The v2 webhook carries only metadata, so the file is fetched server-side
via /message/download and served through our own proxy — the temporary
UAZAPI URL never reaches the browser or the database.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Avisar na UI o que o UAZAPI não faz

**Files:**
- Modify: `src/components/settings/whatsapp-config-uazapi.tsx`
- Modify: `messages/pt.json`, `messages/en.json`, `messages/ko.json`

**Interfaces:**
- Consumes: o painel UAZAPI da Fase 2, que já usa
  `useTranslations('Settings.whatsapp.uazapi')`.

> Os servidores **já recusam** templates, interativos, broadcast e reações para
> contas UAZAPI (guards da Fase 2). Falta só o usuário saber disso antes de
> tentar, em vez de descobrir com uma mensagem de erro.

- [ ] **Step 1: Acrescentar as chaves nos três idiomas**

Em `messages/pt.json`, dentro de `Settings.whatsapp.uazapi`:

```json
"limitationsTitle": "O que não funciona nesta conexão",
"limitationsBody": "Modelos aprovados pela Meta, mensagens com botões, disparos em massa e reações são recursos da API oficial e não funcionam por QR Code. Texto e mídia funcionam normalmente.",
```

Em `messages/en.json`:

```json
"limitationsTitle": "What this connection can't do",
"limitationsBody": "Meta-approved templates, button messages, broadcasts and reactions are Official API features and don't work over QR Code. Text and media work normally.",
```

Em `messages/ko.json`:

```json
"limitationsTitle": "이 연결에서 불가능한 기능",
"limitationsBody": "Meta 승인 템플릿, 버튼 메시지, 대량 발송, 반응은 공식 API 전용이며 QR 코드 연결에서는 작동하지 않습니다. 텍스트와 미디어는 정상 작동합니다.",
```

- [ ] **Step 2: Mostrar o aviso quando conectado**

Em `whatsapp-config-uazapi.tsx`, dentro do bloco `state.connected`, logo depois
dos botões de Desconectar/Remover:

```tsx
                <div className="mt-4 rounded-md bg-muted p-3">
                  <p className="text-sm font-medium">{t('limitationsTitle')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('limitationsBody')}</p>
                </div>
```

- [ ] **Step 3: Conferir paridade das chaves**

```bash
node -e "
const p=require('./messages/pt.json').Settings.whatsapp.uazapi;
const e=require('./messages/en.json').Settings.whatsapp.uazapi;
const k=require('./messages/ko.json').Settings.whatsapp.uazapi;
const keys=o=>Object.keys(o).sort().join(',');
console.log('pt==en:', keys(p)===keys(e));
console.log('pt==ko:', keys(p)===keys(k));
"
```
Esperado: `true` nas duas linhas.

- [ ] **Step 4: Build**

Run: `npx tsc --noEmit && npm run build`
Esperado: verde.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/whatsapp-config-uazapi.tsx messages/
git commit -m "feat(settings): tell UAZAPI users which features are Meta-only

The servers already refuse templates, interactive, broadcast and
reactions for UAZAPI accounts. This surfaces it before the attempt
instead of after the error.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Verificação ao vivo

Sem mock. É o que a Fase 1 não teve.

**Files:** nenhum (verificação), exceto o registro final no design.

- [ ] **Step 1: Suíte e build**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Esperado: tudo verde, nenhum teste Meta editado durante o plano inteiro.

- [ ] **Step 2: Publicar**

```bash
git push origin main
```
Depois, publicar na Hostinger e confirmar que `NEXT_PUBLIC_SITE_URL` aponta
para o domínio real.

- [ ] **Step 3: Receber texto**

Do celular pessoal, mandar "teste recebimento" para o número conectado.
Esperado, em até ~10s: a conversa aparece na Caixa de entrada com o texto certo,
o nome do contato e o horário correto.

- [ ] **Step 4: Receber mídia**

Mandar uma foto com legenda e um áudio.
Esperado: a foto **renderiza** na bolha (não um quadrado vazio) e a legenda
aparece; o áudio toca. Se a imagem vier quebrada, olhe a resposta de
`/api/whatsapp/uazapi/media/<id>` no DevTools — 400 é config, 502 é a URL da
UAZAPI expirada.

- [ ] **Step 5: Enviar texto**

Responder pela Caixa de entrada do CRM.
Esperado: chega no celular; a bolha fica como enviada, sem erro.

- [ ] **Step 6: Enviar mídia**

Enviar uma imagem pelo CRM.
Esperado: chega no celular com a imagem correta.

- [ ] **Step 7: Automação ponta a ponta**

Criar uma automação com gatilho `new_message_received` e ação de responder
texto. Mandar mensagem do celular.
Esperado: a resposta automática chega — prova que o pipeline compartilhado
alimenta o motor de automações vindo do UAZAPI.

- [ ] **Step 8: Provar que a Meta não regrediu**

Numa conta configurada com Meta (uma segunda conta — a linha
`whatsapp_config` é uma por conta): enviar e receber uma mensagem.
Esperado: idêntico ao de antes desta fase.

- [ ] **Step 9: Conferir no banco**

```sql
SELECT m.content_type, m.sender_type, m.media_url IS NOT NULL AS tem_midia,
       m.message_id, c.account_id
FROM messages m
JOIN conversations c ON c.id = m.conversation_id
WHERE c.account_id = '<conta-uazapi>'
ORDER BY m.created_at DESC LIMIT 10;
```
Esperado: `sender_type` correto nos dois sentidos, `content_type` batendo com o
que foi enviado, `media_url` preenchido nas mídias.

- [ ] **Step 10: Registrar os contratos que só agora deram para verificar**

Atualizar o apêndice de
`docs/superpowers/specs/2026-08-03-uazapi-provider-design.md`: mover para
"verificado" o payload de entrada, o corpo de sucesso de `/send/text` e
`/send/media`, e o formato de `/message/download`. Anotar divergências novas.

- [ ] **Step 11: Commit final**

```bash
git add docs/superpowers/specs/2026-08-03-uazapi-provider-design.md docs/superpowers/specs/uazapi-inbound-payloads.md
git commit -m "docs(whatsapp): record Fase 3 live acceptance and inbound contracts

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Fora de escopo desta fase

Confirmado que ficam para depois, todos com o servidor já recusando:

- **Broadcast pelo UAZAPI** (`/sender/*`) — combina volume com risco de
  banimento do número; merece desenho próprio.
- **Botões/listas/enquetes pelo UAZAPI** (`/send/menu`) — funciona na v2, mas o
  formato é outro e a UI de interativos hoje fala o formato da Meta.
- **Templates** — construção da plataforma da Meta, sem equivalente.
- **Reações enviadas** (`/message/react`) — recebidas já entram pelo parser;
  enviar fica fora.
- **`msg_delay_min`/`max` configuráveis pela UI** — a instância já vem com 1-3s
  de fábrica, o que é um padrão sensato.
- **Mensagens de grupo** — o parser as descarta de propósito; o CRM é 1:1.
