# Suporte a segundo provedor de WhatsApp (UAZAPI) — Design

**Data:** 2026-08-03
**Revisado:** 2026-08-03 (API v2 — ver "Revisão")
**Status:** Aprovado para planejamento

## Revisão — a API mudou de versão

A primeira versão deste documento foi escrita contra a **API v1 da UAZAPI**
(coleção Postman antiga: sessões, `sessionkey`, `/start`, `/getQrCode`). Ao
assinar o serviço e apontar para o servidor real
(`https://balligroup.uazapi.com`), descobrimos que:

- O repositório da v1 está **oficialmente descontinuado** desde setembro de
  2024 ("primeira versão, baseada na Baileys, não é mais utilizada").
- O servidor contratado roda a **v2 (uazapiGO)**. Nenhum dos cinco endpoints
  que o cliente da Fase 1 chama existe nele — todos respondem 405, o mesmo que
  uma rota inventada.
- O contrato da v2 foi validado contra o servidor real: `GET /instance/all` com
  o header `admintoken` responde `Invalid AdminToken Header`, o que confirma
  endpoint e nome do header.

As seções abaixo já refletem a v2. Três premissas do desenho original caíram, e
as três caíram **a favor** do projeto — estão marcadas com "⚠️ mudou na v2". O
código da Fase 1 (`uazapi-api.ts` e seus testes) precisa ser reescrito; a
migration, os tipos, a criptografia e a camada de roteamento continuam válidos.

## Objetivo

Permitir que cada conta do BalliCRM escolha, na tela de Configurações → WhatsApp,
entre dois provedores de conexão:

- **Meta** (API oficial do WhatsApp Cloud) — o que já existe hoje.
- **UAZAPI** (API não oficial) — conexão por QR Code, escaneado pelo celular.

O requisito inegociável é **não quebrar nada do que já funciona com a Meta**.
Contas existentes precisam continuar operando sem nenhuma ação do usuário.

## Modelo de operação da UAZAPI (v2)

A assinatura da BalliCRM é um servidor próprio (`UAZAPI_ENDPOINT`) com um
**admin token** (`UAZAPI_TOKEN`). Dentro dele criam-se **instâncias** — uma por
número de WhatsApp conectado.

Dois níveis de autenticação, ambos por header:

| Header | Escopo | Onde é usado |
|---|---|---|
| `admintoken` | assinatura inteira | `POST /instance/create`, `GET /instance/all`, `/globalwebhook` |
| `token` | uma instância | todo o resto (`/instance/*`, `/send/*`, `/webhook`, …) |

**Inversão importante em relação à v1:** nós **não** geramos mais as
credenciais. Quem cria a instância recebe de volta o `token` dela — e esse token
é o segredo daquela conexão.

### Decisão: o app não cria instâncias (o operador cola o token)

O `admintoken` **não entra no app**. A instância é criada no painel da UAZAPI e
o operador cola o **Instance Token** nas Configurações do CRM.

Motivos:

- A assinatura tem **1 vaga**. Automatizar a criação seria escrever — e manter —
  um caminho que roda no máximo uma vez, mais o tratamento do erro de vaga
  esgotada, cujo formato nem conhecemos.
- Mantém o `admintoken` (que controla a assinatura inteira) fora do banco e fora
  do código da aplicação. O que o CRM guarda é um token de escopo estreito: uma
  instância, revogável sozinha pelo painel.
- É o modelo da UI de referência do tutorial, e foi o que se provou na prática —
  a instância `Novo Rio` foi criada assim e conectou.

Custo aceito: um passo manual por conexão nova, feito por quem administra o CRM,
não pelo usuário final. Se a assinatura crescer para várias instâncias, criar
automaticamente volta à mesa — o `uazapi-api.ts` ganha uma função e o resto do
desenho não muda.

Depois de colado o token, o usuário só vê "Conectar" e o QR Code.

**Consequência para a variável de ambiente:** `UAZAPI_TOKEN` (o admin token)
deixa de ser necessário. Fica apenas `UAZAPI_ENDPOINT`, e mesmo ele só como
padrão — cada linha guarda o token da sua instância.

## Restrições descobertas (verificadas contra a v2)

### 1. ⚠️ Mudou na v2 — mídia recebida não vem no webhook

Na v1 o arquivo vinha embutido em base64 no corpo do webhook, o que estourava o
limite de ~4,5MB da Vercel e obrigou a tirar "receber mídia" do escopo.

Na v2 o webhook traz apenas metadados (`mediaType`, `messageid`). O arquivo é
buscado depois, server-side, com `POST /message/download`, que devolve
`fileURL` e opcionalmente `base64Data`. Sem limite de corpo de entrada, porque a
requisição parte de nós.

**Consequência:** receber mídia deixou de ser tecnicamente impeditivo. Continua
fora da Fase 2 (que é só conexão), mas passa a ser decisão de escopo da Fase 3 e
não mais um bloqueio.

Armadilha documentada: o campo é `base64Data`, **não** `base64`. Ler
`response.base64` devolve `undefined` sempre.

### 2. O pipeline de entrada está preso na rota da Meta

Inalterado pela troca de versão. `src/app/api/whatsapp/webhook/route.ts` tem
1113 linhas; o miolo é `processMessage` (linhas 560-828): resolve contato,
resolve conversa, insere a mensagem e despacha para os motores.

Atenuante: os despachos finais **já são módulos separados** e não precisam mudar
— `runAutomationsForTrigger`, `dispatchInboundToFlows`,
`dispatchInboundToAiReply`, `dispatchWebhookEvent`. O que está acoplado à Meta é
apenas o parsing do payload (`parseMessageContent`).

### 3. Restrições do schema atual

De `001_initial_schema.sql`:

- `phone_number_id TEXT NOT NULL` — precisa virar nullable (UAZAPI não tem esse conceito).
- `access_token TEXT NOT NULL` — idem.
- `status TEXT CHECK (status IN ('connected','disconnected'))` — estreito demais
  para os estados da UAZAPI. Daí uma coluna separada em vez de alargar o CHECK.

Tudo isso já foi feito na migration `037_whatsapp_provider.sql`, que está
aplicada. O que muda na v2 são os **nomes** das colunas — ver "Dados" abaixo.

De `013_whatsapp_config_phone_number_id_unique.sql`: a constraint
`UNIQUE(phone_number_id)` existe porque o webhook roteia por `phone_number_id`
usando `.single()` — duplicatas faziam o webhook **descartar toda mensagem
recebida em silêncio** (issue #136). A constraint **pode permanecer**: o
Postgres admite múltiplos NULLs numa constraint UNIQUE, então linhas UAZAPI não
colidem entre si.

### 4. ⚠️ Mudou na v2 — o atraso entre envios é configurável

A v1 impunha 5 segundos fixos entre mensagens. A v2 expõe
`POST /instance/updateDelaySettings` com `msg_delay_min` / `msg_delay_max`, e
cada `/send/*` aceita um `delay` próprio.

A instância real veio com `msg_delay_min: 1` e `msg_delay_max: 3` de fábrica —
valores que só fazem sentido em **segundos**, não nos milissegundos que a
documentação afirma. Tratar como segundos.

⚠️ **Armadilha verificada:** `/instance/updateDelaySettings` **não valida a
entrada**. Um `POST` com corpo `{}` responde 200 e zera silenciosamente os dois
campos — foi o que aconteceu ao sondar o endpoint, e teve de ser restaurado à
mão. O client deve sempre enviar os dois valores explicitamente, nunca um
parcial.

**Consequência:** o aviso na UI deixa de ser "esta conexão é lenta e você não
pode mudar isso" e passa a ser um valor com padrão sensato. Manter um atraso
diferente de zero continua sendo o certo — é o que reduz risco de banimento do
número —, mas agora é escolha nossa, não imposição.

### 5. ⚠️ Mudou na v2 — botões e listas funcionam

Na v1, `/sendButton` e `/sendList` eram marcados como instáveis pela própria
documentação. A v2 tem `POST /send/menu` (tipos `button`, `list`, `poll`,
`carousel`), com o formato de resposta do toque **confirmado contra payloads
reais**: `messageType: "ButtonsResponseMessage"` / `"ListResponseMessage"`, com
os campos `buttonOrListid` (id da opção) e `vote` (texto exibido).

**Consequência:** deixa de ser bloqueio técnico permanente. Continua fora do
escopo inicial por custo de implementação, não por instabilidade.

### 6. Recursos que seguem exclusivos da Meta

Templates aprovados pela Meta e o formato de mensagem interativa da Meta não têm
equivalente — são construções da plataforma oficial. Broadcast pela UAZAPI é
tecnicamente possível (`/sender/*`) mas combina volume com risco de banimento;
merece desenho próprio.

## Escopo

| Recurso | Meta | UAZAPI |
|---|---|---|
| Conectar por QR Code | — | ✅ Fase 2 |
| Enviar texto | ✅ | ✅ Fase 3 |
| Enviar mídia (imagem, áudio, vídeo, documento) | ✅ | ✅ Fase 3 |
| Receber texto | ✅ | ✅ Fase 3 |
| Receber mídia | ✅ | ⚙️ viável na v2 — decisão de escopo da Fase 3 |
| Automações e Flows | ✅ | ✅ Fase 3 |
| Resposta automática por IA | ✅ | ✅ Fase 3 |
| Templates | ✅ | ⛔ sem equivalente |
| Mensagens interativas (Meta) | ✅ | ⛔ sem equivalente (a UAZAPI tem `/send/menu`, formato próprio) |
| Broadcast | ✅ | ⏳ possível, desenho próprio |
| Reações | ✅ | ⏳ possível (`/message/react`), fora do escopo inicial |

"Sem equivalente" significa: escondido na UI **e** rejeitado no servidor com erro
explícito. As duas camadas, porque automações e a API pública v1 conseguem
disparar envios sem passar pela UI.

Envio de mídia é barato porque `POST /send/media` aceita uma **URL** no campo
`file` — que é exatamente o que já guardamos hoje no Supabase Storage.

## Arquitetura

### Dados

`whatsapp_config` continua **uma linha por conta** (invariante atual,
`UNIQUE(account_id)`).

A migration `037_whatsapp_provider.sql` já está aplicada e criou as colunas com
nomes da v1. Como nenhuma conta usa UAZAPI ainda (colunas vazias), uma migration
`038` renomeia para os conceitos corretos da v2:

```
provider                TEXT NOT NULL DEFAULT 'meta'
                          CHECK (provider IN ('meta','uazapi'))
phone_number_id         → nullable  (já feito na 037)
access_token            → nullable  (já feito na 037)

uazapi_session          → uazapi_instance_name    -- rótulo vindo da UAZAPI ("Novo Rio")
uazapi_session_key      → uazapi_instance_token   -- segredo, criptografado
uazapi_status           (mantém)                  -- instance.status bruto
uazapi_connected_phone  (mantém)                  -- instance.owner, só dígitos

+ uazapi_instance_token_hash  TEXT UNIQUE         -- novo, ver abaixo
```

`uazapi_instance_name` deixa de ser gerado por nós: é o `instance.name` que a
UAZAPI devolve, preenchido no painel na hora de criar a instância. Vira rótulo
de exibição, não identificador.

`uazapi_instance_token` é criptografado com o mesmo
`src/lib/whatsapp/encryption.ts` que já protege o `access_token` da Meta
(AES-GCM via `ENCRYPTION_KEY`).

O CHECK de coerência da 037 acompanha o rename: `provider='meta'` exige
`phone_number_id` e `access_token`; `provider='uazapi'` exige
`uazapi_instance_name` e `uazapi_instance_token`.

### Por que existe uma coluna de hash

Uma quarta coluna acompanha o rename:

```
uazapi_instance_token_hash  TEXT UNIQUE   -- SHA-256 hex do token cru
```

Ela existe porque **criptografia não serve para busca nem para unicidade**. O
`encrypt()` do projeto é AES-GCM com IV aleatório: o mesmo token gera um
ciphertext diferente a cada chamada. Consequências, as duas fatais se ignoradas:

- `UNIQUE(uazapi_instance_token)` **não impediria** duas contas de cadastrarem a
  mesma instância — os ciphertexts seriam diferentes e o Postgres os aceitaria
  como distintos.
- O webhook da Fase 3, que precisa achar a linha a partir do `token` que a
  UAZAPI ecoa no corpo, **não teria como consultar**: não dá para
  `WHERE uazapi_instance_token = encrypt(token)`.

SHA-256 é determinístico, então resolve os dois: é o alvo do `UNIQUE` e o índice
de lookup do webhook. O token cifrado continua sendo o que se decifra para
chamar a UAZAPI.

Não leva salt de propósito — salt por linha quebraria justamente o lookup. É
aceitável aqui porque o token é um UUID v4 gerado pela UAZAPI (122 bits de
entropia), não um segredo escolhido por humano: não há dicionário a percorrer.

O tipo `WhatsAppConfig` em `src/types/index.ts` acompanha.

### Camada de provedor

`src/lib/whatsapp/provider.ts` (já existe, Fase 1) segue válido em forma —
expõe `sendText(config, …)` e `sendMedia(config, …)` e decide entre
`meta-api.ts` e `uazapi-api.ts`. Só muda o que ele passa adiante: token da
instância em vez de `session` + `sessionkey`.

`src/lib/whatsapp/uazapi-api.ts` **precisa ser reescrito** contra a v2:

| Função | v2 | Fase |
|---|---|---|
| `getInstanceStatus({ token })` | `GET /instance/status` → `{ instance, status }` — também valida o token colado | 2 |
| `connectInstance({ token })` | `POST /instance/connect` → mesma forma + `qrcode` preenchido | 2 |
| `disconnectInstance({ token })` | `POST /instance/disconnect` | 2 |
| `setWebhook({ token, url, events })` | `POST /webhook` | 3 |
| `sendText({ token, number, text })` | `POST /send/text` | 3 |
| `sendMedia({ token, number, type, file, text? })` | `POST /send/media` — um endpoint só, `type` discrimina | 3 |

Sem `createInstance` e sem `deleteInstance`: a criação é manual no painel (ver
decisão acima), e apagar a instância é justamente o que **não** queremos que o
app faça com a única vaga da assinatura. "Desconectar" no CRM desloga o
telefone e mantém a instância viva para reconectar.

Como as respostas de `/instance/status` e `/instance/connect` compartilham a
mesma forma (`{ instance, status }`), as duas funções devolvem o mesmo tipo
`UazapiInstanceState` e reaproveitam um único parser.

Continua sendo um client puro (sem acesso a banco), testável com `fetch`
mockado — mesmo padrão do `meta-api.ts`.

**Formato do número:** só dígitos, sem `+`, sem espaços
(`555193667706` = país 55 + DDD 51 + número). O retry de variantes de telefone
(`phoneVariants` / `isRecipientNotAllowedError`) existe porque a Meta rejeita
números conforme o dígito 9; **não se aplica** ao caminho UAZAPI.

### Entrada (webhook)

Extrair `processMessage` para `src/lib/whatsapp/inbound.ts`, recebendo uma
mensagem já normalizada (provedor-agnóstica) — inalterado pela troca de versão.

O que muda é a configuração e o roteamento:

- **Registro:** na v1, as quatro URLs iam no `/start`. Na v2 é uma chamada
  separada, `POST /webhook` com `{ url, events: [...] }`. Eventos disponíveis:
  `messages`, `connection`, `presence`, `group`, `chat`, `poll`, `label`. A
  Fase 2 registra `connection`; a Fase 3 acrescenta `messages`.

- **Roteamento:** o payload da v2 é **flat** e ecoa o `token` da própria
  instância no corpo — feito justamente para identificar a origem quando um
  endpoint atende várias instâncias. A busca é
  `WHERE uazapi_instance_token_hash = sha256(payload.token)`, nunca pela coluna
  cifrada (ver "Por que existe uma coluna de hash").

Formato real do payload (confirmado contra integração em produção — **não** é o
`{event, instance, data}` que a página de docs sugere):

```
{
  owner: string,          // número da PRÓPRIA instância — não é dono de grupo
  instanceName: string,
  token: string,          // token desta instância, ecoado → chave de roteamento
  chat:    { phone?, name?, owner, wa_isGroup?, ... },
  message: { messageid, chatid, sender, sender_pn, owner, fromMe, isGroup,
             type, mediaType?, text?, body?, caption?, timestamp, ... }
}
```

Armadilhas documentadas, todas confirmadas em produção alheia:
- `owner` (nos três níveis) é sempre o número da instância, nunca o criador de
  um grupo.
- `sender` pode vir como `@lid`; para o número da outra parte prefira
  `sender_pn`.
- `message.type` costuma vir genérico (`"media"`); o tipo real está em
  `mediaType`.
- `timestamp` pode ser segundos ou milissegundos — checar magnitude
  (`> 1e12` = ms).

**Autenticação do webhook:** a UAZAPI não assina os callbacks. Usamos duas
camadas: um segredo gerado por nós no caminho da URL (que só a UAZAPI recebe,
via `POST /webhook`) **e** a conferência do `token` do corpo contra
`uazapi_instance_token`. Divergência em qualquer uma das duas → 404, sem revelar
informação.

### Fluxo de conexão por QR Code

Verificado ao vivo — ficou **mais simples** do que o desenho previa:

0. *(fora do app)* O operador cria a instância no painel da UAZAPI e copia o
   **Instance Token**.
1. Cola o token nas Configurações do CRM. Salvamos criptografado, depois de
   validar contra `GET /instance/status` — token inválido é recusado na hora,
   antes de gravar.
2. `POST /webhook` com o token da instância, apontando para a rota desta conta.
   *(Fase 3 — a Fase 2 não precisa de webhook.)*
3. `POST /instance/connect` → muda `instance.status` para `"connecting"` e
   devolve o primeiro QR.
4. A UI faz polling em `/api/whatsapp/uazapi/status`, que chama
   `GET /instance/status`.

**`GET /instance/status` devolve o QR junto com o estado.** O campo
`instance.qrcode` vem preenchido enquanto `status === "connecting"`, e a própria
UAZAPI o **rotaciona sozinha** — confirmado por polling: o hash do QR mudou
entre a segunda e a terceira leitura, sem nenhuma chamada extra da nossa parte.

Consequência prática: **`/instance/connect` é chamado uma vez só**. Não existe
"renovar QR" — a UI só re-renderiza o `qrcode` que cada polling traz. Isso
elimina a rota de refresh que o desenho anterior previa.

Continua valendo o motivo de não usar webhook para o QR: as rotas rodam em
funções serverless sem estado compartilhado, então o webhook que receberia o QR
e o `/status` que a UI consulta caem em instâncias diferentes; qualquer cache em
memória funcionaria em desenvolvimento e falharia de forma intermitente em
produção. Pedir sob demanda é stateless por construção.

O `qrcode` já vem como **data URI completo** (`data:image/png;base64,…`, ~1,8KB)
— vai direto no `<img src>`, sem concatenar prefixo. É efêmero e **nunca é
persistido** em `whatsapp_config`.

Conectado é `status.connected && status.loggedIn`. O `instance.status` textual
(`disconnected` → `connecting` → conectado) é o que se mostra ao usuário.

Estados que a UI apresenta: gerando QR → aguardando leitura → conectado →
desconectado.

Distinção que importa: `POST /instance/disconnect` desloga o telefone mas
mantém a instância (dá para reconectar lendo um QR novo). `DELETE /instance`
apaga de vez e **libera a vaga na assinatura** — é o que o botão "Reset"
precisa chamar, dado o limite de 1 instância.

### UI

`src/components/settings/whatsapp-config.tsx` tem 883 linhas e hoje é
inteiramente sobre a Meta. Em vez de inflá-lo com um segundo fluxo, ele é
dividido:

- `whatsapp-config.tsx` — container: carrega a linha, mostra o seletor de
  provedor e renderiza o painel correspondente.
- `whatsapp-config-meta.tsx` — o formulário atual, **movido sem alteração de
  lógica**.
- `whatsapp-config-uazapi.tsx` — o novo fluxo de QR Code.

Trocar de provedor numa conta já configurada exige confirmação explícita e
executa a limpeza da configuração anterior (incluindo `DELETE /instance` quando
aplicável, para não desperdiçar a única vaga da assinatura) — reaproveitando o
padrão do botão "Reset" que já existe.

Todos os textos novos entram em `messages/pt.json`, `en.json` e `ko.json`,
seguindo a convenção `next-intl` já usada nos arquivos.

## Plano de fases

Cada fase é entregável e verificável isoladamente, e nenhuma delas quebra o
caminho Meta.

### Fase 1 — Fundação ✅ entregue, ⚠️ parcialmente inválida

Entregue e mesclada na `main`:
- Migration `037_whatsapp_provider.sql` (aplicada) — **válida**
- Tipo `WhatsAppConfig` — válido, precisa acompanhar o rename da 038
- `src/lib/whatsapp/provider.ts` — estrutura válida, chamadas a ajustar
- `src/lib/whatsapp/uazapi-api.ts` — **inválido**, escrito contra a v1

Os testes passavam porque o `fetch` estava mockado: os mocks codificavam o
contrato errado. Nada no app chamava esse código ainda, então não houve impacto
em produção — mas é a lição a registrar: teste com mock valida o nosso lado da
conversa, nunca o do outro.

### Fase 2 — Conexão por QR Code (v2)

- Reescrita de `uazapi-api.ts` contra a v2 + testes
- Migration `038` renomeando as colunas
- Endpoints `/api/whatsapp/uazapi/connect`, `/status`, `/disconnect`
- Rota de webhook nova tratando o evento `connection`
- Divisão do componente de configurações + painel UAZAPI
- Traduções

Ao fim, uma conta consegue conectar um número por QR Code e ver o status — mas
ainda não troca mensagens. **Verificação:** conectar um número real de teste.

### Fase 3 — Mensagens

- Extração de `processMessage` para `inbound.ts` (a mudança mais sensível)
- Webhook UAZAPI tratando o evento `messages`
- Os três call sites de envio migrados para `provider.ts`
- Guards de provedor em templates, interativos, broadcast e reações
- Gating na UI dos recursos indisponíveis
- Decisão de escopo: incluir ou não mídia recebida (agora viável)

**Verificação:** enviar e receber texto e mídia nos dois provedores; confirmar
que uma conta Meta existente segue idêntica.

## Testes

Seguindo o que já existe no repositório (Vitest, com `meta-api.test.ts` e
`send-message` como referência):

- `uazapi-api.test.ts` — cada endpoint com `fetch` mockado, incluindo tratamento
  dos códigos de erro documentados (400, 401, 404, 500).
- `provider.test.ts` — roteia para o client certo conforme `provider`; recusa
  recursos indisponíveis.
- `inbound.test.ts` — comportamento preservado após a extração.
- Testes de regressão do caminho Meta permanecem intocados e devem continuar
  passando sem edição. Se algum precisar mudar, é sinal de regressão de
  comportamento — não de teste desatualizado.

**Regra nova, aprendida com a Fase 1:** todo contrato com a UAZAPI precisa de ao
menos uma verificação contra o servidor real antes de a fase ser dada como
concluída. Mock não descobre que o endpoint não existe.

## Riscos

**Uma vaga de instância só.** Resolvido como premissa: a assinatura atual
comporta 1. Enquanto for assim, UAZAPI é recurso de uma conta por vez, e a UI
precisa explicar isso quando o `/instance/create` recusar.

**Estabilidade inerente da API não oficial.** A UAZAPI depende do WhatsApp Web e
pode desconectar sozinha. A UI precisa deixar o estado de conexão sempre
visível, e não presumir que "conectou uma vez" significa "está conectado".

**Documentação de terceiros.** O contrato da v2 veio de uma referência mantida
pela comunidade, e a sondagem ao vivo já mostrou **três divergências** em
relação a ela (ver apêndice): `/instance/all` devolve array cru, `GET /webhook`
devolve `null`, e os delays estão em segundos e não em milissegundos. A
documentação serve para achar o endpoint; o contrato é o que o servidor
responde. Cada endpoint novo deve ser conferido ao vivo antes de virar código.

## Fora de escopo

- Broadcast pela UAZAPI (`/sender/*`) — combina volume com risco de banimento do
  número; desenho próprio.
- `/send/menu` (botões, listas, enquetes, carrossel) — viável, custo próprio.
- Grupos, status/stories, catálogo e demais endpoints sem equivalente no CRM.

---

## Apêndice — contratos verificados ao vivo

Sondado em 2026-08-04 contra `https://balligroup.uazapi.com`, instância
`Novo Rio` (`id: r76b15a4a3614b4`). **Esta seção é a fonte da verdade** — onde
divergir da documentação da UAZAPI, vale o que está aqui.

### Rotas confirmadas

| Rota | Header | Resultado |
|---|---|---|
| `GET /instance/all` | `admintoken` | 200 |
| `GET /instance/status` | `token` | 200 |
| `POST /instance/connect` | `token` | 200 |
| `GET /webhook` | `token` | 200 |
| `POST /send/text` | `token` | 400 com corpo vazio → rota existe |
| `POST /send/media` | `token` | 400 com corpo vazio → rota existe |
| `POST /send/menu` | `token` | 400 com corpo vazio → rota existe |
| `POST /message/download` | `token` | 503 (instância desconectada) → rota existe |
| `POST /instance/updateDelaySettings` | `token` | 200 |

### Objeto `instance` (idêntico em todas as respostas que o incluem)

```jsonc
{
  "id": "r76b15a4a3614b4",
  "token": "…uuid v4, gerado pela UAZAPI…",
  "status": "disconnected" | "connecting" | /* conectado */,
  "paircode": "",             // alternativa ao QR (pareamento por código)
  "qrcode": "",               // data URI completo quando status = connecting
  "name": "Novo Rio",         // definido na criação
  "profileName": "", "profilePicUrl": "", "isBusiness": false,
  "plataform": "",            // sic — escrito errado na API
  "systemName": "balligroup", // ecoa o servidor da assinatura
  "owner": "",                // número da instância depois de conectada
  "current_presence": "unavailable",
  "lastDisconnect": "", "lastDisconnectReason": "",
  "adminField01": "", "adminField02": "",
  "openai_apikey": "", "chatbot_enabled": false, /* …campos do chatbot nativo… */
  "created": "2026-08-04 09:52:02.993Z",   // espaço, não "T" — não é ISO 8601
  "updated": "…", "currentTime": "…",
  "msg_delay_min": 1, "msg_delay_max": 3   // segundos
}
```

### Formas de resposta

**`GET /instance/status`** →
```jsonc
{ "instance": { … }, "status": { "connected": false, "jid": null,
                                 "loggedIn": false, "resetting": false } }
```

**`POST /instance/connect`** → mesma informação **duplicada em dois níveis**:
```jsonc
{ "connected": false, "instance": { …qrcode preenchido… }, "jid": null,
  "loggedIn": false, "response": "Connecting",
  "status": { "connected": false, "jid": null, "loggedIn": false } }
```
O `status` aninhado do `/connect` **não tem** `resetting`; o do `/status` tem.
Ler sempre pelo objeto `status` aninhado (comum às duas) e nunca pelos campos
de topo, que só existem no `/connect`.

**`GET /instance/all`** → **array cru** de objetos `instance`, sem envelope.
Não é `{ "instances": [...] }`.

**`GET /webhook`** → **`null`** quando nenhum webhook foi configurado. Não é
`{}` nem 404 — o client precisa tratar `null` explicitamente.

### Divergências em relação à documentação

1. `/instance/all` devolve array cru, não objeto com envelope.
2. `GET /webhook` devolve `null` literal quando não configurado.
3. `msg_delay_min`/`max` estão em **segundos** (padrão 1/3), não milissegundos.
4. `qrcode` já é data URI completo — a doc sugere base64 puro.
5. `/instance/updateDelaySettings` aceita corpo vazio e zera os valores.

### Comportamento do QR (medido)

Polling em `GET /instance/status` a cada 22s durante `connecting`:

```
t=0s   status=connecting  qrHash=d85366a4702f  len=1850
t=22s  status=connecting  qrHash=d85366a4702f  len=1850   ← mesmo QR
t=44s  status=connecting  qrHash=07bf1de4433c  len=1830   ← rotacionou sozinho
```

A UAZAPI rotaciona o QR por conta própria e o `/status` sempre entrega o
vigente. Polling de 3–5s na UI é suficiente e não exige nenhuma chamada extra.

### Estado conectado (verificado — número real escaneou o QR)

```jsonc
{
  "instance": {
    "status": "connected",
    "qrcode": "",                       // limpo ao conectar
    "owner": "5521984379771",           // ← número conectado, só dígitos, sem +
    "profileName": "Victor Corretor De Imóveis",
    "profilePicUrl": "https://pps.whatsapp.net/…",  // URL assinada, expira
    "isBusiness": true,
    "plataform": "smba",                // smba = WhatsApp Business Android
    "lastDisconnect": "2026-08-04 13:23:13.455Z",
    "lastDisconnectReason": "QR Code timeout",
    // ↓ campos que NÃO existem enquanto desconectado — aparecem só ao conectar
    "proxy_managed_country": "br",
    "proxy_managed_state": "rj",
    "proxy_managed_city": "riodejaneiro"
  },
  "status": { "connected": true, "loggedIn": true, "resetting": false,
              "jid": "5521984379771:1@s.whatsapp.net" }
}
```

Consequências para a implementação:

- **`instance.owner` é o que vai para `uazapi_connected_phone`** — já vem no
  formato que a UAZAPI espera em `number` nos envios (só dígitos). O `jid` é
  `<número>:<dispositivo>@s.whatsapp.net`; serve para logs, não para envio.
- `profileName`, `profilePicUrl` e `isBusiness` permitem a UI confirmar
  visualmente *qual* conta conectou — vale exibir, é o que evita o usuário
  conectar o número errado sem perceber. `profilePicUrl` é assinada e expira;
  não persistir.
- O objeto `instance` **muda de forma** entre desconectado e conectado (os três
  `proxy_managed_*` só surgem depois). Tipar esses campos como opcionais.

### Expiração do QR (verificada)

A janela de `connecting` **expira sozinha**: a instância volta a
`disconnected` e registra `lastDisconnectReason: "QR Code timeout"`. Observado
num polling de ~10 minutos sem escaneamento.

A UI precisa tratar isso: se o polling vir `status` voltar para `disconnected`
durante a espera, mostrar "o QR expirou" e oferecer o botão de tentar de novo
(que rechama `/instance/connect`). Sem isso a tela fica exibindo um QR morto
para sempre.

`lastDisconnectReason` é bom material de diagnóstico e vale exibir quando a
conexão cair.

### Ainda não verificado

- `POST /instance/create` — não sondado: a assinatura tem **1 vaga** e ela está
  ocupada pela instância `Novo Rio`. O erro de vaga esgotada também segue
  desconhecido; descobrir antes de escrever a mensagem de erro da UI.
- `DELETE /instance`, `POST /instance/disconnect` — destrutivos, não sondados.
  A instância agora está conectada a um número real; sondá-los derruba a
  conexão.
- `POST /webhook` (escrita) e o formato real do payload de callback.
- Corpo de sucesso de `/send/text` e `/send/media` (só sabemos que a rota
  valida entrada).
- Ciclo completo de `POST /instance/connect` → escanear QR novo → `/status`
  refletir `connected` pela tela do CRM (o aceite da Fase 2 usou uma instância
  já conectada; o fluxo de QR do zero foi validado antes, fora do app, na
  sondagem inicial dos contratos — não pelo painel).
- `POST /instance/disconnect` chamado pela rota do app (`/api/whatsapp/uazapi/disconnect`)
  — ainda não exercitado ponta a ponta.

### Verificação de aceite da Fase 2 (2026-08-04)

Rodado contra o servidor real, pela UI do CRM (não por sondagem direta):

1. **Colar token válido → Salvar** — `POST /api/whatsapp/uazapi/config` validou
   contra `GET /instance/status` e gravou. A tela mostrou o estado conectado
   imediatamente (a instância `Novo Rio` já estava conectada de uma sondagem
   anterior), com nome do perfil e número.
2. **Banco confirmado** via SQL direto:
   ```
   provider=uazapi, uazapi_status=connected,
   uazapi_connected_phone=5521984379771, uazapi_instance_name=Novo Rio,
   token_len=130, hash_len=64
   ```
   `hash_len=64` confirma o SHA-256 correto; `token_len=130` (bem acima de 36,
   o tamanho de um UUID cru) confirma que o token está cifrado em repouso, não
   em texto puro.
3. **Caminho Meta não regrediu** — a aba "API Oficial (Meta)" segue abrindo
   normalmente; nenhum código do caminho Meta foi tocado nesta fase (Task 6
   confirmou o formulário movido byte a byte).

**Achado operacional, não um contrato de API:** o primeiro teste falhou com
`RangeError: Invalid key length` em `encrypt()`. Causa raiz: o `ENCRYPTION_KEY`
do `.env.local` local tinha um `-` sobrando no início
(`ENCRYPTION_KEY=-17dbb8...`), tornando o valor hex inválido — `Buffer.from`
descarta a entrada inválida e produz um buffer vazio, então **qualquer**
`encrypt()`/`decrypt()` já falhava, para os dois provedores, desde antes desta
sessão. Corrigido removendo o `-` (o valor restante já eram os 64 hex chars
corretos). Isso também explica por que a aba Meta mostra "token não pôde ser
descriptografado" para a conta de teste: o token dela foi cifrado em outro
momento (provavelmente com a chave certa da produção), e não bate com a chave
local recém-corrigida — comportamento pré-existente e documentado pela própria
tela ("Redefinir configuração" + salvar de novo resolve), independente desta
fase.
