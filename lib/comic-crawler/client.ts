import type { ComicCrawlerSettings } from '../api/types';
import { normalizeServiceBaseUrl } from '../api/url';
import { ComicCrawlerError } from './errors';
import type { AdapterDiscoveryFeature, AdapterResolution, ChapterImagesResponse, DiscoveryQueued } from './types';

interface Envelope<T> { data?: T }

interface ComicCrawlerClientOptions {
  useBackgroundProxy?: boolean;
}

function basicAuth(username: string, password: string): string {
  const encoded = btoa(unescape(encodeURIComponent(`${username}:${password}`)));
  return `Basic ${encoded}`;
}

export class ComicCrawlerClient {
  readonly baseUrl: string;
  private readonly authorization: string | null;
  private readonly useBackgroundProxy: boolean;

  constructor(settings: ComicCrawlerSettings, options: ComicCrawlerClientOptions = {}) {
    this.baseUrl = normalizeServiceBaseUrl(settings.baseUrl);
    this.authorization = settings.username ? basicAuth(settings.username, settings.password) : null;
    this.useBackgroundProxy = options.useBackgroundProxy === true;
  }

  private async proxy<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    return await browser.runtime.sendMessage({ type, ...payload }) as T;
  }

  private async request(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(pathOrUrl, `${this.baseUrl}/`);
    if (url.origin !== new URL(this.baseUrl).origin) throw new ComicCrawlerError('ComicCrawler returned an untrusted content URL.', 'contract');
    const headers = new Headers(init.headers);
    if (this.authorization) headers.set('Authorization', this.authorization);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let response: Response;
    try { response = await fetch(url, { ...init, headers }); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ComicCrawlerError('ComicCrawler could not be reached.', 'network');
    }
    if (!response.ok) {
      throw new ComicCrawlerError(
        `ComicCrawler request failed with HTTP ${response.status}.`,
        'api',
        response.status,
      );
    }
    return response;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    const value = await response.json() as T | Envelope<T>;
    if (value && typeof value === 'object' && 'data' in value && value.data) return value.data;
    return value as T;
  }

  async status(signal?: AbortSignal): Promise<boolean> {
    if (this.useBackgroundProxy) return await this.proxy<boolean>('COMIC_CRAWLER_STATUS');
    const response = await this.request('/api/status', { signal });
    const raw = await response.json() as Record<string, unknown>;
    const body = raw.data && typeof raw.data === 'object' ? raw.data as Record<string, unknown> : raw;
    if (typeof body.status === 'string') return ['ok', 'ready', 'running'].includes(body.status);
    if (typeof body.ok === 'boolean') return body.ok;
    // Current ComicCrawler status responses describe the healthy process with
    // version, uptime, task counts, memory, and adapter counts rather than a
    // separate `ok` flag. A successful 2xx response with that object is ready.
    return typeof body.version === 'string' && typeof body.uptime === 'number';
  }

  resolveAdapter(url: string, signal?: AbortSignal): Promise<AdapterResolution> {
    if (this.useBackgroundProxy) return this.proxy<AdapterResolution>('COMIC_CRAWLER_RESOLVE_ADAPTER', { url });
    return this.json('/api/adapters/resolve', { method: 'POST', body: JSON.stringify({ url, mode: 'chapters' }), signal });
  }

  async extractChapterImages(url: string, signal?: AbortSignal): Promise<ChapterImagesResponse> {
    const result = this.useBackgroundProxy
      ? await this.proxy<ChapterImagesResponse>('COMIC_CRAWLER_CHAPTER_IMAGES', { url })
      : await this.json<ChapterImagesResponse>('/api/adapters/chapter-images', {
          method: 'POST',
          body: JSON.stringify({ url }),
          signal,
        });
    if (!Array.isArray(result.imageUrls) || result.imageUrlCount !== result.imageUrls.length) {
      throw new ComicCrawlerError('ComicCrawler returned an invalid chapter-image count.', 'contract');
    }
    return result;
  }

  async queueDiscovery(url: string, feature: AdapterDiscoveryFeature, signal?: AbortSignal): Promise<DiscoveryQueued> {
    if (feature !== 'specific_chapters') throw new ComicCrawlerError('Unsupported adapter discovery feature.', 'contract');
    if (this.useBackgroundProxy) return await this.proxy<DiscoveryQueued>('COMIC_CRAWLER_QUEUE_DISCOVERY', { url, feature });
    const value = await this.json<Record<string, unknown>>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ url, mode: 'chapters', chapterUrls: [url] }),
      signal,
    });
    const id = value.discoveryId ?? value.challengeDiscoveryId;
    if (typeof id !== 'string' || !id) throw new ComicCrawlerError('ComicCrawler did not return a discovery ID.', 'contract');
    return { discoveryId: id, feature };
  }
}
