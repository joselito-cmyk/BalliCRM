# UAZAPI Fase 2 — Conexão por QR Code (API v2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que uma conta do BalliCRM conecte um número de WhatsApp por
QR Code via UAZAPI, colando o Instance Token nas Configurações, sem alterar em
nada o caminho da API oficial da Meta.

**Architecture:** O operador cria a instância no painel da UAZAPI e cola o
Instance Token no CRM. O app valida o token contra `GET /instance/status`,
guarda cifrado (mais um hash SHA-256 para unicidade e lookup), dispara
`POST /instance/connect` e faz polling em `GET /instance/status` — que devolve
QR e estado juntos, com o QR rotacionado pela própria UAZAPI.

**Tech Stack:** Next.js (App Router, route handlers), TypeScript, Supabase
(Postgres + RLS), Vitest, next-intl, Tailwind + shadcn/ui.

## Global Constraints

- **Não quebrar a Meta.** Nenhum teste existente do caminho Meta pode ser
  editado. Se um deles quebrar, é regressão de comportamento — não teste
  desatualizado.
- **Contratos são os do apêndice** de
  `docs/superpowers/specs/2026-08-03-uazapi-provider-design.md`, seção
  "Apêndice — contratos verificados ao vivo". Onde a documentação da UAZAPI
  divergir, vale o apêndice.
- **Endpoint:** `process.env.UAZAPI_ENDPOINT`, sem barra final.
  `UAZAPI_TOKEN` (admin) **não é usado** — o app não cria instâncias.
- **Segredos:** o Instance Token é cifrado com `encrypt()` de
  `src/lib/whatsapp/encryption.ts`. Nunca logar o token cru, nem em mensagem de
  erro devolvida ao cliente.
- **i18n:** todo texto visível vai para `messages/pt.json`, `en.json` e
  `ko.json`. Nenhuma string literal em componente.
- **Testes:** Vitest, com `fetch` mockado, no padrão de
  `src/lib/whatsapp/meta-api.test.ts`.
- **Migrations:** idempotentes, no padrão das existentes em
  `supabase/migrations/`.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/038_uazapi_instance_rename.sql` | Renomeia colunas v1→v2, adiciona coluna de hash |
| `src/types/index.ts` | `WhatsAppConfig` acompanha a 038 |
| `src/lib/whatsapp/uazapi-api.ts` | **Reescrito** — client HTTP da v2, sem acesso a banco |
| `src/lib/whatsapp/uazapi-token.ts` | `hashInstanceToken()` — SHA-256 hex |
| `src/lib/whatsapp/provider.ts` | Roteamento Meta/UAZAPI, ajustado aos novos campos |
| `src/lib/whatsapp/uazapi-account.ts` | Helper de rota: resolve conta + config UAZAPI decifrada |
| `src/app/api/whatsapp/uazapi/config/route.ts` | POST salva/valida token, DELETE limpa |
| `src/app/api/whatsapp/uazapi/connect/route.ts` | POST dispara conexão, devolve QR |
| `src/app/api/whatsapp/uazapi/status/route.ts` | GET polling: estado + QR |
| `src/app/api/whatsapp/uazapi/disconnect/route.ts` | POST desloga o telefone |
| `src/components/settings/whatsapp-config.tsx` | Container: seletor de provedor |
| `src/components/settings/whatsapp-config-meta.tsx` | Formulário Meta atual, **movido sem alteração** |
| `src/components/settings/whatsapp-config-uazapi.tsx` | Painel novo: token, QR, status |
| `messages/{pt,en,ko}.json` | Strings |

---

## Task 1: Migration 038 + tipos

**Files:**
- Create: `supabase/migrations/038_uazapi_instance_rename.sql`
- Modify: `src/types/index.ts:294-301`

**Interfaces:**
- Produces: colunas `uazapi_instance_name`, `uazapi_instance_token`,
  `uazapi_instance_token_hash`, `uazapi_status`, `uazapi_connected_phone`; tipo
  `WhatsAppConfig` com esses campos.

- [ ] **Step 1: Escrever a migration**

```sql
-- ============================================================
-- 038: whatsapp_config — renomeia os campos UAZAPI da v1 para a v2.
--
-- A migration 037 criou as colunas contra a API v1 da UAZAPI
-- (sessões: `session` + `sessionkey`, ambos gerados por nós). Aquela
-- API está descontinuada e o servidor contratado roda a v2, cujo
-- modelo é outro: instâncias, com um `token` que a UAZAPI gera e nós
-- apenas guardamos. Ver a seção "Revisão" do design.
--
-- Renomear (em vez de criar novas) é seguro porque nenhuma conta usa
-- UAZAPI ainda — as colunas estão vazias em 100% das linhas.
--
-- `uazapi_instance_token_hash` é coluna nova e não é redundante com o
-- token cifrado: `encrypt()` é AES-GCM com IV aleatório, então o mesmo
-- token gera ciphertext diferente a cada chamada. Sem um hash
-- determinístico não haveria como (a) impedir duas contas de
-- cadastrarem a mesma instância nem (b) o webhook da Fase 3 achar a
-- linha a partir do token que a UAZAPI ecoa no corpo.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

-- 1. Renomeia as colunas, só se ainda estiverem com o nome antigo.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_config' AND column_name = 'uazapi_session'
  ) THEN
    ALTER TABLE whatsapp_config RENAME COLUMN uazapi_session TO uazapi_instance_name;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_config' AND column_name = 'uazapi_session_key'
  ) THEN
    ALTER TABLE whatsapp_config RENAME COLUMN uazapi_session_key TO uazapi_instance_token;
  END IF;
END $$;

-- 2. Hash determinístico do token (SHA-256 hex, 64 chars).
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS uazapi_instance_token_hash TEXT;

-- 3. A UNIQUE da 037 apontava para uazapi_session (o antigo nome).
--    O rename a leva junto, mas ela protegia o identificador errado:
--    o nome da instância é rótulo de exibição, não chave. Trocamos o
--    alvo para o hash, que é o que identifica a instância de fato.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_uazapi_session_unique'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      DROP CONSTRAINT whatsapp_config_uazapi_session_unique;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_uazapi_token_hash_unique'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_uazapi_token_hash_unique
      UNIQUE (uazapi_instance_token_hash);
  END IF;
END $$;

-- 4. O CHECK de coerência da 037 cita os nomes antigos no seu corpo.
--    RENAME COLUMN atualiza a expressão automaticamente, mas o que ele
--    exige mudou: o nome da instância passa a ser opcional (vem da
--    UAZAPI, pode chegar vazio), enquanto token e hash são
--    obrigatórios — sem eles a linha não consegue chamar a API nem ser
--    encontrada pelo webhook.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_fields_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      DROP CONSTRAINT whatsapp_config_provider_fields_check;
  END IF;

  ALTER TABLE whatsapp_config
    ADD CONSTRAINT whatsapp_config_provider_fields_check
    CHECK (
      (provider = 'meta'
        AND phone_number_id IS NOT NULL
        AND access_token IS NOT NULL)
      OR
      (provider = 'uazapi'
        AND uazapi_instance_token IS NOT NULL
        AND uazapi_instance_token_hash IS NOT NULL)
    );
END $$;

-- 5. Índice de lookup do webhook (Fase 3). A UNIQUE acima já cria um
--    índice; este COMMENT existe para quem for ler a tabela depois.
COMMENT ON COLUMN whatsapp_config.uazapi_instance_token_hash IS
  'SHA-256 hex do Instance Token cru. Determinístico de propósito: é o alvo do UNIQUE e a chave de lookup do webhook UAZAPI, que não pode consultar a coluna cifrada (AES-GCM com IV aleatório).';
```

- [ ] **Step 2: Aplicar a migration**

Rodar no SQL Editor do Supabase (ou `supabase db push`). Confirmar com:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'whatsapp_config' AND column_name LIKE 'uazapi%'
ORDER BY column_name;
```

Esperado, exatamente estas cinco:
`uazapi_connected_phone`, `uazapi_instance_name`, `uazapi_instance_token`,
`uazapi_instance_token_hash`, `uazapi_status`.

- [ ] **Step 3: Atualizar o tipo**

Em `src/types/index.ts`, substituir o bloco `uazapi_*` de `WhatsAppConfig`:

```ts
  /** Rótulo da instância, vindo de `instance.name` da UAZAPI (definido no
   *  painel na criação). Exibição apenas — não é identificador. */
  uazapi_instance_name?: string;
  /** Instance Token, cifrado em repouso com o mesmo AES-GCM do access_token. */
  uazapi_instance_token?: string;
  /** SHA-256 hex do token cru. Determinístico: alvo do UNIQUE e chave de
   *  lookup do webhook — a coluna cifrada não é consultável. Ver migration 038. */
  uazapi_instance_token_hash?: string;
  /** `instance.status` bruto da UAZAPI: 'disconnected' | 'connecting' | 'connected'. */
  uazapi_status?: string;
  /** `instance.owner` — número que escaneou o QR, só dígitos (ex: '5521984379771'). */
  uazapi_connected_phone?: string;
```

- [ ] **Step 4: Verificar que compila**

Run: `npx tsc --noEmit`
Esperado: os únicos erros são em `provider.ts` (usa `uazapi_session`), que a
Task 3 corrige. Anotar quais são.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/038_uazapi_instance_rename.sql src/types/index.ts
git commit -m "feat(whatsapp): rename UAZAPI columns to v2 instance model

Adds uazapi_instance_token_hash — encrypt() is AES-GCM with a random
IV, so the ciphertext column can serve neither uniqueness nor lookup.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Reescrever `uazapi-api.ts` contra a v2

**Files:**
- Create: `src/lib/whatsapp/uazapi-token.ts`
- Rewrite: `src/lib/whatsapp/uazapi-api.ts`
- Rewrite: `src/lib/whatsapp/uazapi-api.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `hashInstanceToken(token: string): string`
  - `UazapiInstance`, `UazapiConnectionStatus`, `UazapiInstanceState`
  - `getInstanceStatus({ token }): Promise<UazapiInstanceState>`
  - `connectInstance({ token }): Promise<UazapiInstanceState>`
  - `disconnectInstance({ token }): Promise<void>`
  - `sendText({ token, number, text }): Promise<UazapiSendResult>`
  - `sendMedia({ token, number, kind, path, caption? }): Promise<UazapiSendResult>`

- [ ] **Step 1: Escrever o helper de hash**

`src/lib/whatsapp/uazapi-token.ts`:

```ts
import { createHash } from 'crypto'

/**
 * SHA-256 hex do Instance Token cru.
 *
 * Sem salt de propósito: um salt por linha quebraria o lookup do
 * webhook, que só tem o token em mãos e precisa achar a linha. É
 * aceitável porque o token é um UUID v4 gerado pela UAZAPI (~122 bits
 * de entropia), não um segredo escolhido por humano — não há
 * dicionário a percorrer.
 */
export function hashInstanceToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex')
}
```

- [ ] **Step 2: Escrever os testes que falham**

Substituir `src/lib/whatsapp/uazapi-api.test.ts` inteiro:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ENDPOINT = 'https://uazapi.test'
process.env.UAZAPI_ENDPOINT = ENDPOINT

import {
  getInstanceStatus,
  connectInstance,
  disconnectInstance,
  sendText,
  sendMedia,
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
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp/uazapi-api.test.ts`
Esperado: FAIL — `getInstanceStatus is not a function` (o arquivo ainda tem a v1).

- [ ] **Step 4: Reescrever o client**

Substituir `src/lib/whatsapp/uazapi-api.ts` inteiro:

```ts
/**
 * UAZAPI (WhatsApp não oficial) — client HTTP da API v2 (uazapiGO).
 *
 * Contratos verificados ao vivo contra balligroup.uazapi.com em
 * 2026-08-04; ver o apêndice de
 * docs/superpowers/specs/2026-08-03-uazapi-provider-design.md. Onde a
 * documentação pública da UAZAPI divergir, vale o apêndice — ela já
 * errou em cinco pontos.
 *
 * Autenticação: header `token` (o Instance Token). O `admintoken`, que
 * controla a assinatura inteira, NÃO é usado aqui: o app não cria nem
 * apaga instâncias — isso é feito no painel da UAZAPI.
 *
 * Client puro: nenhum acesso a banco, nenhuma decisão de negócio.
 */

import type { MediaKind } from './meta-api'

export type { MediaKind }

const UAZAPI_ENDPOINT = process.env.UAZAPI_ENDPOINT!

// ============================================================
// Tipos
// ============================================================

/**
 * O objeto `instance` que vem em /instance/status e /instance/connect.
 *
 * Só os campos que usamos são tipados — a UAZAPI devolve dezenas
 * (chatbot nativo, proxy, adminFields) que não nos interessam.
 *
 * Os campos marcados "só quando conectado" chegam vazios ou ausentes
 * enquanto a instância está disconnected/connecting: o objeto muda de
 * forma entre os estados.
 */
export interface UazapiInstance {
  id: string
  status: string
  /** Data URI completo (`data:image/png;base64,…`) enquanto connecting; '' fora disso. */
  qrcode: string
  /** Rótulo definido no painel na criação. */
  name: string
  /** Só quando conectado: número da instância, apenas dígitos. */
  owner: string
  profileName: string
  profilePicUrl: string
  isBusiness: boolean
  lastDisconnect: string
  lastDisconnectReason: string
  msg_delay_min: number
  msg_delay_max: number
}

export interface UazapiConnectionStatus {
  connected: boolean
  loggedIn: boolean
  jid: string | null
  /** Ausente na resposta do /instance/connect; presente no /instance/status. */
  resetting?: boolean
}

export interface UazapiInstanceState {
  instance: UazapiInstance
  status: UazapiConnectionStatus
}

export interface UazapiSendResult {
  messageId: string
}

// ============================================================
// Infra
// ============================================================

interface UazapiErrorBody {
  message?: string
  error?: string
  response?: string
}

/**
 * A UAZAPI não documenta o corpo de erro. Observado ao vivo:
 * `Invalid AdminToken Header` como texto puro em alguns casos, JSON em
 * outros. Tentamos os três campos que ela usa e caímos no status code.
 *
 * Nunca inclui o token na mensagem: ela sobe até a UI.
 */
async function throwUazapiError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as UazapiErrorBody
    const found = data.message ?? data.error ?? data.response
    if (typeof found === 'string' && found.length > 0) message = found
  } catch {
    // corpo não era JSON — mantém o fallback
  }
  throw new Error(message)
}

async function uazapiFetch(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const method = init.method ?? 'GET'
  const response = await fetch(`${UAZAPI_ENDPOINT}${path}`, {
    method,
    headers: { 'content-type': 'application/json', token },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  return response.json()
}

/**
 * Parser único para /instance/status e /instance/connect, que
 * compartilham a forma `{ instance, status }`.
 *
 * Lê SEMPRE o objeto `status` aninhado. O /connect também expõe
 * `connected`/`loggedIn` na raiz, mas o /status não — usar os campos
 * de topo daria `undefined` silencioso num dos dois caminhos.
 */
function parseInstanceState(data: unknown, context: string): UazapiInstanceState {
  const d = data as { instance?: Record<string, unknown>; status?: Record<string, unknown> }
  if (!d?.instance || typeof d.instance !== 'object' || !d.status || typeof d.status !== 'object') {
    throw new Error(`UAZAPI returned an unexpected response shape for ${context}.`)
  }
  const i = d.instance
  const s = d.status

  if (typeof s.connected !== 'boolean' || typeof s.loggedIn !== 'boolean') {
    throw new Error(`UAZAPI returned an unexpected response shape for ${context}.`)
  }

  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

  return {
    instance: {
      id: str(i.id),
      status: str(i.status),
      qrcode: str(i.qrcode),
      name: str(i.name),
      owner: str(i.owner),
      profileName: str(i.profileName),
      profilePicUrl: str(i.profilePicUrl),
      isBusiness: i.isBusiness === true,
      lastDisconnect: str(i.lastDisconnect),
      lastDisconnectReason: str(i.lastDisconnectReason),
      msg_delay_min: num(i.msg_delay_min),
      msg_delay_max: num(i.msg_delay_max),
    },
    status: {
      connected: s.connected,
      loggedIn: s.loggedIn,
      jid: typeof s.jid === 'string' ? s.jid : null,
      ...(typeof s.resetting === 'boolean' ? { resetting: s.resetting } : {}),
    },
  }
}

// ============================================================
// Ciclo de vida da instância
// ============================================================

export interface InstanceTokenArgs {
  /** Instance Token cru (já decifrado). */
  token: string
}

/**
 * Estado atual da instância — inclui o QR vigente quando connecting.
 *
 * É também o endpoint de validação: um token inválido responde 401, o
 * que torna esta a chamada certa para conferir um token colado antes
 * de gravá-lo.
 */
export async function getInstanceStatus(args: InstanceTokenArgs): Promise<UazapiInstanceState> {
  const data = await uazapiFetch('/instance/status', args.token)
  return parseInstanceState(data, 'getInstanceStatus')
}

/**
 * Inicia a conexão: status vai para "connecting" e o primeiro QR é
 * gerado.
 *
 * Chamado UMA vez por tentativa. Não existe "renovar QR" — a UAZAPI
 * rotaciona sozinha e o /instance/status entrega o vigente (medido:
 * o QR mudou entre duas leituras separadas por 22s, sem chamada
 * nossa). A janela expira sozinha depois de alguns minutos, voltando a
 * "disconnected" com lastDisconnectReason "QR Code timeout".
 */
export async function connectInstance(args: InstanceTokenArgs): Promise<UazapiInstanceState> {
  const data = await uazapiFetch('/instance/connect', args.token, { method: 'POST', body: {} })
  return parseInstanceState(data, 'connectInstance')
}

/**
 * Desloga o telefone mantendo a instância viva (dá para reconectar
 * lendo um QR novo).
 *
 * Deliberadamente NÃO existe um deleteInstance() aqui: DELETE
 * /instance apagaria a instância e liberaria a única vaga da
 * assinatura. Isso é operação de painel, não de aplicação.
 */
export async function disconnectInstance(args: InstanceTokenArgs): Promise<void> {
  await uazapiFetch('/instance/disconnect', args.token, { method: 'POST', body: {} })
}

// ============================================================
// Envio (usado a partir da Fase 3)
// ============================================================

/**
 * A UAZAPI não documenta o corpo de sucesso do /send/*, e ele não foi
 * verificado ao vivo (exigiria enviar uma mensagem real). Aceitamos os
 * dois nomes plausíveis; a Fase 3 confirma e simplifica.
 */
function parseSendResult(data: unknown): UazapiSendResult {
  const d = data as { messageid?: unknown; messageId?: unknown; id?: unknown }
  const id = d?.messageid ?? d?.messageId ?? d?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('UAZAPI accepted the send but returned no message id.')
  }
  return { messageId: id }
}

export interface UazapiSendTextArgs extends InstanceTokenArgs {
  /** Só dígitos, com código do país. Ex: '5521984379771'. */
  number: string
  text: string
}

export async function sendText(args: UazapiSendTextArgs): Promise<UazapiSendResult> {
  const { token, number, text } = args
  const data = await uazapiFetch('/send/text', token, { method: 'POST', body: { number, text } })
  return parseSendResult(data)
}

/**
 * Na v2 os quatro tipos de mídia passam por um endpoint só; o campo
 * `type` discrimina. `file` aceita URL pública — que é exatamente o
 * que já guardamos no Supabase Storage — ou base64.
 */
const MEDIA_TYPE: Record<MediaKind, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
}

export interface UazapiSendMediaArgs extends InstanceTokenArgs {
  number: string
  kind: MediaKind
  /** URL pública que a UAZAPI busca na hora do envio. */
  path: string
  caption?: string
}

export async function sendMedia(args: UazapiSendMediaArgs): Promise<UazapiSendResult> {
  const { token, number, kind, path, caption } = args
  if (!path) throw new Error('sendMedia requires a path.')
  const body: Record<string, unknown> = { number, type: MEDIA_TYPE[kind], file: path }
  if (caption) body.text = caption
  const data = await uazapiFetch('/send/media', token, { method: 'POST', body })
  return parseSendResult(data)
}
```

- [ ] **Step 5: Rodar os testes**

Run: `npx vitest run src/lib/whatsapp/uazapi-api.test.ts`
Esperado: PASS, todos.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/uazapi-api.ts src/lib/whatsapp/uazapi-token.ts src/lib/whatsapp/uazapi-api.test.ts
git commit -m "feat(whatsapp): rewrite UAZAPI client against the v2 API

The v1 client shipped in Fase 1 called endpoints that do not exist on
the contracted server — every one of them 405s. Contracts here were
verified live; see the design doc appendix.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Ajustar `provider.ts`

**Files:**
- Modify: `src/lib/whatsapp/provider.ts`
- Modify: `src/lib/whatsapp/provider.test.ts`

**Interfaces:**
- Consumes: `sendText`/`sendMedia` de `uazapi-api.ts` (Task 2), `WhatsAppConfig` (Task 1).
- Produces: `sendText(config, args)` / `sendMedia(config, args)` inalterados na assinatura.

- [ ] **Step 1: Ajustar os testes existentes ao novo campo**

Em `src/lib/whatsapp/provider.test.ts`, trocar todas as fixtures
`uazapi_session` / `uazapi_session_key` por `uazapi_instance_token`, e a
asserção da chamada ao client de `{ session, sessionkey, … }` para
`{ token, … }`. Acrescentar:

```ts
it('recusa envio UAZAPI sem instance token', async () => {
  await expect(
    sendText({ ...baseConfig, provider: 'uazapi', uazapi_instance_token: undefined }, { to: '55', text: 'x' }),
  ).rejects.toThrow(/not configured/i)
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp/provider.test.ts`
Esperado: FAIL — `provider.ts` ainda lê `config.uazapi_session`.

- [ ] **Step 3: Aplicar a mudança**

Em `src/lib/whatsapp/provider.ts`, no ramo UAZAPI de `sendText`:

```ts
  if (config.provider === 'uazapi') {
    if (!config.uazapi_instance_token) {
      throw new Error('UAZAPI instance not configured for this account.')
    }
    const result = await uazapiSendText({
      token: decrypt(config.uazapi_instance_token),
      number: to,
      text,
    })
    return { messageId: result.messageId }
  }
```

E no ramo UAZAPI de `sendMedia`:

```ts
  if (config.provider === 'uazapi') {
    if (!config.uazapi_instance_token) {
      throw new Error('UAZAPI instance not configured for this account.')
    }
    const result = await uazapiSendMedia({
      token: decrypt(config.uazapi_instance_token),
      number: to,
      kind,
      path: link,
      caption,
    })
    return { messageId: result.messageId }
  }
```

Atualizar também o comentário do topo do arquivo: trocar "matching the v1 scope"
por "matching the Fase 3 scope", e a nota do `contextMessageId` de
"no v1 equivalent" para "sem equivalente na v2".

- [ ] **Step 4: Rodar os testes**

Run: `npx vitest run src/lib/whatsapp/provider.test.ts`
Esperado: PASS.

- [ ] **Step 5: Suíte inteira, para provar que a Meta não regrediu**

Run: `npx vitest run`
Esperado: PASS. Nenhum teste do caminho Meta foi editado.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/provider.ts src/lib/whatsapp/provider.test.ts
git commit -m "feat(whatsapp): route UAZAPI sends through the v2 instance token

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Helper de rota + rota de configuração

**Files:**
- Create: `src/lib/whatsapp/uazapi-account.ts`
- Create: `src/app/api/whatsapp/uazapi/config/route.ts`
- Test: `src/lib/whatsapp/uazapi-account.test.ts`

**Interfaces:**
- Consumes: `getInstanceStatus` (Task 2), `hashInstanceToken` (Task 2), `encrypt`/`decrypt`.
- Produces:
  - `resolveAccountId(supabase, userId): Promise<string | null>`
  - `loadUazapiToken(supabase, accountId): Promise<{ token: string } | { error: UazapiConfigError }>`
  - `type UazapiConfigError = 'no_config' | 'wrong_provider' | 'token_corrupted'`
  - `POST /api/whatsapp/uazapi/config` — salva o token colado
  - `DELETE /api/whatsapp/uazapi/config` — limpa a config

- [ ] **Step 1: Escrever o helper**

`src/lib/whatsapp/uazapi-account.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'

export type UazapiConfigError = 'no_config' | 'wrong_provider' | 'token_corrupted'

/**
 * Resolve a conta do usuário logado. Mesmo shape do helper inline de
 * /api/whatsapp/config — extraído aqui porque as quatro rotas UAZAPI
 * precisam dele e triplicá-lo convida a divergência.
 */
export async function resolveAccountId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

/**
 * Carrega e decifra o Instance Token da conta.
 *
 * Devolve um erro tipado em vez de lançar, porque cada motivo tem uma
 * remediação diferente na UI: 'no_config' pede que cole o token,
 * 'wrong_provider' significa que a conta está no caminho Meta, e
 * 'token_corrupted' é ENCRYPTION_KEY trocada — só resolve limpando e
 * colando de novo.
 */
export async function loadUazapiToken(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  accountId: string,
): Promise<{ token: string } | { error: UazapiConfigError }> {
  const { data, error } = await supabase
    .from('whatsapp_config')
    .select('provider, uazapi_instance_token')
    .eq('account_id', accountId)
    .maybeSingle()

  if (error || !data) return { error: 'no_config' }
  if (data.provider !== 'uazapi') return { error: 'wrong_provider' }
  if (!data.uazapi_instance_token) return { error: 'no_config' }

  try {
    return { token: decrypt(data.uazapi_instance_token) }
  } catch {
    return { error: 'token_corrupted' }
  }
}
```

- [ ] **Step 2: Escrever os testes do helper**

`src/lib/whatsapp/uazapi-account.test.ts`:

```ts
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
```

- [ ] **Step 3: Rodar**

Run: `npx vitest run src/lib/whatsapp/uazapi-account.test.ts`
Esperado: PASS.

- [ ] **Step 4: Escrever a rota de configuração**

`src/app/api/whatsapp/uazapi/config/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getInstanceStatus } from '@/lib/whatsapp/uazapi-api'
import { hashInstanceToken } from '@/lib/whatsapp/uazapi-token'
import { encrypt } from '@/lib/whatsapp/encryption'
import { resolveAccountId } from '@/lib/whatsapp/uazapi-account'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

/**
 * POST /api/whatsapp/uazapi/config
 *
 * Salva o Instance Token que o operador colou. Valida contra a UAZAPI
 * ANTES de gravar — um token inválido é recusado na hora, em vez de
 * virar uma config quebrada que só falha na hora de conectar.
 *
 * Body: { instance_token: string }
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'Your profile is not linked to an account.' }, { status: 403 })
    }

    const body = await request.json()
    const rawToken = typeof body?.instance_token === 'string' ? body.instance_token.trim() : ''
    if (!rawToken) {
      return NextResponse.json({ error: 'instance_token is required' }, { status: 400 })
    }

    // Valida contra a UAZAPI antes de qualquer escrita.
    let state
    try {
      state = await getInstanceStatus({ token: rawToken })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown UAZAPI error'
      return NextResponse.json(
        { error: `UAZAPI rejected this token: ${message}` },
        { status: 400 },
      )
    }

    const tokenHash = hashInstanceToken(rawToken)

    // Uma instância não pode servir duas contas: o webhook da Fase 3
    // busca a linha pelo hash com .maybeSingle(), e duas linhas fariam
    // ele descartar as mensagens das duas. Sob RLS a conta não enxerga
    // linhas alheias, daí o service role.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('uazapi_instance_token_hash', tokenHash)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('[uazapi/config] ownership check failed:', claimedError)
      return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
    }
    if (claimed) {
      return NextResponse.json(
        { error: 'This UAZAPI instance is already linked to another account.' },
        { status: 409 },
      )
    }

    const row = {
      provider: 'uazapi' as const,
      uazapi_instance_token: encrypt(rawToken),
      uazapi_instance_token_hash: tokenHash,
      uazapi_instance_name: state.instance.name || null,
      uazapi_status: state.instance.status,
      uazapi_connected_phone: state.instance.owner || null,
      // Trocar de provedor zera o lado da Meta: manter credenciais
      // órfãs faria o CHECK de coerência da 038 passar por acidente e
      // deixaria um token da Meta cifrado no banco sem dono.
      phone_number_id: null,
      waba_id: null,
      access_token: null,
      verify_token: null,
      registered_at: null,
      subscribed_apps_at: null,
      last_registration_error: null,
      status: state.status.loggedIn ? 'connected' : 'disconnected',
      connected_at: state.status.loggedIn ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    const { error: writeError } = existing
      ? await supabase.from('whatsapp_config').update(row).eq('account_id', accountId)
      : await supabase.from('whatsapp_config').insert({ account_id: accountId, user_id: user.id, ...row })

    if (writeError) {
      console.error('[uazapi/config] write failed:', writeError)
      return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      instance: {
        name: state.instance.name,
        status: state.instance.status,
        connected: state.status.connected && state.status.loggedIn,
        phone: state.instance.owner || null,
        profile_name: state.instance.profileName || null,
      },
    })
  } catch (error) {
    console.error('[uazapi/config] POST failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/uazapi/config
 *
 * Esquece a instância — apaga a linha do CRM. NÃO chama DELETE
 * /instance na UAZAPI: a instância continua existindo no painel, e é
 * lá que ela se apaga. Deletar daqui queimaria a única vaga da
 * assinatura por engano.
 */
export async function DELETE() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'Your profile is not linked to an account.' }, { status: 403 })
    }

    const { error } = await supabase.from('whatsapp_config').delete().eq('account_id', accountId)
    if (error) {
      console.error('[uazapi/config] delete failed:', error)
      return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[uazapi/config] DELETE failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 5: Verificar compilação**

Run: `npx tsc --noEmit`
Esperado: sem erros.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/uazapi-account.ts src/lib/whatsapp/uazapi-account.test.ts src/app/api/whatsapp/uazapi/config/route.ts
git commit -m "feat(whatsapp): add UAZAPI config route with live token validation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Rotas connect / status / disconnect

**Files:**
- Create: `src/app/api/whatsapp/uazapi/connect/route.ts`
- Create: `src/app/api/whatsapp/uazapi/status/route.ts`
- Create: `src/app/api/whatsapp/uazapi/disconnect/route.ts`

**Interfaces:**
- Consumes: `loadUazapiToken`, `resolveAccountId` (Task 4); `connectInstance`,
  `getInstanceStatus`, `disconnectInstance` (Task 2).
- Produces: as três rotas HTTP consumidas pelo painel da Task 7. Todas devolvem
  `UazapiStatusResponse`:

```ts
{
  ok: true
  connected: boolean          // connected && loggedIn
  instance_status: string     // 'disconnected' | 'connecting' | 'connected'
  qrcode: string | null       // data URI, só durante connecting
  phone: string | null
  profile_name: string | null
  instance_name: string | null
  last_disconnect_reason: string | null
}
| { ok: false; reason: 'no_config' | 'wrong_provider' | 'token_corrupted' | 'uazapi_error'; message: string }
```

- [ ] **Step 1: Criar um formatador compartilhado**

Acrescentar ao fim de `src/lib/whatsapp/uazapi-account.ts`:

```ts
import type { UazapiInstanceState } from './uazapi-api'

export interface UazapiStatusPayload {
  ok: true
  connected: boolean
  instance_status: string
  qrcode: string | null
  phone: string | null
  profile_name: string | null
  instance_name: string | null
  last_disconnect_reason: string | null
}

/**
 * Forma única devolvida por /connect e /status, para o painel tratar
 * as duas respostas com um só caminho de código.
 *
 * `qrcode` só sai quando há QR de fato — string vazia vira null, senão
 * o <img> renderiza quebrado ao conectar.
 */
export function toStatusPayload(state: UazapiInstanceState): UazapiStatusPayload {
  return {
    ok: true,
    connected: state.status.connected && state.status.loggedIn,
    instance_status: state.instance.status,
    qrcode: state.instance.qrcode || null,
    phone: state.instance.owner || null,
    profile_name: state.instance.profileName || null,
    instance_name: state.instance.name || null,
    last_disconnect_reason: state.instance.lastDisconnectReason || null,
  }
}

/** Mensagens de erro por motivo — a UI traduz pela chave `reason`. */
export const UAZAPI_ERROR_MESSAGE: Record<UazapiConfigError, string> = {
  no_config: 'No UAZAPI instance token saved for this account.',
  wrong_provider: 'This account is configured for the Meta provider.',
  token_corrupted:
    'The stored instance token cannot be decrypted with the current ENCRYPTION_KEY. Remove the configuration and paste the token again.',
}
```

- [ ] **Step 2: Escrever a rota de status**

`src/app/api/whatsapp/uazapi/status/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getInstanceStatus } from '@/lib/whatsapp/uazapi-api'
import {
  resolveAccountId,
  loadUazapiToken,
  toStatusPayload,
  UAZAPI_ERROR_MESSAGE,
} from '@/lib/whatsapp/uazapi-account'

/**
 * GET /api/whatsapp/uazapi/status
 *
 * Alvo do polling do painel. Devolve estado E QR vigente numa chamada
 * só — a UAZAPI rotaciona o QR por conta própria, então não existe
 * (nem é preciso) um endpoint de "renovar QR".
 *
 * Erros de configuração voltam como 200 com ok:false, no mesmo padrão
 * de /api/whatsapp/config: a UI mostra a remediação certa em vez de um
 * 500 genérico. Só falha de auth vira status HTTP de erro.
 *
 * Persiste o estado observado (status e número) para a página de
 * Configurações conseguir mostrar algo sem bater na UAZAPI no
 * carregamento.
 */
export async function GET() {
  try {
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
      return NextResponse.json(
        { ok: false, reason: loaded.error, message: UAZAPI_ERROR_MESSAGE[loaded.error] },
        { status: 200 },
      )
    }

    let state
    try {
      state = await getInstanceStatus({ token: loaded.token })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown UAZAPI error'
      return NextResponse.json({ ok: false, reason: 'uazapi_error', message }, { status: 200 })
    }

    const payload = toStatusPayload(state)

    await supabase
      .from('whatsapp_config')
      .update({
        uazapi_status: payload.instance_status,
        uazapi_connected_phone: payload.phone,
        status: payload.connected ? 'connected' : 'disconnected',
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId)

    return NextResponse.json(payload)
  } catch (error) {
    console.error('[uazapi/status] failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 3: Escrever a rota de conexão**

`src/app/api/whatsapp/uazapi/connect/route.ts` — idêntica à de status, com três
diferenças: `export async function POST()`, `connectInstance` no lugar de
`getInstanceStatus`, e sem o `update` (o polling seguinte grava). Copiar o
arquivo do Step 2 e aplicar:

```ts
import { connectInstance } from '@/lib/whatsapp/uazapi-api'
```

```ts
/**
 * POST /api/whatsapp/uazapi/connect
 *
 * Dispara a conexão e devolve o primeiro QR. Chamado uma vez por
 * tentativa — a partir daí o painel só faz polling em /status, que
 * entrega o QR rotacionado pela UAZAPI.
 *
 * Também é o botão "tentar de novo" quando a janela expira ("QR Code
 * timeout"): rechamar aqui abre uma janela nova.
 */
export async function POST() {
```

```ts
    let state
    try {
      state = await connectInstance({ token: loaded.token })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown UAZAPI error'
      return NextResponse.json({ ok: false, reason: 'uazapi_error', message }, { status: 200 })
    }

    return NextResponse.json(toStatusPayload(state))
```

- [ ] **Step 4: Escrever a rota de desconexão**

`src/app/api/whatsapp/uazapi/disconnect/route.ts` — mesma estrutura, com
`disconnectInstance`, e persistindo o estado desconectado:

```ts
/**
 * POST /api/whatsapp/uazapi/disconnect
 *
 * Desloga o telefone. A instância continua existindo na UAZAPI e o
 * token segue salvo, então reconectar é só clicar em Conectar de novo.
 * Para esquecer a instância de vez, use DELETE /api/whatsapp/uazapi/config.
 */
export async function POST() {
```

```ts
    try {
      await disconnectInstance({ token: loaded.token })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown UAZAPI error'
      return NextResponse.json({ ok: false, reason: 'uazapi_error', message }, { status: 200 })
    }

    await supabase
      .from('whatsapp_config')
      .update({
        uazapi_status: 'disconnected',
        uazapi_connected_phone: null,
        status: 'disconnected',
        connected_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId)

    return NextResponse.json({ ok: true, connected: false, instance_status: 'disconnected' })
```

- [ ] **Step 5: Verificar compilação e build**

Run: `npx tsc --noEmit && npm run build`
Esperado: sem erros; as quatro rotas aparecem na listagem do build.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/uazapi src/lib/whatsapp/uazapi-account.ts
git commit -m "feat(whatsapp): add UAZAPI connect, status and disconnect routes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Dividir o componente de configurações

Esta task **não muda comportamento nenhum** — é só mover código. Fazê-la
sozinha mantém o diff da Task 7 legível.

**Files:**
- Create: `src/components/settings/whatsapp-config-meta.tsx`
- Modify: `src/components/settings/whatsapp-config.tsx`

**Interfaces:**
- Produces: `<WhatsAppConfigMeta />` com o formulário Meta inteiro;
  `whatsapp-config.tsx` vira container.

- [ ] **Step 1: Mover o formulário Meta**

Criar `whatsapp-config-meta.tsx` com **todo** o conteúdo atual de
`whatsapp-config.tsx`, renomeando o componente exportado para
`WhatsAppConfigMeta`. Nenhuma linha de lógica alterada — só o nome e o
`export`.

- [ ] **Step 2: Transformar o original em container**

`src/components/settings/whatsapp-config.tsx`:

```tsx
'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { WhatsAppConfigMeta } from './whatsapp-config-meta'
import { WhatsAppConfigUazapi } from './whatsapp-config-uazapi'

type Provider = 'meta' | 'uazapi'

/**
 * Container da aba WhatsApp: escolhe o provedor e renderiza o painel
 * correspondente. Toda a lógica de cada provedor vive no seu próprio
 * arquivo — o formulário da Meta tinha 883 linhas e enfiar um segundo
 * fluxo dentro dele deixaria o arquivo intratável.
 */
export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp')
  const [provider, setProvider] = useState<Provider>('meta')
  const [loading, setLoading] = useState(true)

  // O provedor salvo manda na aba inicial: quem já conectou por QR
  // Code não deve cair no formulário da Meta ao abrir a página.
  useEffect(() => {
    fetch('/api/whatsapp/uazapi/status')
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok === true || d?.reason === 'token_corrupted') setProvider('uazapi')
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return null

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <Button
          variant={provider === 'meta' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setProvider('meta')}
        >
          {t('providerMeta')}
        </Button>
        <Button
          variant={provider === 'uazapi' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setProvider('uazapi')}
        >
          {t('providerUazapi')}
        </Button>
      </div>

      {provider === 'meta' ? <WhatsAppConfigMeta /> : <WhatsAppConfigUazapi />}
    </div>
  )
}
```

- [ ] **Step 3: Verificar que a Meta segue idêntica**

Run: `npm run dev`, abrir Configurações → WhatsApp.
Esperado: a aba "API Oficial (Meta)" mostra exatamente o formulário de antes,
com os mesmos campos e botões. (A aba UAZAPI ainda quebra — a Task 7 a cria.)

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/whatsapp-config.tsx src/components/settings/whatsapp-config-meta.tsx
git commit -m "refactor(settings): split WhatsApp config into provider panels

Pure move — the Meta form is unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Painel UAZAPI

**Files:**
- Create: `src/components/settings/whatsapp-config-uazapi.tsx`

**Interfaces:**
- Consumes: as quatro rotas das Tasks 4 e 5; as chaves i18n da Task 8.

- [ ] **Step 1: Escrever o painel**

```tsx
'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface StatusPayload {
  ok: true
  connected: boolean
  instance_status: string
  qrcode: string | null
  phone: string | null
  profile_name: string | null
  instance_name: string | null
  last_disconnect_reason: string | null
}
interface StatusError {
  ok: false
  reason: 'no_config' | 'wrong_provider' | 'token_corrupted' | 'uazapi_error'
  message: string
}
type StatusResponse = StatusPayload | StatusError

const POLL_MS = 4000

export function WhatsAppConfigUazapi() {
  const t = useTranslations('Settings.whatsapp.uazapi')

  const [token, setToken] = useState('')
  const [state, setState] = useState<StatusResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Guarda a identidade do polling em curso. Sem isso, um clique em
  // Desconectar durante a espera deixaria o timer anterior vivo e ele
  // continuaria sobrescrevendo o estado.
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const fetchStatus = useCallback(async (): Promise<StatusResponse | null> => {
    try {
      const r = await fetch('/api/whatsapp/uazapi/status')
      if (r.status === 401 || r.status === 403) return null
      const d = (await r.json()) as StatusResponse
      setState(d)
      return d
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    return stopPolling
  }, [fetchStatus, stopPolling])

  /**
   * Polling enquanto a instância está "connecting". Encadeado com
   * setTimeout (não setInterval) para nunca empilhar requisições se a
   * UAZAPI demorar mais que o intervalo.
   *
   * A janela do QR expira sozinha: quando isso acontece o status volta
   * a "disconnected" e o polling para, deixando a UI mostrar o aviso de
   * expiração em vez de um QR morto.
   */
  useEffect(() => {
    if (!state || state.ok !== true || state.instance_status !== 'connecting') {
      stopPolling()
      return
    }
    pollRef.current = setTimeout(async () => {
      await fetchStatus()
    }, POLL_MS)
    return stopPolling
  }, [state, fetchStatus, stopPolling])

  async function saveToken() {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/whatsapp/uazapi/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instance_token: token }),
      })
      const d = await r.json()
      if (!r.ok) {
        setError(d?.error ?? t('errorSaving'))
        return
      }
      setToken('')
      await fetchStatus()
    } finally {
      setBusy(false)
    }
  }

  async function connect() {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/whatsapp/uazapi/connect', { method: 'POST' })
      const d = (await r.json()) as StatusResponse
      setState(d)
      if (d.ok === false) setError(d.message)
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    setError(null)
    stopPolling()
    try {
      await fetch('/api/whatsapp/uazapi/disconnect', { method: 'POST' })
      await fetchStatus()
    } finally {
      setBusy(false)
    }
  }

  async function forget() {
    if (!confirm(t('forgetConfirm'))) return
    setBusy(true)
    stopPolling()
    try {
      await fetch('/api/whatsapp/uazapi/config', { method: 'DELETE' })
      await fetchStatus()
    } finally {
      setBusy(false)
    }
  }

  const needsToken = state?.ok === false && (state.reason === 'no_config' || state.reason === 'wrong_provider')
  const corrupted = state?.ok === false && state.reason === 'token_corrupted'

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
        )}

        {corrupted && (
          <div className="space-y-2 rounded-md bg-destructive/10 p-3">
            <p className="text-sm text-destructive">{t('tokenCorrupted')}</p>
            <Button size="sm" variant="outline" onClick={forget} disabled={busy}>
              {t('forget')}
            </Button>
          </div>
        )}

        {(needsToken || state === null) && (
          <div className="space-y-2">
            <Label htmlFor="uazapi-token">{t('tokenLabel')}</Label>
            <Input
              id="uazapi-token"
              type="password"
              autoComplete="off"
              placeholder={t('tokenPlaceholder')}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('tokenHelp')}</p>
            <Button onClick={saveToken} disabled={busy || !token.trim()}>
              {t('save')}
            </Button>
          </div>
        )}

        {state?.ok === true && (
          <div className="space-y-4">
            {state.connected ? (
              <div className="space-y-1">
                <p className="text-sm font-medium text-green-600">{t('statusConnected')}</p>
                {state.profile_name && <p className="text-sm">{state.profile_name}</p>}
                {state.phone && <p className="text-sm text-muted-foreground">+{state.phone}</p>}
                {state.instance_name && (
                  <p className="text-xs text-muted-foreground">{t('instanceLabel', { name: state.instance_name })}</p>
                )}
                <div className="flex gap-2 pt-2">
                  <Button size="sm" variant="outline" onClick={disconnect} disabled={busy}>
                    {t('disconnect')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={forget} disabled={busy}>
                    {t('forget')}
                  </Button>
                </div>
              </div>
            ) : state.instance_status === 'connecting' && state.qrcode ? (
              <div className="space-y-2">
                <Image
                  src={state.qrcode}
                  alt={t('qrAlt')}
                  width={280}
                  height={280}
                  unoptimized
                  className="rounded-lg bg-white p-3"
                />
                <p className="text-sm">{t('scanInstructions')}</p>
                <p className="text-xs text-muted-foreground">{t('qrRotates')}</p>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{t('statusDisconnected')}</p>
                {state.last_disconnect_reason === 'QR Code timeout' && (
                  <p className="text-sm text-amber-600">{t('qrExpired')}</p>
                )}
                <div className="flex gap-2">
                  <Button onClick={connect} disabled={busy}>
                    {t('connect')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={forget} disabled={busy}>
                    {t('forget')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Verificar compilação**

Run: `npx tsc --noEmit && npm run build`
Esperado: sem erros. (As chaves i18n ainda não existem — o build passa, o texto
aparece como a chave crua até a Task 8.)

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/whatsapp-config-uazapi.tsx
git commit -m "feat(settings): add UAZAPI QR-code connection panel

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Traduções

**Files:**
- Modify: `messages/pt.json`, `messages/en.json`, `messages/ko.json`

- [ ] **Step 1: Acrescentar as chaves**

Em `messages/pt.json`, dentro de `Settings.whatsapp` (namespace com **S maiúsculo** — é assim no repositório):

```json
"providerMeta": "API Oficial (Meta)",
"providerUazapi": "QR Code (UAZAPI)",
"uazapi": {
  "title": "Conexão por QR Code",
  "description": "Conecte um número de WhatsApp escaneando um QR Code, sem precisar da API oficial da Meta.",
  "tokenLabel": "Instance Token",
  "tokenPlaceholder": "Cole o token da instância",
  "tokenHelp": "Crie uma instância no painel da UAZAPI e cole aqui o Instance Token dela.",
  "save": "Salvar token",
  "connect": "Conectar",
  "disconnect": "Desconectar",
  "forget": "Remover configuração",
  "forgetConfirm": "Isso remove a instância do CRM. A instância continua existindo no painel da UAZAPI. Continuar?",
  "statusConnected": "Conectado",
  "statusDisconnected": "Desconectado",
  "instanceLabel": "Instância: {name}",
  "scanInstructions": "No WhatsApp do celular: Aparelhos conectados → Conectar aparelho.",
  "qrRotates": "O código se renova sozinho. Deixe esta tela aberta.",
  "qrAlt": "QR Code para conectar o WhatsApp",
  "qrExpired": "O QR Code expirou antes de ser lido. Clique em Conectar para gerar outro.",
  "tokenCorrupted": "O token salvo não pode ser descriptografado com a ENCRYPTION_KEY atual. Remova a configuração e cole o token de novo.",
  "errorSaving": "Não foi possível salvar o token."
}
```

Em `messages/en.json`, as mesmas chaves:

```json
"providerMeta": "Official API (Meta)",
"providerUazapi": "QR Code (UAZAPI)",
"uazapi": {
  "title": "QR Code connection",
  "description": "Connect a WhatsApp number by scanning a QR code — no Meta Cloud API required.",
  "tokenLabel": "Instance token",
  "tokenPlaceholder": "Paste the instance token",
  "tokenHelp": "Create an instance in the UAZAPI panel and paste its instance token here.",
  "save": "Save token",
  "connect": "Connect",
  "disconnect": "Disconnect",
  "forget": "Remove configuration",
  "forgetConfirm": "This removes the instance from the CRM. The instance itself stays in your UAZAPI panel. Continue?",
  "statusConnected": "Connected",
  "statusDisconnected": "Disconnected",
  "instanceLabel": "Instance: {name}",
  "scanInstructions": "On your phone: WhatsApp → Linked devices → Link a device.",
  "qrRotates": "The code refreshes on its own. Keep this screen open.",
  "qrAlt": "QR code to connect WhatsApp",
  "qrExpired": "The QR code expired before it was scanned. Click Connect to generate a new one.",
  "tokenCorrupted": "The stored token cannot be decrypted with the current ENCRYPTION_KEY. Remove the configuration and paste the token again.",
  "errorSaving": "Could not save the token."
}
```

Em `messages/ko.json`:

```json
"providerMeta": "공식 API (Meta)",
"providerUazapi": "QR 코드 (UAZAPI)",
"uazapi": {
  "title": "QR 코드 연결",
  "description": "Meta 공식 API 없이 QR 코드를 스캔하여 WhatsApp 번호를 연결합니다.",
  "tokenLabel": "인스턴스 토큰",
  "tokenPlaceholder": "인스턴스 토큰을 붙여넣으세요",
  "tokenHelp": "UAZAPI 패널에서 인스턴스를 만들고 해당 인스턴스 토큰을 여기에 붙여넣으세요.",
  "save": "토큰 저장",
  "connect": "연결",
  "disconnect": "연결 해제",
  "forget": "설정 삭제",
  "forgetConfirm": "CRM에서 인스턴스를 제거합니다. 인스턴스 자체는 UAZAPI 패널에 그대로 남습니다. 계속하시겠습니까?",
  "statusConnected": "연결됨",
  "statusDisconnected": "연결 해제됨",
  "instanceLabel": "인스턴스: {name}",
  "scanInstructions": "휴대폰에서: WhatsApp → 연결된 기기 → 기기 연결.",
  "qrRotates": "코드는 자동으로 갱신됩니다. 이 화면을 열어 두세요.",
  "qrAlt": "WhatsApp 연결용 QR 코드",
  "qrExpired": "QR 코드가 스캔되기 전에 만료되었습니다. 연결을 클릭하여 새로 생성하세요.",
  "tokenCorrupted": "저장된 토큰을 현재 ENCRYPTION_KEY로 복호화할 수 없습니다. 설정을 삭제하고 토큰을 다시 붙여넣으세요.",
  "errorSaving": "토큰을 저장할 수 없습니다."
}
```

- [ ] **Step 2: Conferir que os três arquivos têm as mesmas chaves**

```bash
node -e "
const p=require('./messages/pt.json').Settings.whatsapp;
const e=require('./messages/en.json').Settings.whatsapp;
const k=require('./messages/ko.json').Settings.whatsapp;
const keys=o=>Object.keys(o.uazapi).sort().join(',');
console.log('pt==en:', keys(p)===keys(e));
console.log('pt==ko:', keys(p)===keys(k));
"
```
Esperado: `true` nas duas linhas.

- [ ] **Step 3: Commit**

```bash
git add messages/
git commit -m "i18n(settings): add UAZAPI panel strings (pt, en, ko)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Verificação ao vivo

Nenhum mock aqui — é justamente o que faltou na Fase 1.

**Files:** nenhum (só verificação).

- [ ] **Step 1: Suíte inteira**

Run: `npx vitest run`
Esperado: PASS. Nenhum teste do caminho Meta editado.

- [ ] **Step 2: Build**

Run: `npm run build`
Esperado: sem erros.

- [ ] **Step 3: Fluxo completo com número real**

Com `npm run dev`, em Configurações → WhatsApp → QR Code (UAZAPI):

1. Colar o Instance Token → **Salvar token**.
   Esperado: some o campo, aparece o estado da instância.
2. Colar um token inválido (ex.: `xxx`) numa conta limpa.
   Esperado: erro "UAZAPI rejected this token", **nada é gravado**.
3. **Conectar** → QR aparece em até ~3s.
4. Escanear com o celular.
   Esperado: em até ~8s a tela vira "Conectado", com nome do perfil e número.
5. Conferir no banco:
   ```sql
   SELECT provider, uazapi_status, uazapi_connected_phone, uazapi_instance_name,
          length(uazapi_instance_token) AS token_len,
          length(uazapi_instance_token_hash) AS hash_len
   FROM whatsapp_config WHERE provider = 'uazapi';
   ```
   Esperado: `uazapi_status='connected'`, telefone preenchido só com dígitos,
   `hash_len=64`, `token_len` bem maior que 36 (prova que está cifrado, não cru).
6. **Desconectar** → volta a "Desconectado"; **Conectar** de novo gera QR novo.
7. Deixar um QR expirar sem escanear (~5 min).
   Esperado: aparece o aviso de expiração, não um QR morto.

- [ ] **Step 4: Provar que a Meta não regrediu**

Numa conta configurada com Meta: abrir Configurações → WhatsApp.
Esperado: abre na aba Meta, formulário idêntico, "Test API Connection" segue
funcionando. Enviar uma mensagem por essa conta e confirmar que chega.

- [ ] **Step 5: Registrar os contratos que só agora deram para verificar**

Atualizar a seção "Ainda não verificado" do apêndice do design com o que este
teste revelou (corpo de erro de token inválido, tempo típico até conectar).

- [ ] **Step 6: Commit final**

```bash
git add docs/superpowers/specs/2026-08-03-uazapi-provider-design.md
git commit -m "docs(whatsapp): record contracts verified during Fase 2 acceptance

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Fora do escopo desta fase

Confirmado que ficam para a Fase 3, sem bloqueio técnico conhecido:

- Envio e recebimento de mensagens pelo caminho UAZAPI (`/send/*`, webhook
  `messages`) — `provider.ts` já roteia, mas nenhum call site o usa ainda.
- `POST /webhook` para registrar a URL de callback.
- Extração de `processMessage` para `src/lib/whatsapp/inbound.ts`.
- Guards de provedor em templates, interativos, broadcast e reações.
- Recebimento de mídia via `POST /message/download` (viável na v2).
- `msg_delay_min`/`max` configuráveis pela UI.
