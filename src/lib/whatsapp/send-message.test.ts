import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';
import { encrypt } from './encryption';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('requires a valid interactive payload for interactive messages', async () => {
    // Missing payload entirely.
    await expectSendError(
      { ...base, messageType: 'interactive' },
      400,
      /payload is required/
    );
    // Too many buttons.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
      400,
      /at most 3 buttons/
    );
    // Over-long button title.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'x'.repeat(21) }],
        },
      },
      400,
      /20-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

// A conta pode trocar para UAZAPI a qualquer momento; a troca reaproveita
// a mesma linha e zera todas as colunas da Meta. Sem o guard, o
// decrypt(config.access_token) logo abaixo estourava um TypeError cru.
describe('sendMessageToConversation — provider guard', () => {
  function dbWithConfig(config: Record<string, unknown>): SupabaseClient {
    return {
      from(table: string) {
        const b: Record<string, unknown> = {};
        const chain = () => b;
        for (const m of ['select', 'eq', 'insert', 'update']) b[m] = vi.fn(chain);
        b.single = vi.fn(async () =>
          table === 'conversations'
            ? {
                data: {
                  id: 'cv-1',
                  account_id: 'acct-1',
                  contact: { id: 'ct-1', phone: '+14155550123' },
                },
                error: null,
              }
            : { data: config, error: null }
        );
        b.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
        return b;
      },
    } as unknown as SupabaseClient;
  }

  const params: SendMessageParams = {
    conversationId: 'cv-1',
    messageType: 'text',
    contentText: 'oi',
  };

  // A conta UAZAPI sem instance_token configurado ainda precisa recusar com
  // um erro tipado (não o TypeError cru que `decrypt(null)` geraria) — a
  // rota de sucesso (instance_token presente) passa a rotear de verdade
  // desde esta task, coberta pelo teste "roteia envio de texto…" abaixo.
  it('raises a typed SendMessageError when the account is on UAZAPI without an instance token', async () => {
    const db = dbWithConfig({
      id: 'cfg-1',
      provider: 'uazapi',
      access_token: null,
      uazapi_instance_token: null,
    });
    await expect(
      sendMessageToConversation(db, 'acct-1', params)
    ).rejects.toBeInstanceOf(SendMessageError);
    await sendMessageToConversation(db, 'acct-1', params).catch(
      (e: SendMessageError) => {
        expect(e).not.toBeInstanceOf(TypeError);
        expect(e.code).toBe('whatsapp_not_configured');
        expect(e.status).toBe(400);
        expect(e.message).toMatch(/UAZAPI instance not configured/i);
      }
    );
  });

  it('raises a typed error (not wrong_provider) for a meta row with a null access_token', async () => {
    const db = dbWithConfig({ id: 'cfg-1', provider: 'meta', access_token: null });
    await sendMessageToConversation(db, 'acct-1', params).catch(
      (e: SendMessageError) => {
        expect(e).toBeInstanceOf(SendMessageError);
        expect(e).not.toBeInstanceOf(TypeError);
        expect(e.code).toBe('whatsapp_not_configured');
        expect(e.status).toBe(400);
      }
    );
  });

  it('roteia envio de texto para UAZAPI quando a conta usa esse provedor', async () => {
    const db = dbWithConfig({
      id: 'cfg-1',
      provider: 'uazapi',
      access_token: null,
      uazapi_instance_token: encrypt('tok-instancia'),
    });
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ messageid: 'UAZ-1' }) };
    }));

    await sendMessageToConversation(db, 'acct-1', params);

    expect(calls[0].url).toContain('/send/text');
    expect(calls[0].body).toMatchObject({ number: expect.any(String), text: expect.any(String) });
  });

  it('recusa template pelo UAZAPI mesmo com instance token configurado', async () => {
    const db = dbWithConfig({
      id: 'cfg-1',
      provider: 'uazapi',
      access_token: null,
      uazapi_instance_token: encrypt('tok-instancia'),
    });
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'oi_cliente',
      })
    ).rejects.toMatchObject({ code: 'wrong_provider' });
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});
