import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createBroadcast, BroadcastError } from './broadcast-core';

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as SupabaseClient;

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});

// Broadcast é Meta-only. Uma conta migrada para UAZAPI mantém a mesma
// linha de whatsapp_config com access_token null — sem o guard, o
// decrypt() estourava um TypeError cru no meio da criação do broadcast.
describe('createBroadcast — provider guard', () => {
  function dbWithConfig(config: Record<string, unknown>): SupabaseClient {
    return {
      from() {
        const b: Record<string, unknown> = {};
        const chain = () => b;
        for (const m of ['select', 'eq']) b[m] = vi.fn(chain);
        b.single = vi.fn(async () => ({ data: config, error: null }));
        b.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
        return b;
      },
    } as unknown as SupabaseClient;
  }

  const params = {
    templateName: 'promo',
    recipients: [{ to: '+14155550123' }],
  };

  it('raises a typed BroadcastError when the account is on UAZAPI', async () => {
    const db = dbWithConfig({
      id: 'cfg-1',
      provider: 'uazapi',
      access_token: null,
      uazapi_instance_token: 'enc-instance-token',
    });
    await expect(
      createBroadcast(db, 'acc', 'user', params)
    ).rejects.toBeInstanceOf(BroadcastError);
    await createBroadcast(db, 'acc', 'user', params).catch(
      (e: BroadcastError) => {
        expect(e).not.toBeInstanceOf(TypeError);
        expect(e.code).toBe('wrong_provider');
        expect(e.status).toBe(400);
        expect(e.message).toMatch(/different provider/i);
      }
    );
  });

  it('raises the same typed error for a meta row with a null access_token', async () => {
    const db = dbWithConfig({ id: 'cfg-1', provider: 'meta', access_token: null });
    await expect(
      createBroadcast(db, 'acc', 'user', params)
    ).rejects.toMatchObject({ code: 'wrong_provider', status: 400 });
  });
});
