# Suporte a segundo provedor de WhatsApp (UAZAPI) — Design

**Data:** 2026-08-03
**Status:** Aprovado para planejamento

## Objetivo

Permitir que cada conta do BalliCRM escolha, na tela de Configurações → WhatsApp,
entre dois provedores de conexão:

- **Meta** (API oficial do WhatsApp Cloud) — o que já existe hoje.
- **UAZAPI** (API não oficial) — conexão por QR Code, escaneado pelo celular.

O requisito inegociável é **não quebrar nada do que já funciona com a Meta**.
Contas existentes precisam continuar operando sem nenhuma ação do usuário.

## Modelo de operação da UAZAPI

A UAZAPI opera com um servidor que possui um `endpoint` e um `token` de
assinatura. Dentro dele criam-se **sessões** — uma por número de WhatsApp
conectado. Cada sessão tem um `session` (nome) e uma `sessionkey`.

**Decisão:** a assinatura é da BalliCRM, não do cliente final. O `endpoint` e o
`token` ficam em variáveis de ambiente do servidor (`UAZAPI_ENDPOINT`,
`UAZAPI_TOKEN`) e o app cria uma sessão por conta automaticamente. O cliente
nunca digita credenciais — vê apenas o botão "Conectar" e o QR Code.

Consequência: `session` e `sessionkey` são **gerados pelo app** (valores longos e
não adivinháveis), nunca escolhidos pelo usuário. Isso importa porque o
`session` vira parte da URL do webhook e funciona como sua autenticação.

## Restrições descobertas (verificadas)

Estas foram levantadas contra a documentação da UAZAPI e o código atual. Cada uma
teve efeito direto no desenho.

### 1. Mídia recebida chega em base64 dentro do webhook

Na Meta, a mensagem traz um `media_id` e o arquivo é baixado sob demanda
(`/api/whatsapp/media/[mediaId]`). Na UAZAPI, o arquivo vem embutido em base64 no
próprio payload.

A Vercel limita o corpo de requisições a ~4,5MB. Um vídeo de 16MB (teto do
WhatsApp, citado na doc da UAZAPI) vira ~21MB em base64 — **o webhook falha no
nível da plataforma**, sem chance de tratamento na aplicação. Imagens pequenas
passam; vídeos não passam nunca.

**Decisão:** mídia recebida fica **fora da v1**. Ver "Fora de escopo".

### 2. O pipeline de entrada está preso na rota da Meta

`src/app/api/whatsapp/webhook/route.ts` tem 1113 linhas. O miolo é
`processMessage` (linhas 560-828): resolve contato, resolve conversa, insere a
mensagem e despacha para os motores.

Atenuante: os despachos finais **já são módulos separados** e não precisam mudar
— `runAutomationsForTrigger`, `dispatchInboundToFlows`,
`dispatchInboundToAiReply`, `dispatchWebhookEvent`. O que está acoplado à Meta é
apenas o parsing do payload (`parseMessageContent`).

### 3. Restrições do schema atual

De `001_initial_schema.sql`:

- `phone_number_id TEXT NOT NULL` — precisa virar nullable (UAZAPI não tem esse conceito).
- `access_token TEXT NOT NULL` — idem.
- `status TEXT CHECK (status IN ('connected','disconnected'))` — estreito demais
  para os estados da UAZAPI (`notLogged`, `STARTING`, `inChat`,
  `disconnectedMobile`). Daí uma coluna separada em vez de alargar o CHECK.

De `013_whatsapp_config_phone_number_id_unique.sql`: a constraint
`UNIQUE(phone_number_id)` existe porque o webhook roteia por `phone_number_id`
usando `.single()` — duplicatas faziam o webhook **descartar toda mensagem
recebida em silêncio** (issue #136).

A constraint **pode permanecer**: o Postgres admite múltiplos NULLs numa
constraint UNIQUE, então linhas UAZAPI (com `phone_number_id` nulo) não colidem
entre si.

Pelo mesmo motivo da 013, `uazapi_session` precisa da sua própria constraint
UNIQUE — a rota de webhook da UAZAPI roteia por ela com o mesmo mecanismo.

### 4. Delay fixo de 5 segundos entre envios

Documentado pela UAZAPI. Um flow que envia 3 mensagens seguidas leva ~15s numa
conta UAZAPI e é praticamente instantâneo na Meta. Não inviabiliza nada, mas é
comportamento esperado e deve constar na UI (aviso na tela de conexão).

### 5. Recursos sem equivalente na UAZAPI

Templates aprovados pela Meta, mensagens interativas no formato Meta
(botões/listas), broadcast e reações. A UAZAPI tem `/sendButton` e `/sendList`,
mas a própria doc os marca como instáveis e observa que não funcionam se o
número estiver logado no WhatsApp Web.

**Decisão:** todos ficam exclusivos da Meta na v1.

## Escopo da v1

| Recurso | Meta | UAZAPI |
|---|---|---|
| Enviar texto | ✅ | ✅ |
| Enviar mídia (imagem, áudio, vídeo, documento) | ✅ | ✅ |
| Receber texto | ✅ | ✅ |
| Receber mídia | ✅ | ⛔ placeholder (fase 4) |
| Automações e Flows | ✅ | ✅ |
| Resposta automática por IA | ✅ | ✅ |
| Templates | ✅ | ⛔ bloqueado |
| Mensagens interativas (botões/listas) | ✅ | ⛔ bloqueado |
| Broadcast | ✅ | ⛔ bloqueado |
| Reações | ✅ | ⛔ bloqueado |

"Bloqueado" significa: escondido na UI **e** rejeitado no servidor com erro
explícito. As duas camadas, porque automações e a API pública v1 conseguem
disparar envios sem passar pela UI.

Envio de mídia é barato porque o `/sendImage` da UAZAPI aceita uma **URL**
(`path`) — que é exatamente o que já guardamos hoje no Supabase Storage.

## Arquitetura

### Dados

`whatsapp_config` continua **uma linha por conta** (invariante atual,
`UNIQUE(account_id)`). Migration `037_whatsapp_provider.sql`:

```
provider              TEXT NOT NULL DEFAULT 'meta'
                        CHECK (provider IN ('meta','uazapi'))
phone_number_id       → DROP NOT NULL
access_token          → DROP NOT NULL
uazapi_session        TEXT UNIQUE            -- gerado; roteia o webhook
uazapi_session_key    TEXT                   -- gerado; criptografado
uazapi_status         TEXT                   -- estado bruto da UAZAPI
uazapi_connected_phone TEXT                  -- número que escaneou o QR
```

O default `'meta'` garante que toda linha existente permaneça válida e se comporte
exatamente como hoje.

`uazapi_session_key` é criptografada com o mesmo `src/lib/whatsapp/encryption.ts`
que já protege o `access_token` da Meta (AES-GCM via `ENCRYPTION_KEY`).

Um CHECK de integridade garante que a linha esteja coerente com seu provedor:
`provider='meta'` exige `phone_number_id` e `access_token` não nulos;
`provider='uazapi'` exige `uazapi_session` e `uazapi_session_key` não nulos.

O tipo `WhatsAppConfig` em `src/types/index.ts` acompanha as colunas novas.

### Camada de provedor

Novo `src/lib/whatsapp/provider.ts`, expondo duas funções normalizadas:

```ts
sendText(config, { to, text, contextMessageId? })
sendMedia(config, { to, kind, link, caption?, filename? })
```

Por dentro, decide via `config.provider` entre `meta-api.ts` (comportamento atual,
inalterado) e o novo `src/lib/whatsapp/uazapi-api.ts`.

Os três pontos de envio passam a chamar essa camada **apenas para texto e mídia**:

- `src/lib/whatsapp/send-message.ts` (chat manual + API pública v1)
- `src/lib/automations/meta-send.ts`
- `src/lib/flows/meta-send.ts`

Templates, interativos, broadcast e reações continuam chamando `meta-api.ts`
diretamente e ganham um guard: se `config.provider !== 'meta'`, lançam
`SendMessageError` com código próprio e mensagem clara, em vez de falhar de forma
obscura contra a API errada.

O `uazapi-api.ts` é um client puro da API (sem acesso a banco), totalmente
testável com `fetch` mockado — mesmo padrão do `meta-api.ts`.

**Retry de variantes de telefone:** a lógica `phoneVariants` /
`isRecipientNotAllowedError` existe porque a Meta rejeita números conforme a
presença do dígito 9. A UAZAPI aceita vários formatos nativamente (documentado),
então esse retry se aplica **somente ao caminho Meta** e não é replicado.

### Entrada (webhook)

Extrair `processMessage` para `src/lib/whatsapp/inbound.ts`, com assinatura
recebendo uma **mensagem já normalizada** (provedor-agnóstica):

```ts
handleInboundMessage(accountId, {
  providerMessageId, fromPhone, senderName,
  contentType, contentText, mediaUrl,
  timestamp, replyToProviderId?
})
```

Essa função mantém, sem alteração de comportamento: resolução de contato (com o
dedupe existente), resolução de conversa, inserção em `messages` e o despacho
para flows → automações → IA → webhooks de saída, na ordem atual.

Duas rotas a alimentam:

- `/api/whatsapp/webhook` (existente) — parseia payload Meta, roteia por
  `phone_number_id`. Fica **funcionalmente idêntica**; só delega o miolo.
- `/api/whatsapp/webhook/uazapi/[session]` (nova) — parseia payload UAZAPI,
  roteia por `uazapi_session` extraído da URL.

A UAZAPI não assina os webhooks. A autenticação é o próprio `session` na URL, que
é longo e gerado aleatoriamente. A rota valida que a sessão existe e que o campo
`session` do corpo bate com o da URL; qualquer divergência retorna 404 sem
revelar informação.

Eventos tratados na rota UAZAPI:

- `RECEIVE_MESSAGE` → `handleInboundMessage`
- `MESSAGE_STATUS` → atualiza `messages.status` (mesma escada de estados de hoje)
- `STATUS_CONNECT` → atualiza `uazapi_status` e `uazapi_connected_phone`
- `QRCODE` → apenas log (ver "Fluxo de conexão por QR Code")

`uazapi_status` guarda o valor **verbatim** da UAZAPI (`notLogged`, `STARTING`,
`inChat`, `disconnectedMobile`, …), sem normalizar para um conjunto local. Mesma
escolha já feita para o status de templates da Meta: as distinções importam para
decidir o que a UI mostra, e colapsá-las perde informação de diagnóstico.

### Fluxo de conexão por QR Code

Novo endpoint `/api/whatsapp/uazapi/connect`:

1. Gera `session` e `sessionkey` aleatórios; grava a linha com
   `provider='uazapi'`, `uazapi_status='starting'`.
2. Chama `POST {endpoint}/start` com header `apitoken`, passando as quatro URLs de
   webhook (`wh_message`, `wh_status`, `wh_qrcode`, `wh_connect`) apontando para a
   rota nova desta conta.
3. Devolve o `session` à UI.

A UI então faz polling em `/api/whatsapp/uazapi/status`, que retorna o
`uazapi_status` e o QR Code corrente.

**O QR é buscado sob demanda** via `GET /getQrCode` a cada polling, e não lido do
webhook `wh_qrcode`. O motivo é que as rotas rodam em funções serverless sem
estado compartilhado: o webhook que receberia o QR e o `/status` que a UI consulta
caem em instâncias diferentes, então qualquer cache em memória funcionaria em
desenvolvimento e falharia de forma intermitente em produção. Buscar sob demanda é
stateless por construção.

O `wh_qrcode` ainda é registrado no `/start` (a API espera as quatro URLs), mas
não é load-bearing — serve só para log e diagnóstico.

O QR Code **nunca é persistido** em `whatsapp_config`: é efêmero, expira em
segundos e não há razão para guardar um blob base64 no banco.

Estados que a UI apresenta: gerando QR → aguardando leitura → conectado
(`inChat`) → desconectado.

### UI

`src/components/settings/whatsapp-config.tsx` tem 883 linhas e hoje é
inteiramente sobre a Meta. Em vez de inflá-lo com um segundo fluxo, ele é
dividido:

- `whatsapp-config.tsx` — passa a ser o container: carrega a linha, mostra o
  seletor de provedor e renderiza o painel correspondente.
- `whatsapp-config-meta.tsx` — o formulário atual, **movido sem alteração de
  lógica**.
- `whatsapp-config-uazapi.tsx` — o novo fluxo de QR Code.

Trocar de provedor numa conta já configurada exige confirmação explícita e
executa a limpeza da configuração anterior (incluindo `/close` da sessão UAZAPI,
quando aplicável) — reaproveitando o padrão do botão "Reset" que já existe.

Todos os textos novos entram em `messages/pt.json`, seguindo a convenção
`next-intl` já usada no arquivo.

## Plano de fases

Cada fase é entregável e verificável isoladamente, e nenhuma delas quebra o
caminho Meta.

### Fase 1 — Fundação (nenhuma mudança visível)

- Migration `037_whatsapp_provider.sql`
- Tipo `WhatsAppConfig` atualizado
- `src/lib/whatsapp/uazapi-api.ts` (client puro + testes unitários)
- `src/lib/whatsapp/provider.ts` (roteamento por provedor + testes)

Nenhum call site muda ainda. **Verificação:** suíte de testes passa; app se
comporta exatamente como antes.

### Fase 2 — Conexão por QR Code

- Endpoints `/api/whatsapp/uazapi/connect`, `/status`, `/disconnect`
- Rota de webhook nova tratando `QRCODE` e `STATUS_CONNECT`
- Divisão do componente de configurações + painel UAZAPI
- Traduções

Ao fim, uma conta consegue conectar um número por QR Code e ver o status — mas
ainda não troca mensagens. **Verificação:** conectar um número real de teste.

### Fase 3 — Mensagens

- Extração de `processMessage` para `inbound.ts` (a mudança mais sensível)
- Webhook UAZAPI tratando `RECEIVE_MESSAGE` e `MESSAGE_STATUS`
- Os três call sites de envio migrados para `provider.ts`
- Guards de provedor em templates, interativos, broadcast e reações
- Gating na UI dos recursos indisponíveis

**Verificação:** enviar e receber texto e mídia nos dois provedores; confirmar que
uma conta Meta existente segue idêntica.

## Testes

Seguindo o que já existe no repositório (Vitest, com `meta-api.test.ts` e
`send-message` como referência):

- `uazapi-api.test.ts` — cada endpoint com `fetch` mockado, incluindo tratamento
  dos códigos de erro documentados (400, 401, 404, 500).
- `provider.test.ts` — roteia para o client certo conforme `provider`; recusa
  recursos indisponíveis.
- `inbound.test.ts` — comportamento preservado após a extração; a mesma mensagem
  normalizada produz o mesmo resultado, venha de qual rota vier.
- Testes de regressão do caminho Meta permanecem intocados e devem continuar
  passando sem edição. Se algum precisar mudar, é sinal de regressão de
  comportamento — não de teste desatualizado.

## Riscos

**Sessões compartilhando uma assinatura.** Todos os clientes rodam na assinatura
UAZAPI da BalliCRM. A documentação é insistente sobre timeouts, consumo de RAM e
sessões que caem. É preciso confirmar com a UAZAPI quantas sessões simultâneas o
plano suporta e se uma sessão travada afeta as demais. Isso é premissa do
desenho, não detalhe operacional.

**Formato do payload de mídia recebida não determinado.** A collection só
exemplifica texto no webhook. Precisa de teste empírico contra uma sessão real —
mas como mídia recebida ficou fora da v1, isso não bloqueia nada: vira
pré-requisito da fase 4.

**Estabilidade inerente da API não oficial.** A UAZAPI depende do WhatsApp Web e
pode desconectar sozinha. A UI precisa deixar o estado de conexão sempre visível,
e não presumir que "conectou uma vez" significa "está conectado".

## Fora de escopo (fase 4 em diante)

- **Mídia recebida na UAZAPI.** Na v1, uma mídia recebida é gravada com seu
  `content_type` real (todos já permitidos pelo CHECK da tabela `messages`),
  `media_url` nulo e um `content_text` explicativo. Nada de constraint nova. Na
  fase 4, o arquivo será buscado server-side — sem o limite de corpo de entrada
  da Vercel — e enviado ao Supabase Storage.
- Broadcast pela UAZAPI. Provavelmente o pedido seguinte mais forte, mas combina
  o delay de 5s com risco de banimento do número; merece desenho próprio.
- Botões e listas pela UAZAPI, enquanto a própria doc os marcar como instáveis.
- Grupos, status/stories e demais endpoints da UAZAPI sem equivalente no CRM hoje.
