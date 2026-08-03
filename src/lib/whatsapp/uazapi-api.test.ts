import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startSession,
  getQrCode,
  getSessionStatus,
  closeSession,
  sendText,
  sendMedia,
} from './uazapi-api';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('uazapi-api', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('startSession', () => {
    it('posts to /start with apitoken + sessionkey headers and wh_* body fields', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ result: 'success', session: 'acct_abc', state: 'STARTING', status: 'notLogged' }),
      );

      const result = await startSession({
        session: 'acct_abc',
        sessionkey: 'key_abc',
        webhooks: {
          connect: 'https://app.test/webhook/uazapi/acct_abc',
          qrcode: 'https://app.test/webhook/uazapi/acct_abc',
          status: 'https://app.test/webhook/uazapi/acct_abc',
          message: 'https://app.test/webhook/uazapi/acct_abc',
        },
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://uazapi.test/start',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            apitoken: 'test-uazapi-token',
            sessionkey: 'key_abc',
          }),
        }),
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({
        session: 'acct_abc',
        wh_connect: 'https://app.test/webhook/uazapi/acct_abc',
        wh_qrcode: 'https://app.test/webhook/uazapi/acct_abc',
        wh_status: 'https://app.test/webhook/uazapi/acct_abc',
        wh_message: 'https://app.test/webhook/uazapi/acct_abc',
      });
      expect(result).toEqual({ state: 'STARTING', status: 'notLogged' });
    });
  });

  describe('getQrCode', () => {
    it('fetches raw PNG bytes and re-encodes as a data URI', async () => {
      const pngBytes = new Uint8Array([137, 80, 78, 71]); // PNG magic bytes
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => pngBytes.buffer,
      } as unknown as Response);

      const result = await getQrCode({ session: 'acct_abc', sessionkey: 'key_abc' });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://uazapi.test/getQrCode?session=acct_abc&sessionkey=key_abc',
        expect.objectContaining({ headers: { 'content-type': 'application/json' } }),
      );
      expect(result.dataUri).toBe(`data:image/png;base64,${Buffer.from(pngBytes).toString('base64')}`);
    });
  });

  describe('getSessionStatus', () => {
    it('posts to /getSessionStatus with only sessionkey (no apitoken)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ result: 200, status: 'inChat', state: 'CONNECTED' }));

      const result = await getSessionStatus({ session: 'acct_abc', sessionkey: 'key_abc' });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://uazapi.test/getSessionStatus');
      expect(init.headers).toEqual({ 'content-type': 'application/json', sessionkey: 'key_abc' });
      expect(init.headers.apitoken).toBeUndefined();
      expect(JSON.parse(init.body)).toEqual({ session: 'acct_abc' });
      expect(result).toEqual({ status: 'inChat', state: 'CONNECTED' });
    });
  });

  describe('closeSession', () => {
    it('posts to /closeSession and resolves on success', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: true, message: 'Sessão Fechada com sucesso' }));

      await expect(closeSession({ session: 'acct_abc', sessionkey: 'key_abc' })).resolves.toBeUndefined();
      expect(fetchMock.mock.calls[0][0]).toBe('https://uazapi.test/closeSession');
    });
  });

  describe('sendText', () => {
    it('posts to /sendText and returns the UAZAPI messageId', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          result: 200,
          type: 'text',
          session: 'acct_abc',
          messageId: 'true_5521989848442@c.us_ABC123',
          from: '5521989848442',
          to: '5521989848442',
          content: 'oi',
        }),
      );

      const result = await sendText({
        session: 'acct_abc',
        sessionkey: 'key_abc',
        number: '5521989848442',
        text: 'oi',
      });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        session: 'acct_abc',
        number: '5521989848442',
        text: 'oi',
      });
      expect(result).toEqual({ messageId: 'true_5521989848442@c.us_ABC123' });
    });

    it('throws when a 2xx response is missing messageId', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ result: 200 }));

      await expect(
        sendText({ session: 'acct_abc', sessionkey: 'key_abc', number: '5521989848442', text: 'oi' }),
      ).rejects.toThrow(/no messageId/);
    });
  });

  describe('sendMedia', () => {
    it('routes "image" to /sendImage', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ result: 200, messageId: 'msg-1' }));

      await sendMedia({
        session: 'acct_abc',
        sessionkey: 'key_abc',
        number: '5521989848442',
        kind: 'image',
        path: 'https://cdn.test/photo.jpg',
        caption: 'legenda',
      });

      expect(fetchMock.mock.calls[0][0]).toBe('https://uazapi.test/sendImage');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        session: 'acct_abc',
        number: '5521989848442',
        caption: 'legenda',
        path: 'https://cdn.test/photo.jpg',
      });
    });

    it('routes "document" to /sendFile', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ result: 200, messageId: 'msg-2' }));

      await sendMedia({
        session: 'acct_abc',
        sessionkey: 'key_abc',
        number: '5521989848442',
        kind: 'document',
        path: 'https://cdn.test/file.pdf',
      });

      expect(fetchMock.mock.calls[0][0]).toBe('https://uazapi.test/sendFile');
    });

    it('rejects a missing path before calling fetch', async () => {
      await expect(
        sendMedia({ session: 's', sessionkey: 'k', number: 'n', kind: 'image', path: '' }),
      ).rejects.toThrow(/requires a path/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws when a 2xx response is missing messageId', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ result: 200 }));

      await expect(
        sendMedia({
          session: 'acct_abc',
          sessionkey: 'key_abc',
          number: '5521989848442',
          kind: 'image',
          path: 'https://cdn.test/photo.jpg',
        }),
      ).rejects.toThrow(/no messageId/);
    });
  });

  describe('error handling', () => {
    it('throws the message from a JSON error body', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'session/sessionkey incorreto' }, false, 401));

      await expect(sendText({ session: 's', sessionkey: 'wrong', number: 'n', text: 't' })).rejects.toThrow(
        'session/sessionkey incorreto',
      );
    });

    it('falls back to a status-code message when the error body is not JSON', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json');
        },
      } as unknown as Response);

      await expect(sendText({ session: 's', sessionkey: 'k', number: 'n', text: 't' })).rejects.toThrow(
        'UAZAPI error: 500',
      );
    });
  });
});
