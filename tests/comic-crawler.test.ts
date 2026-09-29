import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComicCrawlerClient } from '../lib/comic-crawler/client';
import { ComicCrawlerDetector } from '../lib/page-images/comic-crawler-detector';

const settings = {
  enabled: true,
  autoApplyPreviousTranslation: false,
  baseUrl: 'http://127.0.0.1:4100',
  username: 'reader',
  password: 'secret',
};

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
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        adapterId: 'reader',
        chapterUrl: 'https://reader.test/chapter',
        imageUrlCount: 2,
        imageUrls: ['https://cdn.test/b.jpg', 'https://cdn.test/a.jpg'],
        domSource: 'dynamic',
        durationMs: 42,
      } }), { status: 200 }));
    const result = await new ComicCrawlerDetector(new ComicCrawlerClient(settings)).detect('https://reader.test/chapter');
    expect(result.chapterUrl).toBe('https://reader.test/chapter');
    expect(result.images.map((image) => image.fileName)).toEqual(['b.jpg', 'a.jpg']);
    expect(result.images.map((image) => image.sourceUrl)).toEqual(['https://cdn.test/b.jpg', 'https://cdn.test/a.jpg']);
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
      adapterId: 'reader', chapterUrl: 'https://reader.test/chapter', imageUrlCount: 2,
      imageUrls: ['https://cdn.test/a.jpg'], domSource: 'static', durationMs: 1,
    } }), { status: 200 }));
    await expect(new ComicCrawlerClient(settings).extractChapterImages('https://reader.test/chapter'))
      .rejects.toMatchObject({ kind: 'contract' });
  });

  it('keeps chapter lists larger than the old 24-file preview limit', async () => {
    const imageUrls = Array.from({ length: 30 }, (_, index) => `https://cdn.test/${index + 1}.jpg`);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: {
      adapterId: 'reader', chapterUrl: 'https://reader.test/chapter', imageUrlCount: imageUrls.length,
      imageUrls, domSource: 'dynamic', durationMs: 20,
    } }), { status: 200 }));
    const result = await new ComicCrawlerClient(settings).extractChapterImages('https://reader.test/chapter');
    expect(result.imageUrls).toHaveLength(30);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:4100/api/adapters/chapter-images');
  });
});
