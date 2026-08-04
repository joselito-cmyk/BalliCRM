import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendText, sendMedia } from './provider';
import { encrypt } from './encryption';
import type { WhatsAppConfig } from '@/types';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

const BASE_CONFIG = {
  id: 'cfg-1',
  account_id: 'acct-1',
  user_id: 'user-1',
  status: 'connected' as const,
};

describe('provider.sendText', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes a meta config to meta-api and decrypts access_token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.123' }] }));

    const config: WhatsAppConfig = {
      ...BASE_CONFIG,
      provider: 'meta',
      phone_number_id: 'pnid-1',
      access_token: encrypt('plaintext-meta-token'),
    };

    const result = await sendText(config, { to: '15551234567', text: 'oi' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v21.0/pnid-1/messages');
    expect(init.headers.Authorization).toBe('Bearer plaintext-meta-token');
    expect(result).toEqual({ messageId: 'wamid.123' });
  });

  it('routes a uazapi config to uazapi-api and decrypts uazapi_instance_token', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ result: 200, type: 'text', session: 'acct-1', messageId: 'true_x@c.us_1' }),
    );

    const config: WhatsAppConfig = {
      ...BASE_CONFIG,
      provider: 'uazapi',
      uazapi_instance_token: encrypt('plaintext-instance-token'),
    };

    const result = await sendText(config, { to: '15551234567', text: 'oi' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://uazapi.test/send/text');
    expect(init.headers.token).toBe('plaintext-instance-token');
    expect(JSON.parse(init.body)).toEqual({ number: '15551234567', text: 'oi' });
    expect(result).toEqual({ messageId: 'true_x@c.us_1' });
  });

  it('throws a clear error when a meta config is missing its credentials', async () => {
    const config: WhatsAppConfig = { ...BASE_CONFIG, provider: 'meta' };

    await expect(sendText(config, { to: '1', text: 'oi' })).rejects.toThrow(
      /Meta WhatsApp not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a clear error when a uazapi config is missing its instance token', async () => {
    const config: WhatsAppConfig = { ...BASE_CONFIG, provider: 'uazapi' };

    await expect(sendText(config, { to: '1', text: 'oi' })).rejects.toThrow(
      /UAZAPI instance not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recusa envio UAZAPI sem instance token', async () => {
    await expect(
      sendText(
        { ...BASE_CONFIG, provider: 'uazapi', uazapi_instance_token: undefined },
        { to: '55', text: 'x' },
      ),
    ).rejects.toThrow(/not configured/i);
  });
});

describe('provider.sendMedia', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes a uazapi config to the matching /send<Kind> endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: 200, messageId: 'true_x@c.us_2' }));

    const config: WhatsAppConfig = {
      ...BASE_CONFIG,
      provider: 'uazapi',
      uazapi_instance_token: encrypt('plaintext-instance-token'),
    };

    await sendMedia(config, { to: '15551234567', kind: 'document', link: 'https://cdn.test/f.pdf' });

    expect(fetchMock.mock.calls[0][0]).toBe('https://uazapi.test/send/media');
  });

  it('routes a meta config to meta-api sendMediaMessage', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.456' }] }));

    const config: WhatsAppConfig = {
      ...BASE_CONFIG,
      provider: 'meta',
      phone_number_id: 'pnid-1',
      access_token: encrypt('plaintext-meta-token'),
    };

    const result = await sendMedia(config, { to: '15551234567', kind: 'image', link: 'https://cdn.test/p.jpg' });

    expect(result).toEqual({ messageId: 'wamid.456' });
  });

  it('throws a clear error when a meta config is missing its credentials', async () => {
    const config: WhatsAppConfig = { ...BASE_CONFIG, provider: 'meta' };

    await expect(
      sendMedia(config, { to: '1', kind: 'image', link: 'https://cdn.test/x.jpg' }),
    ).rejects.toThrow(/Meta WhatsApp not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a clear error when a uazapi config is missing its instance token', async () => {
    const config: WhatsAppConfig = { ...BASE_CONFIG, provider: 'uazapi' };

    await expect(
      sendMedia(config, { to: '1', kind: 'image', link: 'https://cdn.test/x.jpg' }),
    ).rejects.toThrow(/UAZAPI instance not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
