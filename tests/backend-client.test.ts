import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendClient } from '../lib/api/backend-client';
import { BackendApiError } from '../lib/api/errors';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BackendClient', () => {
  it('uses the public unversioned health route without authorization', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new BackendClient({ baseUrl: 'http://127.0.0.1:4001/api/v1/', token: 'secret' });

    await expect(client.health()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/health', { signal: undefined });
  });

  it('uses versioned routes and Bearer authentication', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      backend: { status: 'ready' },
      koharu: { status: 'running' },
      agent: { status: 'unconfigured' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = new BackendClient({ baseUrl: 'http://127.0.0.1:4001/api/v1', token: 'secret' });

    await client.runtimeStatus();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:4001/api/v1/runtime/status');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret');
  });

  it('routes content-script requests through the background without exposing the token', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      encoding: 'text',
      body: JSON.stringify({ backend: { status: 'ready' }, koharu: { status: 'running' }, agent: { status: 'ready' } }),
    });
    vi.stubGlobal('browser', { runtime: { sendMessage } });
    const client = new BackendClient(
      { baseUrl: 'http://127.0.0.1:4001/api/v1', token: 'protected-secret' },
      { useBackgroundProxy: true },
    );

    await expect(client.runtimeStatus()).resolves.toMatchObject({ backend: { status: 'ready' } });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'BACKEND_REQUEST',
      path: '/runtime/status',
      method: 'GET',
    }));
    expect(JSON.stringify(sendMessage.mock.calls[0]?.[0])).not.toContain('protected-secret');
  });

  it('routes the unversioned health check through the background proxy', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      encoding: 'text',
      body: JSON.stringify({ ok: true }),
    });
    vi.stubGlobal('browser', { runtime: { sendMessage } });
    const client = new BackendClient(
      { baseUrl: 'http://127.0.0.1:4001/api/v1', token: '' },
      { useBackgroundProxy: true },
    );

    await expect(client.health()).resolves.toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'BACKEND_REQUEST',
      path: '/health',
      health: true,
    }));
  });

  it('reads the sanitized Koharu translation-provider catalog', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      providers: [{ providerId: 'deepl', name: 'DeepL', kind: 'machine_translation', status: 'ready', hasCredential: true, models: [] }],
      defaultTarget: { providerId: 'deepl', modelId: 'mt' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4001/api/v1', token: 'secret' });

    await expect(client.getTranslationProviders()).resolves.toMatchObject({ defaultTarget: { providerId: 'deepl', modelId: 'mt' } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4001/api/v1/runtime/koharu/translation-providers');
  });

  it('serializes JSON requests centrally', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      uploadId: '11111111-1111-1111-1111-111111111111',
      kind: 'source',
      status: 'uploading',
      files: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4001/api/v1', token: '' });

    await client.createUpload();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(init?.body).toBe(JSON.stringify({ kind: 'source' }));
  });

  it('preserves status, backend detail, and request ID on errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-42' },
    }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4001/api/v1', token: 'wrong' });

    const error = await client.runtimeStatus().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackendApiError);
    expect(error).toMatchObject({ status: 401, message: 'Unauthorized', requestId: 'req-42' });
  });

  it('requests the message-envelope SSE endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4001/api/v1', token: '' });

    await client.stream('job/with spaces');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:4001/api/v1/jobs/job%2Fwith%20spaces/stream?eventMode=message');
    expect(new Headers(init?.headers).get('Accept')).toBe('text/event-stream');
  });

  it.each([
    ['retryJob', 'retry'],
    ['resumeJob', 'resume'],
  ] as const)('creates an explicit job attempt through %s', async (method, suffix) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'job-2' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4001/api/v1', token: '' });
    await client[method]('job-1');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:4001/api/v1/jobs/job-1/${suffix}`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
  });

  it('deletes a retained upload only through the upload API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4001/api/v1', token: '' });
    await client.deleteUpload('upload-1');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4001/api/v1/uploads/upload-1');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });

  it('falls back to binary XHR when fetch rejects an artifact download', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const open = vi.fn();
    const send = vi.fn(function (this: XMLHttpRequest) {
      Object.defineProperties(this, {
        status: { value: 200 },
        response: { value: new Blob(['zip'], { type: 'application/zip' }) },
      });
      this.dispatchEvent(new Event('load'));
      this.dispatchEvent(new Event('loadend'));
    });
    class FakeXhr extends EventTarget {
      status = 0;
      response: Blob | null = null;
      responseType: XMLHttpRequestResponseType = '';
      open = open;
      send = send;
      setRequestHeader = vi.fn();
      getResponseHeader = vi.fn(() => null);
      abort = vi.fn();
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const client = new BackendClient({ baseUrl: 'http://localhost:4001/api/v1', token: '' });

    const result = await client.downloadArtifact('job-1', { id: 8, kind: 'export' });

    expect(result.blob.type).toBe('application/zip');
    expect(result.fileName).toBe('export-8');
    expect(open).toHaveBeenCalledWith('GET', 'http://localhost:4001/api/v1/jobs/job-1/artifacts/8/content');
    expect(send).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('lists translated images and downloads image content through versioned routes', async () => {
    const image = {
      id: 'page-0001-abcd', index: 0, fileName: 'page-001.png', mediaType: 'image/png', size: 4,
      encodedUrl: '/api/v1/jobs/job-1/translated-images/page-0001-abcd',
      contentUrl: '/api/v1/jobs/job-1/translated-images/page-0001-abcd/content',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jobId: 'job-1', artifactId: 8, sourceFormat: 'zip', count: 1, images: [image],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('page', { status: 200, headers: { 'Content-Type': 'image/png' } }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4001/api/v1', token: 'secret' });

    await expect(client.getTranslatedImages('job-1')).resolves.toMatchObject({ count: 1 });
    await expect(client.downloadTranslatedImage('job-1', image)).resolves.toMatchObject({ type: 'image/png' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4001/api/v1/jobs/job-1/translated-images');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://localhost:4001/api/v1/jobs/job-1/translated-images/page-0001-abcd/content');
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe('Bearer secret');
  });
});
