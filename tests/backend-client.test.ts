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

  it('uses the versioned readiness route before runtime inspection', async () => {
    const readiness = {
      ok: true,
      status: 'degraded',
      checkedAt: '2026-10-27T00:00:00.000Z',
      deploymentMode: 'docker',
      services: {
        backend: { required: true, ready: true, status: 'ready' },
        koharu: { required: true, ready: true, status: 'running', mode: 'external' },
        ao: { required: false, ready: false, status: 'unavailable' },
      },
      capabilities: { koharuJobs: true, aoJobs: false },
      blockers: [],
      warnings: [{ service: 'ao', code: 'ao_unavailable', message: 'AO is unavailable.' }],
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(readiness), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4001/api/v1', token: 'secret' });

    await expect(client.readiness()).resolves.toEqual(readiness);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4001/api/v1/ready');
  });

  it('returns a structured blocked readiness response from HTTP 503', async () => {
    const readiness = {
      ok: false,
      status: 'blocked',
      checkedAt: '2026-10-27T00:00:00.000Z',
      deploymentMode: 'docker',
      services: {
        backend: { required: true, ready: true, status: 'ready' },
        koharu: { required: true, ready: false, status: 'unavailable', mode: 'external' },
        ao: { required: false, ready: true, status: 'ready' },
      },
      capabilities: { koharuJobs: false, aoJobs: true },
      blockers: [{ service: 'koharu', code: 'koharu_unavailable', message: 'Koharu is unavailable.' }],
      warnings: [],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(readiness), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4001/api/v1', token: '' });

    await expect(client.readiness()).resolves.toEqual(readiness);
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

  it('deletes an abandoned pre-preflight upload only through the upload API', async () => {
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
      sourceImageId: 'source-1', sourceOrderIndex: 0, revisionId: 'revision-1', revisionNumber: 1, active: true,
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

  it('creates a selective retranslation with only explicit overrides', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'job-revision-1',
      status: 'queued',
      revision: {
        rootJobId: 'job-root',
        parentJobId: 'job-parent',
        reason: 'selective_retranslation',
        sourceImageIds: ['source-3'],
      },
    }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4001/api/v1', token: '' });

    await client.createRetranslation('job/parent', {
      sourceImageIds: ['source-3'],
      instructions: 'Preserve the name Koharu.',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4001/api/v1/jobs/job%2Fparent/retranslations');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ sourceImageIds: ['source-3'], instructions: 'Preserve the name Koharu.' }),
    });
  });

  it('reads text regions and queues a batch correction through versioned routes', async () => {
    const snapshot = {
      jobId: 'job-parent',
      rootJobId: 'job-root',
      snapshotFingerprint: 'snapshot-1',
      pages: [],
    };
    const queued = {
      id: 'job-correction',
      type: 'translation',
      status: 'queued',
      stage: 'queued',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(queued), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4001/api/v1', token: '' });
    const correction = {
      pages: [{
        sourceImageId: 'source/1',
        baseRegionSetRevisionId: 'region-set-1',
        regions: [{ regionId: 'region-1', sourceText: 'intergalactic' }],
      }],
    };

    await expect(client.getTextRegions('job/parent', 'source/1')).resolves.toEqual(snapshot);
    await expect(client.createTextRegionCorrection('job/parent', correction)).resolves.toEqual(queued);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4001/api/v1/jobs/job%2Fparent/text-regions?sourceImageId=source%2F1');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://localhost:4001/api/v1/jobs/job%2Fparent/text-region-corrections');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(correction),
    });
  });

  it('reads and atomically activates page revisions', async () => {
    const manifest = {
      rootJobId: 'job-root',
      sourcePreflightId: 'preflight-1',
      pageCount: 1,
      pages: [{ sourceImageId: 'source-1', sourceOrderIndex: 0, activeRevisionId: 'revision-1', revisions: [] }],
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4001/api/v1', token: '' });

    await expect(client.getPageRevisions('job-root')).resolves.toEqual(manifest);
    await expect(client.activatePageRevisions('job-root', [{ sourceImageId: 'source-1', revisionId: 'revision-1' }]))
      .resolves.toEqual(manifest);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4001/api/v1/jobs/job-root/page-revisions');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://localhost:4001/api/v1/jobs/job-root/page-revisions/activate');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ selections: [{ sourceImageId: 'source-1', revisionId: 'revision-1' }] }),
    });
  });

  it('downloads revision image bytes through the producing job API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('page', {
      status: 200,
      headers: { 'Content-Type': 'image/webp' },
    }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4001/api/v1', token: 'secret' });

    const blob = await client.downloadPageRevisionImage({
      revisionId: 'revision-2',
      revisionNumber: 2,
      active: false,
      jobId: 'job/revision',
      createdAt: '2026-10-19T00:00:00.000Z',
      image: {
        id: 'image/revision-2',
        index: 0,
        fileName: 'page.webp',
        mediaType: 'image/webp',
        size: 4,
        encodedUrl: '/ignored',
        contentUrl: '/ignored',
      },
    });

    expect(blob.type).toBe('image/webp');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4001/api/v1/jobs/job%2Frevision/translated-images/image%2Frevision-2/content');
  });
});
