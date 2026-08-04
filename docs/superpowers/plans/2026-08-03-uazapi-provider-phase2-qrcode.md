# UAZAPI Provider — Fase 2 (Conexão por QR Code) Implementation Plan

> # ⛔ SUPERADO — NÃO EXECUTAR
>
> Este plano foi escrito contra a **API v1 da UAZAPI**, que está oficialmente
> descontinuada e **não existe** no servidor contratado
> (`balligroup.uazapi.com` roda a v2). Todo endpoint que ele assume
> (`/start`, `/getQrCode`, `/getSessionStatus`, `/closeSession`, `/sendText`)
> responde 405 — o mesmo que uma rota inventada.
>
> Mantido apenas como registro. A estrutura de tarefas 6 a 10 (rota Meta,
> split do componente, seletor, painel, verificação) continua aproveitável;
> as tarefas 1 a 5 não.
>
> Ver o design revisado em
> `docs/superpowers/specs/2026-08-03-uazapi-provider-design.md`, seção
> "Revisão — a API mudou de versão".

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an account choose UAZAPI in Settings → WhatsApp, connect a real
WhatsApp number by scanning a QR code, see live connection status, and
disconnect — without sending or receiving messages yet (that's Fase 3).

**Architecture:** Three thin API routes (`connect` / `status` / `disconnect`)
drive the UAZAPI session lifecycle using the `uazapi-api.ts` client built in
Fase 1. The UI polls `status`, which asks UAZAPI for the live session state and
fetches the QR code on demand — deliberately stateless, because serverless
instances share no memory. A separate inbound webhook route keeps the stored
status fresh in the background. The 883-line `whatsapp-config.tsx` is split into
a container plus one panel per provider. See the design doc for full context:
`docs/superpowers/specs/2026-08-03-uazapi-provider-design.md`.

**Tech Stack:** Next.js 16 / TypeScript, Supabase (Postgres), next-intl, Vitest.

## Global Constraints

- **Nothing in the Meta path may change behavior.** Existing `provider='meta'`
  rows must connect, save, and send exactly as before. Task 6 and Task 7 touch
  Meta code — both are behavior-preserving by construction and must be verified
  as such.
- Secrets at rest (`uazapi_session_key`) are encrypted with
  `src/lib/whatsapp/encryption.ts` (AES-256-GCM, key from `ENCRYPTION_KEY`).
  Never store or return a session key in plaintext.
- `UAZAPI_ENDPOINT` / `UAZAPI_TOKEN` are server-only env vars — never read on
  the client, never exposed via `NEXT_PUBLIC_*`.
- The `sessionkey` is bearer-equivalent for every UAZAPI endpoint after
  `/start`, and `getQrCode` puts it in a **query string**. Never log a UAZAPI
  URL, never include one in a client-facing error message.
- `uazapi_status` stores UAZAPI's raw string verbatim (`notLogged`, `STARTING`,
  `inChat`, `disconnectedMobile`, …). Do not normalize it into a local enum.
- API helper functions use named-parameter objects, never positional args
  (established in `meta-api.ts`).
- Mutating routes are **admin-only** (`requireRole('admin')`); reads that expose
  a QR code are admin-only too — scanning one links a real WhatsApp account.
- All three locale files (`messages/pt.json`, `messages/en.json`,
  `messages/ko.json`) must keep exact key parity. Verify with the script in
  Task 8. Portuguese is the live locale (`NEXT_PUBLIC_APP_LOCALE=pt`).
- Run `npm run typecheck` and `npm test` after every task — both must be clean
  before moving on.

---

### Task 1: Session credentials and webhook URL resolution

Pure helpers, no I/O. Everything else in this phase depends on them.

**Files:**
- Create: `src/lib/whatsapp/uazapi-session.ts`
- Test: `src/lib/whatsapp/uazapi-session.test.ts`

**Interfaces:**
- Consumes: `UazapiWebhooks` from `src/lib/whatsapp/uazapi-api.ts` (Fase 1):
  `{ connect: string; qrcode: string; status: string; message: string }`
- Produces:
  - `generateSessionId(): string`
  - `generateSessionKey(): string`
  - `buildWebhookUrls(baseUrl: string, session: string): UazapiWebhooks`
  - `resolveWebhookBaseUrl(request: Request): string` (throws `WebhookBaseUrlError`)
  - `class WebhookBaseUrlError extends Error`
  - `isConnectedStatus(status: string | null | undefined): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/lib/whatsapp/uazapi-session.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWebhookUrls,
  generateSessionId,
  generateSessionKey,
  isConnectedStatus,
  resolveWebhookBaseUrl,
  WebhookBaseUrlError,
} from './uazapi-session';

const ORIGINAL_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

afterEach(() => {
  if (ORIGINAL_SITE_URL === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL_SITE_URL;
});

describe('generateSessionId', () => {
  it('is prefixed, hex, and unguessably long', () => {
    const id = generateSessionId();
    expect(id).toMatch(/^balli_[0-9a-f]{32}$/);
  });

  it('never repeats across many draws', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateSessionId()));
    expect(ids.size).toBe(500);
  });
});

describe('generateSessionKey', () => {
  it('is 64 hex chars (32 bytes)', () => {
    expect(generateSessionKey()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never repeats across many draws', () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateSessionKey()));
    expect(keys.size).toBe(500);
  });
});

describe('buildWebhookUrls', () => {
  it('points all four hooks at this account-specific route', () => {
    const urls = buildWebhookUrls('https://ballicrm.com', 'balli_abc');
    const expected = 'https://ballicrm.com/api/whatsapp/webhook/uazapi/balli_abc';
    expect(urls).toEqual({
      connect: expected,
      qrcode: expected,
      status: expected,
      message: expected,
    });
  });

  it('tolerates a trailing slash on the base URL', () => {
    const urls = buildWebhookUrls('https://ballicrm.com/', 'balli_abc');
    expect(urls.message).toBe(
      'https://ballicrm.com/api/whatsapp/webhook/uazapi/balli_abc',
    );
  });
});

describe('resolveWebhookBaseUrl', () => {
  function req(headers: Record<string, string> = {}): Request {
    return new Request('https://ballicrm.com/api/whatsapp/uazapi/connect', {
      method: 'POST',
      headers,
    });
  }

  it('prefers NEXT_PUBLIC_SITE_URL', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://ballicrm.com';
    expect(resolveWebhookBaseUrl(req({ host: 'ignored.example' }))).toBe(
      'https://ballicrm.com',
    );
  });

  it('strips a trailing slash from NEXT_PUBLIC_SITE_URL', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://ballicrm.com/';
    expect(resolveWebhookBaseUrl(req())).toBe('https://ballicrm.com');
  });

  it('falls back to x-forwarded-host when the env var is unset', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(
      resolveWebhookBaseUrl(
        req({ 'x-forwarded-host': 'crm.example.com', 'x-forwarded-proto': 'https' }),
      ),
    ).toBe('https://crm.example.com');
  });

  it('rejects localhost — UAZAPI servers cannot reach it', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3000';
    expect(() => resolveWebhookBaseUrl(req())).toThrow(WebhookBaseUrlError);
  });

  it('rejects plain http — the callback would carry the session in the clear', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'http://ballicrm.com';
    expect(() => resolveWebhookBaseUrl(req())).toThrow(WebhookBaseUrlError);
  });

  it('rejects when nothing identifies the host', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    // A Request built without a Host header still exposes one derived from
    // the URL, so simulate the no-host case with an explicit empty value.
    const bare = { headers: { get: () => null } } as unknown as Request;
    expect(() => resolveWebhookBaseUrl(bare)).toThrow(WebhookBaseUrlError);
  });
});

describe('isConnectedStatus', () => {
  it('treats inChat as connected, case-insensitively', () => {
    expect(isConnectedStatus('inChat')).toBe(true);
    expect(isConnectedStatus('INCHAT')).toBe(true);
  });

  it('treats every other state as not connected', () => {
    expect(isConnectedStatus('notLogged')).toBe(false);
    expect(isConnectedStatus('STARTING')).toBe(false);
    expect(isConnectedStatus('disconnectedMobile')).toBe(false);
    expect(isConnectedStatus(null)).toBe(false);
    expect(isConnectedStatus(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/uazapi-session.test.ts`
Expected: FAIL — `Failed to resolve import "./uazapi-session"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/whatsapp/uazapi-session.ts`:

```ts
/**
 * Session credentials and webhook wiring for the UAZAPI provider.
 *
 * Pure functions, no I/O — the routes in this phase own all the
 * network and database work and call in here for the values.
 */

import crypto from 'crypto';
import type { UazapiWebhooks } from './uazapi-api';

/**
 * The session id lands in the webhook URL path, and UAZAPI does not
 * sign its callbacks — so this string IS the authentication for every
 * inbound event. 16 random bytes (128 bits) puts brute-force
 * enumeration out of reach. The `balli_` prefix makes a session
 * recognisable in the UAZAPI dashboard next to any other tenant's.
 */
export function generateSessionId(): string {
  return `balli_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Bearer-equivalent credential for every UAZAPI endpoint after
 * /start. Stored encrypted; never returned to the browser.
 */
export function generateSessionKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * All four UAZAPI webhooks point at one route. The route discriminates
 * on the event type in the body, which keeps the session→account
 * lookup in a single place instead of four near-identical handlers.
 */
export function buildWebhookUrls(baseUrl: string, session: string): UazapiWebhooks {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/whatsapp/webhook/uazapi/${encodeURIComponent(session)}`;
  return { connect: url, qrcode: url, status: url, message: url };
}

export class WebhookBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookBaseUrlError';
  }
}

const PRIVATE_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/**
 * Resolve the public origin UAZAPI will call back on.
 *
 * Unlike the invite-link equivalent in `/api/account/invitations`, a
 * wrong value here fails *silently and permanently*: UAZAPI accepts
 * the /start call, then posts every inbound message into the void. So
 * this validates rather than falling back to a default domain —
 * a loud 400 at connect time beats a number that looks connected and
 * never delivers anything.
 *
 * Rejects http and private hostnames for the same reason: UAZAPI's
 * servers are on the public internet and the session id in the path
 * is a credential.
 */
export function resolveWebhookBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const candidate = explicit || deriveFromHeaders(request);

  if (!candidate) {
    throw new WebhookBaseUrlError(
      'Could not determine this deployment’s public URL. Set NEXT_PUBLIC_SITE_URL to your canonical https URL and redeploy.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new WebhookBaseUrlError(
      `NEXT_PUBLIC_SITE_URL is not a valid URL: ${candidate}`,
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new WebhookBaseUrlError(
      `UAZAPI webhooks require an https URL; got ${parsed.protocol}//. Set NEXT_PUBLIC_SITE_URL to your public https URL.`,
    );
  }
  if (PRIVATE_HOSTNAMES.has(parsed.hostname)) {
    throw new WebhookBaseUrlError(
      `UAZAPI cannot reach ${parsed.hostname}. Connect from your deployed site, or point NEXT_PUBLIC_SITE_URL at a public tunnel.`,
    );
  }

  return `${parsed.protocol}//${parsed.host}`;
}

function deriveFromHeaders(request: Request): string | null {
  const forwardedHost = request.headers
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim();
  if (forwardedHost) {
    const proto =
      request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
    return `${proto}://${forwardedHost}`;
  }
  const host = request.headers.get('host')?.trim();
  return host ? `https://${host}` : null;
}

/**
 * UAZAPI reports `inChat` once the phone has scanned the code and the
 * session is live. Every other documented state (notLogged, STARTING,
 * disconnectedMobile) means "not usable yet". Kept as a single
 * function so the routes and the UI can never disagree on what
 * "connected" means.
 */
export function isConnectedStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && status.toLowerCase() === 'inchat';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/uazapi-session.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean; 665 existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/uazapi-session.ts src/lib/whatsapp/uazapi-session.test.ts
git commit -m "feat(whatsapp): add UAZAPI session credential and webhook URL helpers"
```

---

### Task 2: `POST /api/whatsapp/uazapi/connect`

Creates (or refreshes) the account's UAZAPI session and asks UAZAPI to start it,
which is what triggers QR-code generation.

**Files:**
- Create: `src/app/api/whatsapp/uazapi/connect/route.ts`
- Test: `src/app/api/whatsapp/uazapi/connect/route.test.ts`

**Interfaces:**
- Consumes: `generateSessionId`, `generateSessionKey`, `buildWebhookUrls`,
  `resolveWebhookBaseUrl`, `WebhookBaseUrlError` (Task 1); `startSession` from
  `uazapi-api.ts`; `encrypt` from `encryption.ts`; `requireRole`,
  `toErrorResponse` from `@/lib/auth/account`.
- Produces: `POST` handler.
  - 200 → `{ session: string; status: string }`
  - 409 → `{ error: string; requiresConfirmation: true }` when the account
    currently has a Meta config and the body omitted `confirmReplace: true`
  - 400 → `{ error: string }` for a bad base URL
  - 502 → `{ error: string }` when UAZAPI rejects `/start`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/whatsapp/uazapi/connect/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Row the mocked Supabase client returns for whatsapp_config, and a
// record of what the route wrote back.
let existingConfig: Record<string, unknown> | null = null;
const updates: Array<Record<string, unknown>> = [];
const inserts: Array<Record<string, unknown>> = [];

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>(
    '@/lib/auth/account',
  );
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      supabase: makeSupabaseMock(),
      userId: 'user-1',
      accountId: 'acct-1',
      role: 'admin' as const,
      account: { id: 'acct-1', name: 'Balli' },
    })),
  };
});

vi.mock('@/lib/whatsapp/uazapi-api', () => ({
  startSession: vi.fn(async () => ({ state: 'starting', status: 'notLogged' })),
}));

function makeSupabaseMock() {
  function builder() {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ['select', 'eq']) b[m] = vi.fn(chain);
    b.update = vi.fn((payload: Record<string, unknown>) => {
      updates.push(payload);
      return b;
    });
    b.insert = vi.fn((payload: Record<string, unknown>) => {
      inserts.push(payload);
      return b;
    });
    b.maybeSingle = vi.fn(async () => ({ data: existingConfig, error: null }));
    // `update(...).eq(...)` is awaited directly by the route.
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(resolve);
    return b;
  }
  return { from: vi.fn(() => builder()) };
}

const { POST } = await import('./route');
const { startSession } = await import('@/lib/whatsapp/uazapi-api');
const { decrypt, encrypt } = await import('@/lib/whatsapp/encryption');

function request(body: unknown = {}): Request {
  return new Request('https://ballicrm.com/api/whatsapp/uazapi/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  existingConfig = null;
  updates.length = 0;
  inserts.length = 0;
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SITE_URL = 'https://ballicrm.com';
});

describe('POST /api/whatsapp/uazapi/connect', () => {
  it('creates a session for an account with no config and stores the key encrypted', async () => {
    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.session).toMatch(/^balli_[0-9a-f]{32}$/);
    expect(body.status).toBe('notLogged');

    // /start got the four webhook URLs for this session.
    const args = vi.mocked(startSession).mock.calls[0][0];
    const expectedUrl = `https://ballicrm.com/api/whatsapp/webhook/uazapi/${body.session}`;
    expect(args.webhooks).toEqual({
      connect: expectedUrl,
      qrcode: expectedUrl,
      status: expectedUrl,
      message: expectedUrl,
    });

    // The row stores ciphertext, and it round-trips to what UAZAPI got.
    expect(inserts).toHaveLength(1);
    const row = inserts[0];
    expect(row.provider).toBe('uazapi');
    expect(row.uazapi_session).toBe(body.session);
    expect(row.uazapi_session_key).not.toBe(args.sessionkey);
    expect(decrypt(row.uazapi_session_key as string)).toBe(args.sessionkey);
  });

  it('never returns the session key to the caller', async () => {
    const res = await POST(request());
    const raw = JSON.stringify(await res.json());
    const args = vi.mocked(startSession).mock.calls[0][0];
    expect(raw).not.toContain(args.sessionkey);
  });

  it('refuses to clobber a Meta config without explicit confirmation', async () => {
    existingConfig = {
      id: 'cfg-1',
      provider: 'meta',
      phone_number_id: 'PNID-1',
      access_token: 'enc',
    };

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.requiresConfirmation).toBe(true);
    expect(startSession).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('replaces a Meta config when confirmReplace is set, clearing Meta fields', async () => {
    existingConfig = {
      id: 'cfg-1',
      provider: 'meta',
      phone_number_id: 'PNID-1',
      access_token: 'enc',
    };

    const res = await POST(request({ confirmReplace: true }));

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].provider).toBe('uazapi');
    expect(updates[0].phone_number_id).toBeNull();
    expect(updates[0].access_token).toBeNull();
    expect(updates[0].waba_id).toBeNull();
  });

  it('reuses the existing session id when reconnecting an UAZAPI account', async () => {
    existingConfig = {
      id: 'cfg-1',
      provider: 'uazapi',
      uazapi_session: 'balli_existing',
      uazapi_session_key: encrypt('key-1'),
    };

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.session).toBe('balli_existing');
    // Same credentials replayed — /start re-issues a QR for the session.
    const args = vi.mocked(startSession).mock.calls[0][0];
    expect(args.session).toBe('balli_existing');
    expect(args.sessionkey).toBe('key-1');
  });

  it('rejects a localhost deployment with a 400 instead of registering a dead webhook', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3000';

    const res = await POST(request());

    expect(res.status).toBe(400);
    expect(startSession).not.toHaveBeenCalled();
  });

  it('returns 502 and saves nothing when UAZAPI rejects /start', async () => {
    vi.mocked(startSession).mockRejectedValueOnce(new Error('subscription expired'));

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain('subscription expired');
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/whatsapp/uazapi/connect/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`.

- [ ] **Step 3: Write the implementation**

Create `src/app/api/whatsapp/uazapi/connect/route.ts`:

```ts
// ============================================================
// POST /api/whatsapp/uazapi/connect
//
// Admin-only. Creates (or refreshes) this account's UAZAPI session
// and calls /start, which is what makes UAZAPI generate a QR code.
// The browser then polls /api/whatsapp/uazapi/status to fetch it.
//
// We call UAZAPI BEFORE writing the row: a failed /start must leave
// the account exactly as it was, rather than stranding it on a
// provider='uazapi' row pointing at a session that was never created.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { startSession } from '@/lib/whatsapp/uazapi-api';
import {
  buildWebhookUrls,
  generateSessionId,
  generateSessionKey,
  resolveWebhookBaseUrl,
  WebhookBaseUrlError,
} from '@/lib/whatsapp/uazapi-session';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `uazapi:connect:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      confirmReplace?: unknown;
    } | null;
    const confirmReplace = body?.confirmReplace === true;

    let baseUrl: string;
    try {
      baseUrl = resolveWebhookBaseUrl(request);
    } catch (err) {
      if (err instanceof WebhookBaseUrlError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    const { data: existing, error: loadError } = await ctx.supabase
      .from('whatsapp_config')
      .select(
        'id, provider, phone_number_id, uazapi_session, uazapi_session_key',
      )
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (loadError) {
      console.error('[uazapi/connect] config load failed:', loadError);
      return NextResponse.json(
        { error: 'Failed to load the current WhatsApp configuration.' },
        { status: 500 },
      );
    }

    // Switching away from a working Meta number is destructive and
    // silent from the user's point of view, so it takes a second
    // deliberate click rather than happening on the first one.
    if (existing && existing.provider === 'meta' && !confirmReplace) {
      return NextResponse.json(
        {
          error:
            'This account is currently connected through the Meta API. Connecting UAZAPI will remove those credentials.',
          requiresConfirmation: true,
        },
        { status: 409 },
      );
    }

    // Reconnecting an existing UAZAPI account replays the same
    // credentials: /start on a live session is how UAZAPI issues a
    // fresh QR code once the previous one expired. Generating new
    // ones would orphan the old session on the subscription.
    const reusing =
      existing?.provider === 'uazapi' &&
      typeof existing.uazapi_session === 'string' &&
      typeof existing.uazapi_session_key === 'string';

    let session: string;
    let sessionkey: string;
    if (reusing) {
      session = existing!.uazapi_session as string;
      try {
        sessionkey = decrypt(existing!.uazapi_session_key as string);
      } catch (err) {
        console.error('[uazapi/connect] session key decrypt failed:', err);
        return NextResponse.json(
          {
            error:
              'The stored UAZAPI session key cannot be decrypted with the current ENCRYPTION_KEY. Disconnect and connect again to issue a new session.',
          },
          { status: 500 },
        );
      }
    } else {
      session = generateSessionId();
      sessionkey = generateSessionKey();
    }

    let started: { state: string; status: string };
    try {
      started = await startSession({
        session,
        sessionkey,
        webhooks: buildWebhookUrls(baseUrl, session),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown UAZAPI error';
      console.error('[uazapi/connect] /start failed:', message);
      return NextResponse.json(
        { error: `UAZAPI rejected the connection: ${message}` },
        { status: 502 },
      );
    }

    // One statement per row so the provider CHECK constraint never
    // sees a half-written row (provider flipped, session still null).
    const row = {
      provider: 'uazapi',
      uazapi_session: session,
      uazapi_session_key: encrypt(sessionkey),
      uazapi_status: started.status,
      uazapi_connected_phone: null,
      // Clearing the Meta side is what makes the switch a switch —
      // leaving stale credentials behind would let a later code path
      // pick the wrong provider.
      phone_number_id: null,
      waba_id: null,
      access_token: null,
      verify_token: null,
      registered_at: null,
      subscribed_apps_at: null,
      last_registration_error: null,
      status: 'disconnected',
      connected_at: null,
      updated_at: new Date().toISOString(),
    };

    const { error: writeError } = existing
      ? await ctx.supabase
          .from('whatsapp_config')
          .update(row)
          .eq('account_id', ctx.accountId)
      : await ctx.supabase
          .from('whatsapp_config')
          .insert({ account_id: ctx.accountId, user_id: ctx.userId, ...row });

    if (writeError) {
      console.error('[uazapi/connect] config write failed:', writeError);
      return NextResponse.json(
        { error: 'Failed to save the UAZAPI session.' },
        { status: 500 },
      );
    }

    // `session` is safe to return (the browser needs nothing else to
    // poll); `sessionkey` deliberately is not.
    return NextResponse.json({ session, status: started.status });
  } catch (err) {
    return toErrorResponse(err);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/api/whatsapp/uazapi/connect/route.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/uazapi/connect
git commit -m "feat(whatsapp): add UAZAPI connect route that starts a QR session"
```

---

### Task 3: `GET /api/whatsapp/uazapi/status`

The endpoint the UI polls. Asks UAZAPI for live state and fetches the QR code
on demand when the session isn't connected yet.

**Files:**
- Create: `src/app/api/whatsapp/uazapi/status/route.ts`
- Test: `src/app/api/whatsapp/uazapi/status/route.test.ts`

**Interfaces:**
- Consumes: `getSessionStatus`, `getQrCode` from `uazapi-api.ts`;
  `isConnectedStatus` (Task 1); `decrypt`; `requireRole`.
- Produces: `GET` handler returning 200 with
  `{ configured: boolean; status: string | null; connected: boolean; connectedPhone: string | null; qrDataUri: string | null; error?: string }`.
  Always 200 for authenticated admins so the polling UI can render a state
  instead of handling HTTP errors on every tick.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/whatsapp/uazapi/status/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

let existingConfig: Record<string, unknown> | null = null;
const updates: Array<Record<string, unknown>> = [];

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>(
    '@/lib/auth/account',
  );
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      supabase: makeSupabaseMock(),
      userId: 'user-1',
      accountId: 'acct-1',
      role: 'admin' as const,
      account: { id: 'acct-1', name: 'Balli' },
    })),
  };
});

vi.mock('@/lib/whatsapp/uazapi-api', () => ({
  getSessionStatus: vi.fn(async () => ({ state: 'starting', status: 'notLogged' })),
  getQrCode: vi.fn(async () => ({ dataUri: 'data:image/png;base64,AAAA' })),
}));

function makeSupabaseMock() {
  function builder() {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ['select', 'eq']) b[m] = vi.fn(chain);
    b.update = vi.fn((payload: Record<string, unknown>) => {
      updates.push(payload);
      return b;
    });
    b.maybeSingle = vi.fn(async () => ({ data: existingConfig, error: null }));
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(resolve);
    return b;
  }
  return { from: vi.fn(() => builder()) };
}

const { GET } = await import('./route');
const { getSessionStatus, getQrCode } = await import('@/lib/whatsapp/uazapi-api');
const { encrypt } = await import('@/lib/whatsapp/encryption');

function uazapiRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cfg-1',
    provider: 'uazapi',
    uazapi_session: 'balli_abc',
    uazapi_session_key: encrypt('key-1'),
    uazapi_status: 'notLogged',
    uazapi_connected_phone: null,
    ...overrides,
  };
}

beforeEach(() => {
  existingConfig = null;
  updates.length = 0;
  vi.clearAllMocks();
});

describe('GET /api/whatsapp/uazapi/status', () => {
  it('reports not-configured when the account has no row', async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.configured).toBe(false);
    expect(getSessionStatus).not.toHaveBeenCalled();
  });

  it('reports not-configured when the account is on the Meta provider', async () => {
    existingConfig = { id: 'cfg-1', provider: 'meta', phone_number_id: 'PNID-1' };

    const body = await (await GET()).json();

    expect(body.configured).toBe(false);
    expect(getSessionStatus).not.toHaveBeenCalled();
  });

  it('returns a QR code while the session is waiting to be scanned', async () => {
    existingConfig = uazapiRow();

    const body = await (await GET()).json();

    expect(body.configured).toBe(true);
    expect(body.connected).toBe(false);
    expect(body.status).toBe('notLogged');
    expect(body.qrDataUri).toBe('data:image/png;base64,AAAA');
    expect(getSessionStatus).toHaveBeenCalledWith({
      session: 'balli_abc',
      sessionkey: 'key-1',
    });
  });

  it('skips the QR fetch once the session is connected', async () => {
    existingConfig = uazapiRow({ uazapi_connected_phone: '5511999999999' });
    vi.mocked(getSessionStatus).mockResolvedValueOnce({
      state: 'connected',
      status: 'inChat',
    });

    const body = await (await GET()).json();

    expect(body.connected).toBe(true);
    expect(body.status).toBe('inChat');
    expect(body.connectedPhone).toBe('5511999999999');
    expect(body.qrDataUri).toBeNull();
    expect(getQrCode).not.toHaveBeenCalled();
  });

  it('persists a status that changed since the last poll', async () => {
    existingConfig = uazapiRow({ uazapi_status: 'notLogged' });
    vi.mocked(getSessionStatus).mockResolvedValueOnce({
      state: 'connected',
      status: 'inChat',
    });

    await GET();

    expect(updates).toHaveLength(1);
    expect(updates[0].uazapi_status).toBe('inChat');
    expect(updates[0].status).toBe('connected');
  });

  it('does not write when the status is unchanged', async () => {
    existingConfig = uazapiRow({ uazapi_status: 'notLogged' });

    await GET();

    expect(updates).toHaveLength(0);
  });

  it('still reports the stored status when UAZAPI is unreachable', async () => {
    existingConfig = uazapiRow();
    vi.mocked(getSessionStatus).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.status).toBe('notLogged');
    expect(body.error).toBeTruthy();
  });

  it('never leaks the session key in the response', async () => {
    existingConfig = uazapiRow();

    const raw = JSON.stringify(await (await GET()).json());

    expect(raw).not.toContain('key-1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/whatsapp/uazapi/status/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`.

- [ ] **Step 3: Write the implementation**

Create `src/app/api/whatsapp/uazapi/status/route.ts`:

```ts
// ============================================================
// GET /api/whatsapp/uazapi/status
//
// Admin-only; polled by the settings panel every few seconds while a
// QR code is on screen.
//
// The live UAZAPI call — not the stored column — is the source of
// truth here. The QR code is fetched on demand rather than read from
// the wh_qrcode webhook because these routes run as stateless
// serverless functions: the instance that received the webhook and
// the one answering this request share no memory, so any in-process
// cache would work locally and fail intermittently in production.
//
// Always answers 200 for an authenticated admin. A polling loop that
// has to branch on HTTP status for every transient UAZAPI hiccup is
// harder to get right than one that reads a field.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getQrCode, getSessionStatus } from '@/lib/whatsapp/uazapi-api';
import { isConnectedStatus } from '@/lib/whatsapp/uazapi-session';

export async function GET() {
  try {
    const ctx = await requireRole('admin');

    const { data: config, error } = await ctx.supabase
      .from('whatsapp_config')
      .select(
        'provider, uazapi_session, uazapi_session_key, uazapi_status, uazapi_connected_phone',
      )
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[uazapi/status] config load failed:', error);
      return NextResponse.json(
        {
          configured: false,
          status: null,
          connected: false,
          connectedPhone: null,
          qrDataUri: null,
          error: 'Failed to load the WhatsApp configuration.',
        },
        { status: 200 },
      );
    }

    if (
      !config ||
      config.provider !== 'uazapi' ||
      !config.uazapi_session ||
      !config.uazapi_session_key
    ) {
      return NextResponse.json({
        configured: false,
        status: null,
        connected: false,
        connectedPhone: null,
        qrDataUri: null,
      });
    }

    const storedStatus: string | null = config.uazapi_status ?? null;
    const connectedPhone: string | null = config.uazapi_connected_phone ?? null;

    let sessionkey: string;
    try {
      sessionkey = decrypt(config.uazapi_session_key);
    } catch (err) {
      console.error('[uazapi/status] session key decrypt failed:', err);
      return NextResponse.json({
        configured: true,
        status: storedStatus,
        connected: false,
        connectedPhone,
        qrDataUri: null,
        error:
          'The stored UAZAPI session key cannot be decrypted with the current ENCRYPTION_KEY. Disconnect and connect again.',
      });
    }

    const session = config.uazapi_session as string;

    let liveStatus: string;
    try {
      const result = await getSessionStatus({ session, sessionkey });
      liveStatus = result.status;
    } catch (err) {
      // UAZAPI is an unofficial service on someone else's hardware;
      // a blip must not blank the panel. Report what we last knew.
      const message = err instanceof Error ? err.message : 'Unknown UAZAPI error';
      console.error('[uazapi/status] getSessionStatus failed:', message);
      return NextResponse.json({
        configured: true,
        status: storedStatus,
        connected: isConnectedStatus(storedStatus),
        connectedPhone,
        qrDataUri: null,
        error: `Could not reach UAZAPI: ${message}`,
      });
    }

    const connected = isConnectedStatus(liveStatus);

    // Keep the row in step with reality so other surfaces (and Fase 3)
    // read a fresh value without polling UAZAPI themselves.
    if (liveStatus !== storedStatus) {
      const { error: updateError } = await ctx.supabase
        .from('whatsapp_config')
        .update({
          uazapi_status: liveStatus,
          status: connected ? 'connected' : 'disconnected',
          connected_at: connected ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', ctx.accountId);
      if (updateError) {
        // Non-fatal: the caller still gets the live value.
        console.error('[uazapi/status] status persist failed:', updateError);
      }
    }

    let qrDataUri: string | null = null;
    if (!connected) {
      try {
        const qr = await getQrCode({ session, sessionkey });
        qrDataUri = qr.dataUri;
      } catch (err) {
        // Normal between QR rotations — UAZAPI has no code to hand out
        // for a moment. The next poll picks one up.
        const message = err instanceof Error ? err.message : 'Unknown UAZAPI error';
        console.warn('[uazapi/status] getQrCode failed:', message);
      }
    }

    return NextResponse.json({
      configured: true,
      status: liveStatus,
      connected,
      connectedPhone,
      qrDataUri,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/api/whatsapp/uazapi/status/route.test.ts`
Expected: PASS, all eight cases.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/uazapi/status
git commit -m "feat(whatsapp): add UAZAPI status route with on-demand QR fetch"
```

---

### Task 4: `POST /api/whatsapp/uazapi/disconnect`

**Files:**
- Create: `src/app/api/whatsapp/uazapi/disconnect/route.ts`
- Test: `src/app/api/whatsapp/uazapi/disconnect/route.test.ts`

**Interfaces:**
- Consumes: `closeSession` from `uazapi-api.ts`; `decrypt`; `requireRole`.
- Produces: `POST` handler → 200 `{ success: true }`.
  Keeps the row and the session id so "Connect" re-issues a QR for the same
  session; only the WhatsApp login is dropped.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/whatsapp/uazapi/disconnect/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

let existingConfig: Record<string, unknown> | null = null;
const updates: Array<Record<string, unknown>> = [];

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>(
    '@/lib/auth/account',
  );
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      supabase: makeSupabaseMock(),
      userId: 'user-1',
      accountId: 'acct-1',
      role: 'admin' as const,
      account: { id: 'acct-1', name: 'Balli' },
    })),
  };
});

vi.mock('@/lib/whatsapp/uazapi-api', () => ({
  closeSession: vi.fn(async () => undefined),
}));

function makeSupabaseMock() {
  function builder() {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ['select', 'eq']) b[m] = vi.fn(chain);
    b.update = vi.fn((payload: Record<string, unknown>) => {
      updates.push(payload);
      return b;
    });
    b.maybeSingle = vi.fn(async () => ({ data: existingConfig, error: null }));
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(resolve);
    return b;
  }
  return { from: vi.fn(() => builder()) };
}

const { POST } = await import('./route');
const { closeSession } = await import('@/lib/whatsapp/uazapi-api');
const { encrypt } = await import('@/lib/whatsapp/encryption');

beforeEach(() => {
  existingConfig = null;
  updates.length = 0;
  vi.clearAllMocks();
});

describe('POST /api/whatsapp/uazapi/disconnect', () => {
  it('closes the session and clears the connected phone, keeping the session id', async () => {
    existingConfig = {
      provider: 'uazapi',
      uazapi_session: 'balli_abc',
      uazapi_session_key: encrypt('key-1'),
      uazapi_connected_phone: '5511999999999',
    };

    const res = await POST();

    expect(res.status).toBe(200);
    expect(closeSession).toHaveBeenCalledWith({
      session: 'balli_abc',
      sessionkey: 'key-1',
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].uazapi_status).toBe('notLogged');
    expect(updates[0].uazapi_connected_phone).toBeNull();
    expect(updates[0].status).toBe('disconnected');
    // The session itself survives so Connect can re-issue a QR.
    expect(updates[0]).not.toHaveProperty('uazapi_session');
  });

  it('is a no-op for an account that is not on UAZAPI', async () => {
    existingConfig = { provider: 'meta', phone_number_id: 'PNID-1' };

    const res = await POST();

    expect(res.status).toBe(200);
    expect(closeSession).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('still clears local state when UAZAPI refuses the close', async () => {
    existingConfig = {
      provider: 'uazapi',
      uazapi_session: 'balli_abc',
      uazapi_session_key: encrypt('key-1'),
    };
    vi.mocked(closeSession).mockRejectedValueOnce(new Error('session not found'));

    const res = await POST();

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].uazapi_status).toBe('notLogged');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/whatsapp/uazapi/disconnect/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`.

- [ ] **Step 3: Write the implementation**

Create `src/app/api/whatsapp/uazapi/disconnect/route.ts`:

```ts
// ============================================================
// POST /api/whatsapp/uazapi/disconnect
//
// Admin-only. Logs the phone out of the UAZAPI session but keeps the
// session (and its id) alive, so "Connect" issues a fresh QR for the
// same session instead of orphaning one on the subscription.
//
// Removing the configuration entirely is a different action —
// DELETE /api/whatsapp/config, behind the existing "Reset" button.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { decrypt } from '@/lib/whatsapp/encryption';
import { closeSession } from '@/lib/whatsapp/uazapi-api';

export async function POST() {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `uazapi:disconnect:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { data: config, error } = await ctx.supabase
      .from('whatsapp_config')
      .select('provider, uazapi_session, uazapi_session_key')
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[uazapi/disconnect] config load failed:', error);
      return NextResponse.json(
        { error: 'Failed to load the WhatsApp configuration.' },
        { status: 500 },
      );
    }

    if (!config || config.provider !== 'uazapi' || !config.uazapi_session) {
      // Nothing to disconnect. Idempotent by design — the UI may fire
      // this after a reload where the row already changed.
      return NextResponse.json({ success: true });
    }

    if (config.uazapi_session_key) {
      try {
        await closeSession({
          session: config.uazapi_session,
          sessionkey: decrypt(config.uazapi_session_key),
        });
      } catch (err) {
        // Deliberately non-fatal. If UAZAPI already dropped the
        // session, or the key no longer decrypts, the user still
        // wants the local state to stop claiming "connected".
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[uazapi/disconnect] closeSession failed:', message);
      }
    }

    const { error: updateError } = await ctx.supabase
      .from('whatsapp_config')
      .update({
        uazapi_status: 'notLogged',
        uazapi_connected_phone: null,
        status: 'disconnected',
        connected_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', ctx.accountId);

    if (updateError) {
      console.error('[uazapi/disconnect] config update failed:', updateError);
      return NextResponse.json(
        { error: 'Failed to update the WhatsApp configuration.' },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/api/whatsapp/uazapi/disconnect/route.test.ts`
Expected: PASS, all three cases.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/uazapi/disconnect
git commit -m "feat(whatsapp): add UAZAPI disconnect route"
```

---

### Task 5: Inbound webhook route — `QRCODE` and `STATUS_CONNECT`

Keeps the stored status fresh in the background, so a number that drops
overnight doesn't show as connected until someone opens the settings page. The
UI never depends on this route (it polls Task 3 instead), which is what lets
Fase 2 ship before the exact payload shape is confirmed against a live session.

`RECEIVE_MESSAGE` and `MESSAGE_STATUS` are Fase 3 — this route acknowledges and
ignores them.

**Files:**
- Create: `src/app/api/whatsapp/webhook/uazapi/[session]/route.ts`
- Test: `src/app/api/whatsapp/webhook/uazapi/[session]/route.test.ts`

**Interfaces:**
- Consumes: `isConnectedStatus` (Task 1); the Supabase service-role client
  (`@supabase/supabase-js`), because UAZAPI calls this route with no user
  session and RLS would otherwise hide every row.
- Produces: `POST(request, { params: Promise<{ session: string }> })`
  → 200 `{ ok: true }` for a known session, 404 `{ error: 'Not found' }`
  otherwise.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/whatsapp/webhook/uazapi/[session]/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

let configRow: Record<string, unknown> | null = null;
const updates: Array<Record<string, unknown>> = [];

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      for (const m of ['select', 'eq']) b[m] = vi.fn(chain);
      b.update = vi.fn((payload: Record<string, unknown>) => {
        updates.push(payload);
        return b;
      });
      b.maybeSingle = vi.fn(async () => ({ data: configRow, error: null }));
      b.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve);
      return b;
    }),
  })),
}));

const { POST } = await import('./route');

function post(session: string, body: unknown) {
  return POST(
    new Request(`https://ballicrm.com/api/whatsapp/webhook/uazapi/${session}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ session }) },
  );
}

beforeEach(() => {
  configRow = { account_id: 'acct-1', uazapi_session: 'balli_abc' };
  updates.length = 0;
  vi.clearAllMocks();
});

describe('POST /api/whatsapp/webhook/uazapi/[session]', () => {
  it('404s an unknown session without revealing anything', async () => {
    configRow = null;

    const res = await post('balli_unknown', { type: 'STATUS_CONNECT' });

    expect(res.status).toBe(404);
    expect(updates).toHaveLength(0);
  });

  it('404s when the body names a different session than the URL', async () => {
    const res = await post('balli_abc', {
      type: 'STATUS_CONNECT',
      session: 'balli_other',
      status: 'inChat',
    });

    expect(res.status).toBe(404);
    expect(updates).toHaveLength(0);
  });

  it('persists a STATUS_CONNECT transition to connected', async () => {
    const res = await post('balli_abc', {
      type: 'STATUS_CONNECT',
      session: 'balli_abc',
      status: 'inChat',
      phone: '5511999999999',
    });

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].uazapi_status).toBe('inChat');
    expect(updates[0].uazapi_connected_phone).toBe('5511999999999');
    expect(updates[0].status).toBe('connected');
  });

  it('persists a disconnection and clears the phone', async () => {
    const res = await post('balli_abc', {
      type: 'STATUS_CONNECT',
      session: 'balli_abc',
      status: 'disconnectedMobile',
    });

    expect(res.status).toBe(200);
    expect(updates[0].uazapi_status).toBe('disconnectedMobile');
    expect(updates[0].status).toBe('disconnected');
    expect(updates[0].uazapi_connected_phone).toBeNull();
  });

  it('acknowledges a QRCODE event without storing the image', async () => {
    const res = await post('balli_abc', {
      type: 'QRCODE',
      session: 'balli_abc',
      qrcode: 'data:image/png;base64,AAAA',
    });

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(0);
  });

  it('acknowledges Fase 3 events without acting on them', async () => {
    const res = await post('balli_abc', {
      type: 'RECEIVE_MESSAGE',
      session: 'balli_abc',
    });

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(0);
  });

  it('acknowledges an unrecognised payload so UAZAPI does not retry-storm', async () => {
    const res = await post('balli_abc', { session: 'balli_abc', mystery: true });

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(0);
  });

  it('reads the event name from `event` when `type` is absent', async () => {
    const res = await post('balli_abc', {
      event: 'STATUS_CONNECT',
      session: 'balli_abc',
      status: 'inChat',
    });

    expect(res.status).toBe(200);
    expect(updates[0].uazapi_status).toBe('inChat');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "src/app/api/whatsapp/webhook/uazapi/[session]/route.test.ts"`
Expected: FAIL — `Failed to resolve import "./route"`.

- [ ] **Step 3: Write the implementation**

Create `src/app/api/whatsapp/webhook/uazapi/[session]/route.ts`:

```ts
// ============================================================
// POST /api/whatsapp/webhook/uazapi/[session]
//
// All four UAZAPI webhooks (wh_connect, wh_qrcode, wh_status,
// wh_message) point here; we discriminate on the event name in the
// body.
//
// Authentication: UAZAPI does not sign its callbacks. The session id
// in the path IS the credential — 128 random bits, generated by us,
// never shown to the user. We also require the body to name the same
// session, and answer 404 on any mismatch so a prober learns nothing
// about which sessions exist.
//
// Service-role client: the caller has no user session, so RLS would
// hide every row. This route reads and writes exactly one row, keyed
// by a secret the caller had to already know.
//
// Fase 2 handles STATUS_CONNECT (persist) and QRCODE (log only — the
// UI fetches codes on demand via /api/whatsapp/uazapi/status, because
// serverless instances share no memory). RECEIVE_MESSAGE and
// MESSAGE_STATUS land in Fase 3; we acknowledge them meanwhile.
//
// Everything answers 200 once the session is known: a non-2xx makes
// UAZAPI retry, and retrying an event we deliberately ignore just
// burns quota.
// ============================================================

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { isConnectedStatus } from '@/lib/whatsapp/uazapi-session';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _adminClient;
}

/**
 * The Postman collection names the events (STATUS_CONNECT, QRCODE,
 * RECEIVE_MESSAGE, MESSAGE_STATUS) but doesn't pin down the field
 * carrying them, so we check the three plausible spellings. Task 10
 * confirms the real one against a live session; the extra lookups
 * cost nothing and keep the route working either way.
 */
function readEventName(body: Record<string, unknown>): string | null {
  for (const key of ['type', 'event', 'EventType']) {
    const value = body[key];
    if (typeof value === 'string' && value) return value.toUpperCase();
  }
  return null;
}

/** Same reasoning as readEventName, for the connected phone number. */
function readPhone(body: Record<string, unknown>): string | null {
  for (const key of ['phone', 'number', 'wid', 'connectedPhone']) {
    const value = body[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ session: string }> },
) {
  const { session } = await params;

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // The body must agree with the URL. A mismatch means a replayed or
  // crafted payload, not a real UAZAPI callback.
  const bodySession = body.session;
  if (typeof bodySession === 'string' && bodySession !== session) {
    console.warn('[uazapi webhook] session mismatch between URL and body');
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { data: config, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id, uazapi_session')
    .eq('uazapi_session', session)
    .maybeSingle();

  if (error) {
    console.error('[uazapi webhook] config lookup failed:', error);
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (!config) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const event = readEventName(body);

  if (event === 'STATUS_CONNECT') {
    const status = typeof body.status === 'string' ? body.status : null;
    if (!status) {
      console.warn('[uazapi webhook] STATUS_CONNECT without a status field');
      return NextResponse.json({ ok: true });
    }
    const connected = isConnectedStatus(status);
    const { error: updateError } = await supabaseAdmin()
      .from('whatsapp_config')
      .update({
        uazapi_status: status,
        uazapi_connected_phone: connected ? readPhone(body) : null,
        status: connected ? 'connected' : 'disconnected',
        connected_at: connected ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', config.account_id);
    if (updateError) {
      console.error('[uazapi webhook] status persist failed:', updateError);
    }
    return NextResponse.json({ ok: true });
  }

  if (event === 'QRCODE') {
    // Intentionally not stored: a QR code expires in seconds, and the
    // instance that would serve it to the browser is a different one.
    return NextResponse.json({ ok: true });
  }

  if (event === 'RECEIVE_MESSAGE' || event === 'MESSAGE_STATUS') {
    // Fase 3.
    return NextResponse.json({ ok: true });
  }

  // Log the shape so the first real callback tells us what we're
  // missing, without ever echoing it back to the caller.
  console.warn('[uazapi webhook] unrecognised event payload:', JSON.stringify(body));
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "src/app/api/whatsapp/webhook/uazapi/[session]/route.test.ts"`
Expected: PASS, all eight cases.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/whatsapp/webhook/uazapi"
git commit -m "feat(whatsapp): add UAZAPI inbound webhook for connection status"
```

---

### Task 6: Meta config route stamps `provider='meta'` and clears UAZAPI fields

Without this, saving Meta credentials on an account whose row is
`provider='uazapi'` leaves `provider` untouched — the row would keep a live
UAZAPI session and every send would route to the wrong provider. This is a
correctness fix for switching, not a feature.

**Files:**
- Modify: `src/app/api/whatsapp/config/route.ts` (the `baseRow` object and the
  pre-save conflict checks around lines 275-402; the `DELETE` handler around
  line 441)
- Test: `src/app/api/whatsapp/config/route.test.ts` (new file)

**Interfaces:**
- Consumes: `closeSession` from `uazapi-api.ts`; `decrypt` (already imported).
- Produces:
  - `POST` additionally writes `provider: 'meta'` plus null UAZAPI columns, and
    returns 409 `{ error, requiresConfirmation: true }` when the existing row is
    `provider='uazapi'` and the body omits `confirm_replace_provider: true`.
  - `DELETE` releases a UAZAPI session upstream before dropping the row.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/whatsapp/config/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only the provider-switch behaviour is covered here; the Meta happy
// path is exercised end-to-end elsewhere and must stay untouched.
let existingConfig: Record<string, unknown> | null = null;
const updates: Array<Record<string, unknown>> = [];
const inserts: Array<Record<string, unknown>> = [];

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
    from: vi.fn((table: string) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      for (const m of ['select', 'eq', 'neq']) b[m] = vi.fn(chain);
      b.update = vi.fn((payload: Record<string, unknown>) => {
        updates.push(payload);
        return b;
      });
      b.insert = vi.fn((payload: Record<string, unknown>) => {
        inserts.push(payload);
        return b;
      });
      b.maybeSingle = vi.fn(async () => ({
        data: table === 'profiles' ? { account_id: 'acct-1' } : existingConfig,
        error: null,
      }));
      b.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve);
      return b;
    }),
  })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      for (const m of ['select', 'eq', 'neq']) b[m] = vi.fn(chain);
      // No other account has claimed this phone_number_id.
      b.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
      return b;
    }),
  })),
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  verifyPhoneNumber: vi.fn(async () => ({ verified_name: 'Balli' })),
  registerPhoneNumber: vi.fn(async () => undefined),
  subscribeWabaToApp: vi.fn(async () => undefined),
}));

vi.mock('@/lib/whatsapp/uazapi-api', () => ({
  closeSession: vi.fn(async () => undefined),
}));

const { POST } = await import('./route');
const { closeSession } = await import('@/lib/whatsapp/uazapi-api');
const { encrypt } = await import('@/lib/whatsapp/encryption');

function post(body: Record<string, unknown>) {
  return POST(
    new Request('https://ballicrm.com/api/whatsapp/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phone_number_id: 'PNID-1',
        access_token: 'meta-token',
        ...body,
      }),
    }),
  );
}

beforeEach(() => {
  existingConfig = null;
  updates.length = 0;
  inserts.length = 0;
  vi.clearAllMocks();
});

describe('POST /api/whatsapp/config — provider handling', () => {
  it('stamps provider=meta on a brand new row', async () => {
    const res = await post({});

    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].provider).toBe('meta');
  });

  it('refuses to overwrite a UAZAPI row without explicit confirmation', async () => {
    existingConfig = {
      id: 'cfg-1',
      provider: 'uazapi',
      uazapi_session: 'balli_abc',
      uazapi_session_key: encrypt('key-1'),
    };

    const res = await post({});
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.requiresConfirmation).toBe(true);
    expect(updates).toHaveLength(0);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('closes the UAZAPI session and clears its fields when confirmed', async () => {
    existingConfig = {
      id: 'cfg-1',
      provider: 'uazapi',
      uazapi_session: 'balli_abc',
      uazapi_session_key: encrypt('key-1'),
    };

    const res = await post({ confirm_replace_provider: true });

    expect(res.status).toBe(200);
    expect(closeSession).toHaveBeenCalledWith({
      session: 'balli_abc',
      sessionkey: 'key-1',
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].provider).toBe('meta');
    expect(updates[0].uazapi_session).toBeNull();
    expect(updates[0].uazapi_session_key).toBeNull();
    expect(updates[0].uazapi_status).toBeNull();
    expect(updates[0].uazapi_connected_phone).toBeNull();
  });

  it('needs no confirmation to re-save an account that is already on Meta', async () => {
    existingConfig = {
      id: 'cfg-1',
      provider: 'meta',
      phone_number_id: 'PNID-1',
      registered_at: '2026-01-01T00:00:00.000Z',
    };

    const res = await post({});

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].provider).toBe('meta');
  });
});

describe('DELETE /api/whatsapp/config — provider cleanup', () => {
  it('releases the UAZAPI session before deleting the row', async () => {
    existingConfig = {
      id: 'cfg-1',
      provider: 'uazapi',
      uazapi_session: 'balli_abc',
      uazapi_session_key: encrypt('key-1'),
    };

    const { DELETE } = await import('./route');
    const res = await DELETE();

    expect(res.status).toBe(200);
    expect(closeSession).toHaveBeenCalledWith({
      session: 'balli_abc',
      sessionkey: 'key-1',
    });
  });

  it('deletes a Meta row without touching UAZAPI', async () => {
    existingConfig = { id: 'cfg-1', provider: 'meta', phone_number_id: 'PNID-1' };

    const { DELETE } = await import('./route');
    const res = await DELETE();

    expect(res.status).toBe(200);
    expect(closeSession).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/whatsapp/config/route.test.ts`
Expected: FAIL — the 409 case returns 200, and `provider` is absent from the
written rows.

- [ ] **Step 3: Add the import and the confirmation gate**

In `src/app/api/whatsapp/config/route.ts`, add to the imports at the top:

```ts
import { closeSession } from '@/lib/whatsapp/uazapi-api'
```

Then find the existing lookup of the current row (currently around line 275):

```ts
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, registered_at, phone_number_id')
      .eq('account_id', accountId)
      .maybeSingle()
```

Replace it with a version that also reads the provider columns, and gate the
destructive switch:

```ts
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select(
        'id, registered_at, phone_number_id, provider, uazapi_session, uazapi_session_key'
      )
      .eq('account_id', accountId)
      .maybeSingle()

    // Saving Meta credentials over a live UAZAPI session is
    // destructive: the QR-code connection stops working and the
    // session is released. Mirrors the same gate on the UAZAPI side
    // (POST /api/whatsapp/uazapi/connect), so a switch always takes a
    // second deliberate click whichever direction it goes.
    if (existing?.provider === 'uazapi' && body.confirm_replace_provider !== true) {
      return NextResponse.json(
        {
          error:
            'This account is currently connected through UAZAPI (QR code). Saving Meta credentials will disconnect it.',
          requiresConfirmation: true,
        },
        { status: 409 }
      )
    }

    // Release the session on UAZAPI's side before we drop our
    // reference to it — otherwise it lingers on the subscription with
    // nothing able to reach it again. Best-effort: a failure here must
    // not block the user from moving to Meta.
    if (existing?.provider === 'uazapi' && existing.uazapi_session) {
      try {
        if (existing.uazapi_session_key) {
          await closeSession({
            session: existing.uazapi_session,
            sessionkey: decrypt(existing.uazapi_session_key),
          })
        }
      } catch (err) {
        console.warn(
          '[whatsapp/config POST] closing the previous UAZAPI session failed:',
          err instanceof Error ? err.message : String(err)
        )
      }
    }
```

- [ ] **Step 4: Stamp the provider on the written row**

Still in `src/app/api/whatsapp/config/route.ts`, find the `baseRow` object
(currently around line 356) and add the provider fields. The existing keys stay
exactly as they are:

```ts
    const baseRow = {
      // Explicit rather than relying on the column default: this row
      // may be switching back from 'uazapi', where the default no
      // longer applies. The UAZAPI columns are nulled in the same
      // statement so the provider CHECK constraint always sees a
      // coherent row.
      provider: 'meta',
      uazapi_session: null,
      uazapi_session_key: null,
      uazapi_status: null,
      uazapi_connected_phone: null,
      phone_number_id,
      waba_id: waba_id || null,
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      status: registrationError ? 'disconnected' : 'connected',
      connected_at: registrationError ? null : new Date().toISOString(),
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt ?? null,
      last_registration_error: registrationError,
      updated_at: new Date().toISOString(),
    }
```

- [ ] **Step 5: Release the UAZAPI session on Reset (DELETE)**

The "Reset Configuration" button deletes the row. For a UAZAPI account that
would orphan a live session on the subscription — nothing could ever reach it
again. In the `DELETE` handler in the same file, insert this immediately before
the existing `.delete()` call:

```ts
    // Read the row before dropping it: if it holds a UAZAPI session,
    // release it upstream first, or the subscription keeps paying for
    // a session no row points at any more. Best-effort — a failure
    // here must not stop the user from clearing their config.
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('provider, uazapi_session, uazapi_session_key')
      .eq('account_id', accountId)
      .maybeSingle()

    if (existing?.provider === 'uazapi' && existing.uazapi_session && existing.uazapi_session_key) {
      try {
        await closeSession({
          session: existing.uazapi_session,
          sessionkey: decrypt(existing.uazapi_session_key),
        })
      } catch (err) {
        console.warn(
          '[whatsapp/config DELETE] closing the UAZAPI session failed:',
          err instanceof Error ? err.message : String(err)
        )
      }
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/app/api/whatsapp/config/route.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 7: Verify the Meta path is unchanged**

Run: `npm run typecheck && npm test`
Expected: clean, 665+ passing. No pre-existing test may need editing — if one
does, that is a Meta-path regression, not a stale test. Stop and investigate.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/whatsapp/config
git commit -m "fix(whatsapp): stamp provider on meta config saves and release UAZAPI sessions"
```

---

### Task 7: Split the settings component (behaviour-preserving move)

Pure refactor. `whatsapp-config.tsx` is 883 lines of Meta-specific UI; moving it
wholesale into its own file first means Task 8's container diff is readable
instead of drowning in a rename.

**Files:**
- Create: `src/components/settings/whatsapp-config-meta.tsx`
- Modify: `src/components/settings/whatsapp-config.tsx`

**Interfaces:**
- Produces: `WhatsAppConfigMeta` — same component, same behaviour, no props yet.
  `whatsapp-config.tsx` keeps exporting `WhatsAppConfig` so
  `src/app/(dashboard)/settings/page.tsx` needs no change.

- [ ] **Step 1: Move the file**

```bash
git mv src/components/settings/whatsapp-config.tsx src/components/settings/whatsapp-config-meta.tsx
```

- [ ] **Step 2: Rename the exported component**

In `src/components/settings/whatsapp-config-meta.tsx`, change only the export
line — nothing else in the file:

```tsx
export function WhatsAppConfigMeta() {
```

(was `export function WhatsAppConfig() {`)

- [ ] **Step 3: Recreate the container as a pass-through**

Create `src/components/settings/whatsapp-config.tsx`:

```tsx
'use client';

// Container for Settings → WhatsApp. Today it renders the Meta panel
// unconditionally; Task 8 turns it into the provider selector. Kept as
// a separate file so `settings/page.tsx` has one stable import.

import { WhatsAppConfigMeta } from './whatsapp-config-meta';

export function WhatsAppConfig() {
  return <WhatsAppConfigMeta />;
}
```

- [ ] **Step 4: Verify nothing changed**

Run: `npm run typecheck && npm test && npm run lint`
Expected: clean. Then confirm the only importer still resolves:

Run: `grep -rl "whatsapp-config" src --include=*.tsx`
Expected: `src/app/(dashboard)/settings/page.tsx` (unchanged) plus the two
component files.

- [ ] **Step 5: Verify in the browser**

Run: `npm run dev`, open Settings → WhatsApp. The panel must look and behave
exactly as before: status banners, credential form, webhook URL, Save / Test /
Reset buttons, setup instructions sidebar.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/whatsapp-config.tsx src/components/settings/whatsapp-config-meta.tsx
git commit -m "refactor(settings): extract the Meta panel from whatsapp-config"
```

---

### Task 8: Provider selector in the container

**Files:**
- Modify: `src/components/settings/whatsapp-config.tsx`
- Modify: `src/components/settings/whatsapp-config-meta.tsx` (drop its
  `SettingsPanelHead`; accept an `onConfigChanged` callback)
- Modify: `messages/pt.json`, `messages/en.json`, `messages/ko.json`

**Interfaces:**
- Consumes: `useAuth` (`accountId`, `loading`, `profileLoading`) from
  `@/hooks/use-auth`; `createClient` from `@/lib/supabase/client`.
- Produces:
  - `WhatsAppConfigMeta({ onConfigChanged }: { onConfigChanged?: () => void })`
  - Container renders `SettingsPanelHead` + a two-option provider toggle +
    the selected panel. Placeholder for the UAZAPI panel until Task 9.
- Translation keys added under `Settings.whatsapp.provider`:
  `label`, `metaName`, `metaTagline`, `uazapiName`, `uazapiTagline`,
  `activeBadge`, `switchHint`.

- [ ] **Step 1: Add the translation keys**

In `messages/pt.json`, inside `Settings.whatsapp`, add:

```json
    "provider": {
      "label": "Forma de conexão",
      "metaName": "API oficial (Meta)",
      "metaTagline": "WhatsApp Business API homologada. Exige conta na Meta, número verificado e modelos aprovados.",
      "uazapiName": "QR Code (UAZAPI)",
      "uazapiTagline": "Conecte lendo um QR Code no celular, como no WhatsApp Web. Mais simples, porém não oficial.",
      "activeBadge": "Em uso",
      "switchHint": "Só uma conexão fica ativa por conta. Ao ativar a outra, a atual é desconectada."
    },
```

In `messages/en.json`, inside `Settings.whatsapp`, add:

```json
    "provider": {
      "label": "Connection type",
      "metaName": "Official API (Meta)",
      "metaTagline": "The approved WhatsApp Business API. Requires a Meta account, a verified number, and approved templates.",
      "uazapiName": "QR Code (UAZAPI)",
      "uazapiTagline": "Connect by scanning a QR code on your phone, like WhatsApp Web. Simpler, but unofficial.",
      "activeBadge": "In use",
      "switchHint": "Only one connection is active per account. Turning on the other one disconnects the current one."
    },
```

In `messages/ko.json`, inside `Settings.whatsapp`, add the same keys with the
English copy — the Korean locale was contributed separately and a native
speaker should refine these later. Key parity is what matters here:

```json
    "provider": {
      "label": "Connection type",
      "metaName": "Official API (Meta)",
      "metaTagline": "The approved WhatsApp Business API. Requires a Meta account, a verified number, and approved templates.",
      "uazapiName": "QR Code (UAZAPI)",
      "uazapiTagline": "Connect by scanning a QR code on your phone, like WhatsApp Web. Simpler, but unofficial.",
      "activeBadge": "In use",
      "switchHint": "Only one connection is active per account. Turning on the other one disconnects the current one."
    },
```

- [ ] **Step 2: Verify locale key parity**

Run:

```bash
node -e "
const en=require('./messages/en.json'),pt=require('./messages/pt.json'),ko=require('./messages/ko.json');
const flat=(o,p='')=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==='object'&&!Array.isArray(v)?flat(v,p+k+'.'):[p+k]);
const [E,P,K]=[flat(en),flat(pt),flat(ko)].map(a=>new Set(a));
const diff=(a,b)=>[...a].filter(k=>!b.has(k));
console.log('pt missing:',diff(E,P),'ko missing:',diff(E,K),'extra pt:',diff(P,E),'extra ko:',diff(K,E));
"
```

Expected: four empty arrays.

- [ ] **Step 3: Make the Meta panel embeddable**

In `src/components/settings/whatsapp-config-meta.tsx`:

Change the signature:

```tsx
export function WhatsAppConfigMeta({
  onConfigChanged,
}: {
  onConfigChanged?: () => void;
}) {
```

Remove the `SettingsPanelHead` import and both of its usages (the one in the
`if (loading)` early return and the one at the top of the main return), leaving
the surrounding `<section>` elements in place — the container renders the head
now.

In `handleSave`, immediately after the existing `if (accountId) await fetchConfig(accountId);`,
add:

```tsx
      onConfigChanged?.();
```

In `handleReset`, immediately after `setStatusMessage('');` in the success path,
add:

```tsx
      onConfigChanged?.();
```

- [ ] **Step 4: Write the container**

Replace `src/components/settings/whatsapp-config.tsx` with:

```tsx
'use client';

// ============================================================
// Settings → WhatsApp container.
//
// Owns the panel heading and the provider choice; each provider's
// form lives in its own file. The selector only changes what's on
// screen — nothing destructive happens until the user completes the
// action inside a panel (Save for Meta, Connect for UAZAPI), and both
// of those routes demand an explicit confirmation before replacing a
// live connection from the other provider.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, QrCode, ShieldCheck } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { WhatsAppConfigMeta } from './whatsapp-config-meta';

type Provider = 'meta' | 'uazapi';

export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
  const supabase = createClient();
  const { accountId, loading: authLoading, profileLoading } = useAuth();

  // The provider persisted on the row, or null when the account has
  // never configured WhatsApp.
  const [activeProvider, setActiveProvider] = useState<Provider | null>(null);
  const [selected, setSelected] = useState<Provider>('meta');
  const [loading, setLoading] = useState(true);

  const loadProvider = useCallback(
    async (acctId: string) => {
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('provider')
        .eq('account_id', acctId)
        .maybeSingle();

      if (error) {
        console.error('[WhatsAppConfig] provider load failed:', error);
      }

      const provider = (data?.provider as Provider | undefined) ?? null;
      setActiveProvider(provider);
      // Land on whatever is configured; default to Meta for a fresh
      // account so the existing onboarding path is unchanged.
      setSelected(provider ?? 'meta');
      setLoading(false);
    },
    [supabase],
  );

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!accountId) {
      setLoading(false);
      return;
    }
    void loadProvider(accountId);
  }, [authLoading, profileLoading, accountId, loadProvider]);

  const refresh = useCallback(() => {
    if (accountId) void loadProvider(accountId);
  }, [accountId, loadProvider]);

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  const options: Array<{
    value: Provider;
    name: string;
    tagline: string;
    icon: typeof ShieldCheck;
  }> = [
    {
      value: 'meta',
      name: t('provider.metaName'),
      tagline: t('provider.metaTagline'),
      icon: ShieldCheck,
    },
    {
      value: 'uazapi',
      name: t('provider.uazapiName'),
      tagline: t('provider.uazapiTagline'),
      icon: QrCode,
    },
  ];

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <div>
        <p className="mb-2 text-sm font-medium text-foreground">
          {t('provider.label')}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {options.map((option) => {
            const Icon = option.icon;
            const isSelected = selected === option.value;
            const isActive = activeProvider === option.value;
            return (
              <Card
                key={option.value}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                onClick={() => setSelected(option.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelected(option.value);
                  }
                }}
                className={`cursor-pointer transition-colors ${
                  isSelected
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground/40'
                }`}
              >
                <CardContent className="flex gap-3 p-4">
                  <Icon
                    className={`mt-0.5 size-5 shrink-0 ${
                      isSelected ? 'text-primary' : 'text-muted-foreground'
                    }`}
                  />
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {option.name}
                      </span>
                      {isActive && (
                        <Badge className="border-emerald-600/40 bg-emerald-500/10 text-[10px] uppercase tracking-wide text-emerald-300">
                          {t('provider.activeBadge')}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {option.tagline}
                    </p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t('provider.switchHint')}
        </p>
      </div>

      {selected === 'meta' ? (
        <WhatsAppConfigMeta onConfigChanged={refresh} />
      ) : (
        // Replaced by <WhatsAppConfigUazapi /> in Task 9.
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('provider.uazapiTagline')}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Typecheck, lint, and full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean.

- [ ] **Step 6: Verify in the browser**

Run `npm run dev`, open Settings → WhatsApp:
- Two provider cards appear; Meta is selected by default on a fresh account.
- An account with saved Meta credentials shows "Em uso" on the Meta card and
  the familiar form below it — status banners, Save, Test, Reset all behave as
  before.
- Clicking the UAZAPI card swaps the panel for the interim message and does not
  change any stored data (reload the page: the Meta card still shows "Em uso").

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/whatsapp-config.tsx src/components/settings/whatsapp-config-meta.tsx messages
git commit -m "feat(settings): add WhatsApp provider selector to the settings panel"
```

---

### Task 9: UAZAPI panel — QR code, polling, connect and disconnect

**Files:**
- Create: `src/components/settings/whatsapp-config-uazapi.tsx`
- Modify: `src/components/settings/whatsapp-config.tsx` (swap the interim card
  for the real panel)
- Modify: `messages/pt.json`, `messages/en.json`, `messages/ko.json`

**Interfaces:**
- Consumes: `POST /api/whatsapp/uazapi/connect` (Task 2),
  `GET /api/whatsapp/uazapi/status` (Task 3),
  `POST /api/whatsapp/uazapi/disconnect` (Task 4).
- Produces: `WhatsAppConfigUazapi({ onConfigChanged }: { onConfigChanged?: () => void })`
- Translation keys added under `Settings.whatsapp.uazapi`:
  `intro`, `connectBtn`, `connecting`, `reconnectBtn`, `scanTitle`, `scanHint`,
  `waitingQr`, `connectedTitle`, `connectedPhone`, `unknownPhone`,
  `disconnectBtn`, `disconnecting`, `statusLabel`, `delayWarning`,
  `unofficialWarning`, `replaceTitle`, `replaceConfirm`, `cancel`,
  `connectFailed`, `disconnectFailed`, `disconnectedToast`, `connectedToast`.

- [ ] **Step 1: Add the translation keys**

In `messages/pt.json`, inside `Settings.whatsapp`, add:

```json
    "uazapi": {
      "intro": "Conecte um número lendo um QR Code no celular, como no WhatsApp Web. Não exige conta na Meta nem número verificado.",
      "connectBtn": "Gerar QR Code",
      "connecting": "Gerando…",
      "reconnectBtn": "Gerar novo QR Code",
      "scanTitle": "Leia o código com seu WhatsApp",
      "scanHint": "No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho. O código expira em alguns segundos e é renovado sozinho.",
      "waitingQr": "Aguardando o QR Code do servidor…",
      "connectedTitle": "WhatsApp conectado",
      "connectedPhone": "Número conectado: {phone}",
      "unknownPhone": "número não informado pelo servidor",
      "disconnectBtn": "Desconectar",
      "disconnecting": "Desconectando…",
      "statusLabel": "Status do servidor: {status}",
      "delayWarning": "Esta conexão aplica um intervalo de cerca de 5 segundos entre mensagens enviadas.",
      "unofficialWarning": "Conexão não oficial: depende do WhatsApp Web e pode cair sozinha. Confira o status nesta tela antes de campanhas importantes.",
      "replaceTitle": "Substituir a conexão atual?",
      "replaceConfirm": "Esta conta usa hoje a API oficial da Meta. Ao conectar por QR Code, as credenciais da Meta serão apagadas desta conta.",
      "cancel": "Cancelar",
      "connectFailed": "Não foi possível iniciar a conexão",
      "disconnectFailed": "Não foi possível desconectar",
      "disconnectedToast": "WhatsApp desconectado.",
      "connectedToast": "WhatsApp conectado com sucesso."
    },
```

In `messages/en.json`, inside `Settings.whatsapp`, add:

```json
    "uazapi": {
      "intro": "Connect a number by scanning a QR code on your phone, like WhatsApp Web. No Meta account or verified number required.",
      "connectBtn": "Generate QR code",
      "connecting": "Generating…",
      "reconnectBtn": "Generate a new QR code",
      "scanTitle": "Scan the code with your WhatsApp",
      "scanHint": "On your phone: WhatsApp → Linked devices → Link a device. The code expires after a few seconds and refreshes on its own.",
      "waitingQr": "Waiting for the QR code from the server…",
      "connectedTitle": "WhatsApp connected",
      "connectedPhone": "Connected number: {phone}",
      "unknownPhone": "number not reported by the server",
      "disconnectBtn": "Disconnect",
      "disconnecting": "Disconnecting…",
      "statusLabel": "Server status: {status}",
      "delayWarning": "This connection applies a delay of about 5 seconds between outgoing messages.",
      "unofficialWarning": "Unofficial connection: it depends on WhatsApp Web and can drop on its own. Check the status on this screen before important campaigns.",
      "replaceTitle": "Replace the current connection?",
      "replaceConfirm": "This account currently uses the official Meta API. Connecting by QR code will delete those Meta credentials from this account.",
      "cancel": "Cancel",
      "connectFailed": "Could not start the connection",
      "disconnectFailed": "Could not disconnect",
      "disconnectedToast": "WhatsApp disconnected.",
      "connectedToast": "WhatsApp connected successfully."
    },
```

In `messages/ko.json`, inside `Settings.whatsapp`, add the same block with the
English copy (same rationale as Task 8 — parity first, native review later).

- [ ] **Step 2: Verify locale key parity**

Run the same parity script as Task 8, Step 2.
Expected: four empty arrays.

- [ ] **Step 3: Write the panel**

Create `src/components/settings/whatsapp-config-uazapi.tsx`:

```tsx
'use client';

// ============================================================
// Settings → WhatsApp → QR Code (UAZAPI) panel.
//
// Flow: Connect → poll → show QR → user scans → poll reports
// `inChat` → connected view.
//
// Polling (not a webhook push) drives this screen on purpose: the QR
// endpoint and the webhook receiver run as separate serverless
// instances with no shared memory, so a code pushed to one could
// never be read by the other. /api/whatsapp/uazapi/status asks UAZAPI
// live on every tick, which is stateless by construction.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  QrCode,
  Unplug,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface StatusPayload {
  configured: boolean;
  status: string | null;
  connected: boolean;
  connectedPhone: string | null;
  qrDataUri: string | null;
  error?: string;
}

// Fast enough that a QR code rotation is picked up before the user
// gives up on a stale image, slow enough that an idle settings tab
// isn't hammering someone else's server.
const POLL_INTERVAL_MS = 4000;

export function WhatsAppConfigUazapi({
  onConfigChanged,
}: {
  onConfigChanged?: () => void;
}) {
  const t = useTranslations('Settings.whatsapp.uazapi');

  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  // Fires the "connected!" toast exactly once per transition rather
  // than on every poll that happens to see `connected: true`.
  const wasConnectedRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/uazapi/status', { cache: 'no-store' });
      if (!res.ok) return;
      const payload = (await res.json()) as StatusPayload;
      setStatus(payload);

      if (payload.connected && !wasConnectedRef.current) {
        wasConnectedRef.current = true;
        toast.success(t('connectedToast'));
        onConfigChanged?.();
      } else if (!payload.connected) {
        wasConnectedRef.current = false;
      }
    } catch (err) {
      console.error('[uazapi panel] status fetch failed:', err);
    }
  }, [t, onConfigChanged]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Poll only while there's something to watch: a session that exists
  // but isn't connected yet. A connected (or absent) session has no
  // pending transition worth a request every four seconds.
  const shouldPoll = Boolean(status?.configured) && !status?.connected;
  useEffect(() => {
    if (!shouldPoll) return;
    const id = setInterval(() => void fetchStatus(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [shouldPoll, fetchStatus]);

  const connect = useCallback(
    async (replace: boolean) => {
      setConnecting(true);
      try {
        const res = await fetch('/api/whatsapp/uazapi/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(replace ? { confirmReplace: true } : {}),
        });
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
          requiresConfirmation?: boolean;
        };

        if (res.status === 409 && payload.requiresConfirmation) {
          setConfirmReplace(true);
          return;
        }
        if (!res.ok) {
          toast.error(payload.error || t('connectFailed'), { duration: 10000 });
          return;
        }

        setConfirmReplace(false);
        onConfigChanged?.();
        await fetchStatus();
      } catch (err) {
        console.error('[uazapi panel] connect failed:', err);
        toast.error(t('connectFailed'));
      } finally {
        setConnecting(false);
      }
    },
    [t, fetchStatus, onConfigChanged],
  );

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/whatsapp/uazapi/disconnect', { method: 'POST' });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(payload.error || t('disconnectFailed'));
        return;
      }
      toast.success(t('disconnectedToast'));
      wasConnectedRef.current = false;
      onConfigChanged?.();
      await fetchStatus();
    } catch (err) {
      console.error('[uazapi panel] disconnect failed:', err);
      toast.error(t('disconnectFailed'));
    } finally {
      setDisconnecting(false);
    }
  }, [t, fetchStatus, onConfigChanged]);

  const configured = Boolean(status?.configured);
  const connected = Boolean(status?.connected);

  return (
    <div className="space-y-6">
      {/* Both caveats are inherent to an unofficial connection, so
          they're stated before the user commits, not after. */}
      <Alert className="border-amber-700/50 bg-amber-950/30">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <div>
            <AlertTitle className="mb-1 text-amber-200">
              {t('unofficialWarning')}
            </AlertTitle>
            <AlertDescription className="flex items-center gap-1.5 text-xs text-amber-100/80">
              <Clock className="size-3.5 shrink-0" />
              {t('delayWarning')}
            </AlertDescription>
          </div>
        </div>
      </Alert>

      {connected ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <CheckCircle2 className="size-5 text-emerald-400" />
              {t('connectedTitle')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('connectedPhone', {
                phone: status?.connectedPhone ?? t('unknownPhone'),
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {t('statusLabel', { status: status?.status ?? '—' })}
            </p>
            <Button
              variant="outline"
              onClick={disconnect}
              disabled={disconnecting}
              className="border-red-900 text-red-400 hover:bg-red-950/40 hover:text-red-300"
            >
              {disconnecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('disconnecting')}
                </>
              ) : (
                <>
                  <Unplug className="size-4" />
                  {t('disconnectBtn')}
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('scanTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {configured ? t('scanHint') : t('intro')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {configured && (
              <div className="flex flex-col items-center gap-3">
                {status?.qrDataUri ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={status.qrDataUri}
                    alt={t('scanTitle')}
                    className="size-64 rounded-lg border border-border bg-white p-2"
                  />
                ) : (
                  <div className="flex size-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    <p className="px-4 text-center text-xs text-muted-foreground">
                      {t('waitingQr')}
                    </p>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  {t('statusLabel', { status: status?.status ?? '—' })}
                </p>
              </div>
            )}

            {status?.error && (
              <p className="text-xs text-red-400">{status.error}</p>
            )}

            <Button
              onClick={() => connect(false)}
              disabled={connecting}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {connecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('connecting')}
                </>
              ) : (
                <>
                  <QrCode className="size-4" />
                  {configured ? t('reconnectBtn') : t('connectBtn')}
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={confirmReplace}
        onOpenChange={(open) => {
          if (!open) setConfirmReplace(false);
        }}
      >
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <AlertTriangle className="size-4 text-amber-400" />
              {t('replaceTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('replaceConfirm')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-border bg-popover">
            <Button
              variant="outline"
              onClick={() => setConfirmReplace(false)}
              className="border-border text-popover-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={() => connect(true)}
              disabled={connecting}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {connecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('connecting')}
                </>
              ) : (
                t('connectBtn')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 4: Wire the panel into the container**

In `src/components/settings/whatsapp-config.tsx`, add the import:

```tsx
import { WhatsAppConfigUazapi } from './whatsapp-config-uazapi';
```

and replace the interim `<Card>` block (the one commented "Replaced by
`<WhatsAppConfigUazapi />` in Task 9") with:

```tsx
        <WhatsAppConfigUazapi onConfigChanged={refresh} />
```

- [ ] **Step 5: Typecheck, lint, and full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/whatsapp-config-uazapi.tsx src/components/settings/whatsapp-config.tsx messages
git commit -m "feat(settings): add UAZAPI QR-code connection panel"
```

---

### Task 10: End-to-end verification against a live UAZAPI session

Everything above is unit-tested against mocked `fetch`. This task is the first
contact with the real service, and it is also where the webhook payload shape
gets confirmed rather than assumed.

**Prerequisites:** an active UAZAPI subscription (endpoint + account token), a
spare WhatsApp number to scan with, and a deployment reachable over public
https — UAZAPI's servers must be able to POST to the webhook, which rules out
`localhost` (Task 1 rejects it explicitly).

**Files:**
- Modify (only if the captured payload differs from what Task 5 assumed):
  `src/app/api/whatsapp/webhook/uazapi/[session]/route.ts` and its test.

- [ ] **Step 1: Configure the environment**

Add to the deployed environment (and `.env.local` for reference):

```
UAZAPI_ENDPOINT=https://<your-uazapi-server>
UAZAPI_TOKEN=<your-uazapi-account-token>
NEXT_PUBLIC_SITE_URL=https://ballicrm.com
```

`NEXT_PUBLIC_SITE_URL` is a build-time inline for `NEXT_PUBLIC_*` vars, so
redeploy (not just restart) after setting it. Confirm no trailing slash.

- [ ] **Step 2: Connect a number**

On the deployed site: Settings → WhatsApp → select "QR Code (UAZAPI)" →
"Gerar QR Code". Scan the code from the spare phone
(WhatsApp → Aparelhos conectados → Conectar um aparelho).

Expected: within a few seconds the panel flips to "WhatsApp conectado" and shows
the connected number. Verify the row in Supabase:

```sql
select provider, uazapi_session, uazapi_status, uazapi_connected_phone, status
from whatsapp_config where account_id = '<your-account-id>';
```

Expected: `provider='uazapi'`, `uazapi_status='inChat'`, `status='connected'`,
`uazapi_session_key` present and unreadable (ciphertext, three colon-separated
hex groups).

- [ ] **Step 3: Capture the real webhook payloads**

Read the deployment logs while connecting. Look for
`[uazapi webhook] unrecognised event payload:` — its presence means the event
name is not in `type` / `event` / `EventType`, or the event names differ from
the design doc.

If any payload was unrecognised, copy the logged JSON verbatim and add it as a
test case in `src/app/api/whatsapp/webhook/uazapi/[session]/route.test.ts`,
pasting the captured object in place of the comment:

```ts
  it('persists the connection status from a real UAZAPI callback', async () => {
    const res = await post('balli_abc', {
      // <-- paste the exact JSON from the log here, with `session`
      //     changed to 'balli_abc' so it matches the mocked row
    });

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].uazapi_status).toBe('inChat');
  });
```

Then:
1. Run it — it fails (the route ignored the payload as unrecognised).
2. Update `readEventName` / `readPhone` / the event-name comparisons in the
   route to match the real field names and values.
3. Run it — it passes. Run `npm test` — everything else still passes.
4. Replace the "three plausible spellings" comment at the top of the route with
   the confirmed shape and the date it was verified.

If nothing was logged as unrecognised, add a one-line comment to the route
noting the shape was confirmed live on this date.

- [ ] **Step 4: Verify disconnect and reconnect**

Click "Desconectar". Expected: the phone's WhatsApp shows the linked device
gone, the panel returns to the QR view, and the row reads
`uazapi_status='notLogged'`, `status='disconnected'`,
`uazapi_connected_phone=null` — with `uazapi_session` **unchanged**.

Click "Gerar novo QR Code". Expected: a fresh code for the same session, and
the SQL above still shows the same `uazapi_session` value.

- [ ] **Step 5: Verify the Meta path is untouched**

On a second account still configured for Meta, open Settings → WhatsApp.
Expected: the Meta card shows "Em uso", the credential form loads with the
masked token, "Test Connection" reports connected, and sending a message from
the chat still works. Nothing about that account may have changed.

- [ ] **Step 6: Verify both switch confirmations**

On the UAZAPI-connected account, select the Meta card and save Meta
credentials. Expected: a 409-driven confirmation is required before the switch
completes, and afterwards the row reads `provider='meta'` with all four
`uazapi_*` columns null.

Then select the QR Code card and click Connect. Expected: the replace dialog
appears before anything is written.

- [ ] **Step 7: Commit any parser corrections**

```bash
git add "src/app/api/whatsapp/webhook/uazapi"
git commit -m "fix(whatsapp): match the UAZAPI webhook parser to the live payload shape"
```

---

## Done when

- An account can connect a WhatsApp number by QR code, see it reported as
  connected, disconnect, and reconnect.
- A Meta-configured account behaves exactly as it did before this phase.
- Switching provider in either direction requires an explicit confirmation and
  leaves a coherent row.
- `npm run typecheck`, `npm run lint`, and `npm test` are clean.
- The UAZAPI webhook payload shape is confirmed against a live session, not
  assumed.

Messages still do not flow in either direction for UAZAPI accounts — sending
and receiving is Fase 3.
