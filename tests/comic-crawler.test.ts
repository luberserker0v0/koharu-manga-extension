import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComicCrawlerClient } from '../lib/comic-crawler/client';
import { ComicCrawlerDetector } from '../lib/page-images/comic-crawler-detector';

const settings = {
  enabled: true,
  autoApplyPreviousTranslation: false,
  baseUrl: 'http://127.0.0.1:4100',
  username: 'reader',
  password: 'secret',
  userId: '',
  userToken: '',
};

function chapterImagesResponse(imageUrls: string[]) {
  return {
    adapterId: 'reader',
    chapterUrl: 'https://reader.test/chapter',
    chapter: {
      id: 'chapter-stable',
      canonicalUrl: 'https://reader.test/chapter',
      stability: 'deterministic',
      identitySource: 'normalized-url',
    },
    imageUrlCount: imageUrls.length,
    imageUrls,
    images: imageUrls.map((url, orderIndex) => ({
      id: `page-${orderIndex + 1}`,
      orderIndex,
      url,
      ...(orderIndex === 0 ? { sourceFingerprint: 'etag:page-1' } : {}),
    })),
    domSource: 'dynamic',
    durationMs: 42,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ComicCrawler integration', () => {
  it('uses Basic authentication without exposing credentials in request URLs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await new ComicCrawlerClient(settings).status();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:4100/api/status');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${btoa('reader:secret')}`);
    expect(String(url)).not.toContain('secret');
  });

  it('uses user authentication for existing-tab task creation without putting credentials in the URL or body', async () => {
    const authenticated = { ...settings, userId: 'alice', userToken: 'user-secret' };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: {
      kind: 'taskCreated',
      taskId: 'task-1',
      browserTarget: { mode: 'existing-tab', workerId: 'worker-1', resourceId: 'resource-1' },
    } }), { status: 201 }));
    await new ComicCrawlerClient(authenticated).createExistingTabTask(
      'https://reader.test/chapter',
      { mode: 'existing-tab', workerId: 'worker-1', resourceId: 'resource-1' },
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:4100/api/tasks');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer user-secret');
    expect(new Headers(init?.headers).get('X-ComicCrawler-User-Id')).toBe('alice');
    expect(JSON.parse(String(init?.body))).toEqual({
      url: 'https://reader.test/chapter',
      mode: 'chapters',
      chapterUrls: ['https://reader.test/chapter'],
      browserTarget: { mode: 'existing-tab', workerId: 'worker-1', resourceId: 'resource-1' },
    });
    expect(String(url)).not.toContain('user-secret');
    expect(String(init?.body)).not.toContain('user-secret');
  });

  it('rebinds a recoverable task with an optimistic old target and an explicitly registered new target', async () => {
    const authenticated = { ...settings, userId: 'alice', userToken: 'user-secret' };
    const expectedBrowserTarget = { mode: 'existing-tab' as const, workerId: 'worker-old', resourceId: 'resource-old' };
    const browserTarget = { mode: 'existing-tab' as const, workerId: 'worker-new', resourceId: 'resource-new' };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: {
      task: { id: 'task-1', status: 'pending', browserTarget },
      previousBrowserTarget: expectedBrowserTarget,
      recovery: {
        reason: 'browser_client_process_restarted',
        reboundAt: '2026-10-19T00:00:00.000Z',
        idempotent: false,
      },
    } }), { status: 200 }));

    await new ComicCrawlerClient(authenticated).rebindBrowserTarget(
      'task/with reserved characters',
      expectedBrowserTarget,
      browserTarget,
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:4100/api/tasks/task%2Fwith%20reserved%20characters/rebind-browser-target');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ expectedBrowserTarget, browserTarget });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer user-secret');
    expect(String(init?.body)).not.toContain('user-secret');
  });

  it('preserves the documented recovery error code for actionable handling', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'The task Browser Target changed after it was inspected.',
      code: 'STALE_TARGET',
    }), { status: 409, headers: { 'content-type': 'application/json' } }));

    await expect(new ComicCrawlerClient(settings).rebindBrowserTarget(
      'task-1',
      { mode: 'existing-tab', workerId: 'worker-old', resourceId: 'resource-old' },
      { mode: 'existing-tab', workerId: 'worker-new', resourceId: 'resource-new' },
    )).rejects.toMatchObject({
      kind: 'api',
      status: 409,
      code: 'STALE_TARGET',
    });
  });

  it('preserves a chapter-image verification handoff from the documented 409 response', async () => {
    const browserTarget = { mode: 'existing-tab' as const, workerId: 'worker-1', resourceId: 'resource-1' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'Human verification is required.',
      code: 'CHAPTER_IMAGES_VERIFICATION_REQUIRED',
      data: {
        status: 'verification_required',
        challengeDiscoveryId: 'challenge-1',
        challengeStatus: 'queued',
        challenge: {
          id: 'challenge-1',
          status: 'queued',
          normalizedUrl: 'https://reader.test/chapter',
          retryableAfterVerification: true,
          ownerUserId: 'reader-1',
          browserTarget,
        },
      },
    }), { status: 409, headers: { 'content-type': 'application/json' } }));

    await expect(new ComicCrawlerClient(settings).extractChapterImages(
      'https://reader.test/chapter',
      { browserTarget },
    )).rejects.toMatchObject({
      name: 'ChapterImagesVerificationRequiredError',
      code: 'CHAPTER_IMAGES_VERIFICATION_REQUIRED',
      verification: {
        challengeDiscoveryId: 'challenge-1',
        challenge: { browserTarget },
      },
    });
  });

  it('retries chapter-image extraction through the background with the same challenge ID', async () => {
    const sendMessage = vi.fn(async () => chapterImagesResponse(['https://cdn.test/a.jpg']));
    vi.stubGlobal('browser', { runtime: { sendMessage } });

    await new ComicCrawlerClient(settings, { useBackgroundProxy: true }).extractChapterImages(
      'https://reader.test/chapter',
      { challengeDiscoveryId: 'challenge-1' },
    );

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'COMIC_CRAWLER_CHAPTER_IMAGES',
      url: 'https://reader.test/chapter',
      challengeDiscoveryId: 'challenge-1',
    });
  });

  it('reconstructs a typed verification error returned by the background proxy', async () => {
    vi.stubGlobal('browser', { runtime: { sendMessage: vi.fn(async () => ({
      kind: 'verification_required',
      data: {
        status: 'verification_required',
        challengeDiscoveryId: 'challenge-1',
        challengeStatus: 'challenge_required',
        challenge: {
          id: 'challenge-1',
          status: 'challenge_required',
          normalizedUrl: 'https://reader.test/chapter',
          retryableAfterVerification: true,
        },
      },
    })) } });

    await expect(new ComicCrawlerClient(settings, { useBackgroundProxy: true })
      .extractChapterImages('https://reader.test/chapter'))
      .rejects.toMatchObject({
        name: 'ChapterImagesVerificationRequiredError',
        verification: { challengeDiscoveryId: 'challenge-1' },
      });
  });

  it('accepts the current ComicCrawler status response shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: {
        version: '0.1.0',
        uptime: 199.6,
        activeTasks: 0,
        queuedTasks: 0,
        adapters: { loaded: 2, enabled: 2 },
      },
    }), { status: 200 }));

    await expect(new ComicCrawlerClient(settings).status()).resolves.toBe(true);
  });

  it('routes page-context requests through the background without exposing credentials', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ status: 'matched', adapter: { id: 'reader' } });
    vi.stubGlobal('browser', { runtime: { sendMessage } });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(new ComicCrawlerClient(settings, { useBackgroundProxy: true }).resolveAdapter('https://reader.test/chapter'))
      .resolves.toMatchObject({ status: 'matched' });

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'COMIC_CRAWLER_RESOLVE_ADAPTER',
      url: 'https://reader.test/chapter',
    });
    expect(sendMessage.mock.calls[0]?.[0]).not.toHaveProperty('username');
    expect(sendMessage.mock.calls[0]?.[0]).not.toHaveProperty('password');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns discovery availability when no approved adapter matches', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { status: 'not_found' } }), { status: 200 }));
    const result = await new ComicCrawlerDetector(new ComicCrawlerClient(settings)).detect('https://reader.test/chapter');
    expect(result.images).toEqual([]);
    expect(result.discoveryAvailable).toBe(true);
    expect(result.adapterStatus).toBe('not_found');
  });

  it('resolves the specific-chapters capability and queues only the current page', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { status: 'not_found' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { kind: 'discoveryQueued', discoveryId: 'discovery-1' } }), { status: 202 }));
    const client = new ComicCrawlerClient(settings);

    await client.resolveAdapter('https://reader.test/chapter');
    await expect(client.queueDiscovery('https://reader.test/chapter', 'specific_chapters')).resolves.toEqual({
      discoveryId: 'discovery-1',
      feature: 'specific_chapters',
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      url: 'https://reader.test/chapter',
      mode: 'chapters',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      url: 'https://reader.test/chapter',
      mode: 'chapters',
      chapterUrls: ['https://reader.test/chapter'],
    });
  });

  it('keeps the complete chapter-image response order', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { status: 'matched', adapter: { id: 'reader' } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: chapterImagesResponse([
        'https://cdn.test/b.jpg',
        'https://cdn.test/a.jpg',
      ]) }), { status: 200 }));
    const result = await new ComicCrawlerDetector(new ComicCrawlerClient(settings)).detect('https://reader.test/chapter');
    expect(result.chapterUrl).toBe('https://reader.test/chapter');
    expect(result.images.map((image) => image.fileName)).toEqual(['b.jpg', 'a.jpg']);
    expect(result.images.map((image) => image.sourceUrl)).toEqual(['https://cdn.test/b.jpg', 'https://cdn.test/a.jpg']);
    expect(result.chapterIdentity).toMatchObject({ id: 'chapter-stable', stability: 'deterministic' });
    expect(result.images.map((image) => image.comicCrawler)).toEqual([
      { chapterId: 'chapter-stable', pageId: 'page-1', sourceOrderIndex: 0, sourceFingerprint: 'etag:page-1' },
      { chapterId: 'chapter-stable', pageId: 'page-2', sourceOrderIndex: 1 },
    ]);
  });

  it('can resolve adapter support without starting chapter-image extraction', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        version: '0.2.0', uptime: 1, adapters: { loaded: 1, enabled: 1 },
      } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        status: 'matched', adapter: { id: 'comix', name: 'Comix' },
      } }), { status: 200 }));

    const result = await new ComicCrawlerDetector(new ComicCrawlerClient(settings)).detect(
      'https://comix.to/title/example/chapter-1',
      { resolveOnly: true, timeoutMs: 100 },
    );

    expect(result).toMatchObject({
      images: [],
      adapterStatus: 'matched',
      adapter: { id: 'comix' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/adapters/chapter-images'))).toBe(false);
  });

  it('converts a stalled ComicCrawler request into a bounded fallback result', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
    const startedAt = Date.now();

    const result = await new ComicCrawlerDetector(new ComicCrawlerClient(settings)).detect(
      'https://comix.to/title/example/chapter-1',
      { timeoutMs: 20 },
    );

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result).toMatchObject({
      images: [],
      warnings: ['comicCrawler_timeout'],
    });
  });

  it('falls back safely when chapter image extraction fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { status: 'matched', adapter: { id: 'reader' } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    const result = await new ComicCrawlerDetector(new ComicCrawlerClient(settings)).detect('https://reader.test/chapter');
    expect(result.images).toEqual([]);
    expect(result.warnings[0]).toBe('comicCrawler_api');
  });

  it('rejects an inconsistent image count', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: {
      ...chapterImagesResponse(['https://cdn.test/a.jpg']),
      imageUrlCount: 2,
    } }), { status: 200 }));
    await expect(new ComicCrawlerClient(settings).extractChapterImages('https://reader.test/chapter'))
      .rejects.toMatchObject({ kind: 'contract' });
  });

  it('keeps chapter lists larger than the old 24-file preview limit', async () => {
    const imageUrls = Array.from({ length: 30 }, (_, index) => `https://cdn.test/${index + 1}.jpg`);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: chapterImagesResponse(imageUrls),
    }), { status: 200 }));
    const result = await new ComicCrawlerClient(settings).extractChapterImages('https://reader.test/chapter', {
      browserTarget: { mode: 'existing-tab', workerId: 'worker-1', resourceId: 'resource-1' },
      renderContext: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
      },
    });
    expect(result.imageUrls).toHaveLength(30);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:4100/api/adapters/chapter-images');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      url: 'https://reader.test/chapter',
      browserTarget: { mode: 'existing-tab', workerId: 'worker-1', resourceId: 'resource-1' },
      renderContext: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
      },
    });
  });

  it('reports a matched adapter that still needs current-tab Browser Client approval', async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'COMIC_CRAWLER_STATUS') return true;
      if (message.type === 'COMIC_CRAWLER_RESOLVE_ADAPTER') {
        return { status: 'matched', adapter: { id: 'comix', name: 'Comix' } };
      }
      if (message.type === 'COMIC_CRAWLER_CHAPTER_IMAGES') {
        throw new Error('comicCrawler_browser_target_required');
      }
      throw new Error(`Unexpected message: ${message.type}`);
    });
    vi.stubGlobal('browser', { runtime: { sendMessage } });

    const result = await new ComicCrawlerDetector(
      new ComicCrawlerClient(settings, { useBackgroundProxy: true }),
    ).detect('https://comix.to/title/example/chapter-1');

    expect(result).toMatchObject({
      images: [],
      warnings: ['comicCrawler_browser_target_required'],
    });
  });
});
