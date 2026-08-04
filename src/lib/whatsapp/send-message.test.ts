import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

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
        for (const m of ['select', 'eq']) b[m] = vi.fn(chain);
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

  it('raises a typed SendMessageError when the account is on UAZAPI', async () => {
    const db = dbWithConfig({
      id: 'cfg-1',
      provider: 'uazapi',
      access_token: null,
      uazapi_instance_token: 'enc-instance-token',
    });
    await expect(
      sendMessageToConversation(db, 'acct-1', params)
    ).rejects.toBeInstanceOf(SendMessageError);
    await sendMessageToConversation(db, 'acct-1', params).catch(
      (e: SendMessageError) => {
        expect(e).not.toBeInstanceOf(TypeError);
        expect(e.code).toBe('wrong_provider');
        expect(e.status).toBe(400);
        expect(e.message).toMatch(/different provider/i);
      }
    );
  });

  it('raises the same typed error for a meta row with a null access_token', async () => {
    const db = dbWithConfig({ id: 'cfg-1', provider: 'meta', access_token: null });
    await sendMessageToConversation(db, 'acct-1', params).catch(
      (e: SendMessageError) => {
        expect(e).toBeInstanceOf(SendMessageError);
        expect(e.code).toBe('wrong_provider');
      }
    );
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
