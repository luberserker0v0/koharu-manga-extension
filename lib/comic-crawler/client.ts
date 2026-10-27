import type { ComicCrawlerSettings } from '../api/types';
import { normalizeServiceBaseUrl } from '../api/url';
import { ChapterImagesVerificationRequiredError, ComicCrawlerError } from './errors';
import type {
  AdapterDiscoveryFeature,
  AdapterResolution,
  BrowserTarget,
  ChallengeDiscoveryJob,
  ChapterRenderContext,
  ChapterImagesResponse,
  ChapterImagesProxyResponse,
  ChapterImagesVerificationData,
  CreateCrawlerTaskResponse,
  CrawlerTaskDetail,
  DiscoveryQueued,
  RebindBrowserTargetResponse,
} from './types';

interface Envelope<T> { data?: T }

interface ComicCrawlerClientOptions {
  useBackgroundProxy?: boolean;
}

interface ChapterImagesOptions {
  signal?: AbortSignal;
  browserTarget?: BrowserTarget;
  renderContext?: ChapterRenderContext;
  challengeDiscoveryId?: string;
}

function chapterImagesVerificationData(value: unknown): ChapterImagesVerificationData | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Partial<ChapterImagesVerificationData>;
  const challenge = data.challenge;
  if (data.status !== 'verification_required'
    || typeof data.challengeDiscoveryId !== 'string' || !data.challengeDiscoveryId
    || typeof data.challengeStatus !== 'string' || !data.challengeStatus
    || !challenge || typeof challenge !== 'object'
    || typeof challenge.id !== 'string' || challenge.id !== data.challengeDiscoveryId
    || typeof challenge.status !== 'string' || !challenge.status
    || typeof challenge.normalizedUrl !== 'string' || !challenge.normalizedUrl
    || typeof challenge.retryableAfterVerification !== 'boolean') return undefined;
  return data as ChapterImagesVerificationData;
}

function basicAuth(username: string, password: string): string {
  const encoded = btoa(unescape(encodeURIComponent(`${username}:${password}`)));
  return `Basic ${encoded}`;
}

export class ComicCrawlerClient {
  readonly baseUrl: string;
  private readonly authorization: string | null;
  private readonly userId: string | null;
  private readonly useBackgroundProxy: boolean;

  constructor(settings: ComicCrawlerSettings, options: ComicCrawlerClientOptions = {}) {
    this.baseUrl = normalizeServiceBaseUrl(settings.baseUrl);
    this.authorization = settings.userId && settings.userToken
      ? `Bearer ${settings.userToken}`
      : settings.username ? basicAuth(settings.username, settings.password) : null;
    this.userId = settings.userId || null;
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
    if (this.userId) headers.set('X-ComicCrawler-User-Id', this.userId);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let response: Response;
    try { response = await fetch(url, { ...init, headers }); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ComicCrawlerError('ComicCrawler could not be reached.', 'network');
    }
    if (!response.ok) {
      const payload = await response.clone().json().catch(() => undefined) as
        | { error?: unknown; code?: unknown; data?: unknown }
        | undefined;
      const serverMessage = typeof payload?.error === 'string' ? payload.error : undefined;
      const serverCode = typeof payload?.code === 'string' ? payload.code : undefined;
      if (response.status === 409 && serverCode === 'CHAPTER_IMAGES_VERIFICATION_REQUIRED') {
        const verification = chapterImagesVerificationData(payload?.data);
        if (verification) {
          throw new ChapterImagesVerificationRequiredError(
            serverMessage || 'Human verification is required.',
            verification,
          );
        }
      }
      throw new ComicCrawlerError(
        serverMessage || `ComicCrawler request failed with HTTP ${response.status}.`,
        'api',
        response.status,
        serverCode,
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

  async extractChapterImages(url: string, options: ChapterImagesOptions = {}): Promise<ChapterImagesResponse> {
    const proxied = this.useBackgroundProxy
      ? await this.proxy<ChapterImagesProxyResponse>('COMIC_CRAWLER_CHAPTER_IMAGES', {
          url,
          ...(options.renderContext ? { renderContext: options.renderContext } : {}),
          ...(options.challengeDiscoveryId ? { challengeDiscoveryId: options.challengeDiscoveryId } : {}),
        })
      : await this.json<ChapterImagesResponse>('/api/adapters/chapter-images', {
          method: 'POST',
          body: JSON.stringify({
            url,
            ...(options.browserTarget ? { browserTarget: options.browserTarget } : {}),
            ...(options.renderContext ? { renderContext: options.renderContext } : {}),
            ...(options.challengeDiscoveryId ? { challengeDiscoveryId: options.challengeDiscoveryId } : {}),
          }),
          signal: options.signal,
        });
    if (proxied && typeof proxied === 'object' && 'kind' in proxied && proxied.kind === 'verification_required') {
      const verification = chapterImagesVerificationData(proxied.data);
      if (!verification) throw new ComicCrawlerError('ComicCrawler returned an invalid verification handoff.', 'contract');
      throw new ChapterImagesVerificationRequiredError(
        proxied.message || 'Human verification is required.',
        verification,
      );
    }
    const result = proxied as ChapterImagesResponse;
    if (!Array.isArray(result.imageUrls) || result.imageUrlCount !== result.imageUrls.length
      || !result.chapter || typeof result.chapter.id !== 'string' || !result.chapter.id
      || typeof result.chapter.canonicalUrl !== 'string' || !result.chapter.canonicalUrl
      || result.chapter.stability !== 'deterministic'
      || !['adapter', 'normalized-url'].includes(result.chapter.identitySource)
      || !Array.isArray(result.images) || result.images.length !== result.imageUrls.length
      || result.images.some((image, index) => !image || typeof image.id !== 'string' || !image.id
        || image.orderIndex !== index || image.url !== result.imageUrls[index]
        || (image.sourceFingerprint !== undefined
          && (typeof image.sourceFingerprint !== 'string'
            || !/^(?:sha256|etag|opaque):.+/i.test(image.sourceFingerprint))))
      || new Set(result.images.map((image) => image.id)).size !== result.images.length) {
      throw new ComicCrawlerError('ComicCrawler returned an invalid chapter-image count.', 'contract');
    }
    try {
      new URL(result.chapter.canonicalUrl);
    } catch {
      throw new ComicCrawlerError('ComicCrawler returned an invalid canonical chapter URL.', 'contract');
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

  createExistingTabTask(url: string, browserTarget: BrowserTarget, signal?: AbortSignal): Promise<CreateCrawlerTaskResponse> {
    return this.json<CreateCrawlerTaskResponse>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        url,
        mode: 'chapters',
        chapterUrls: [url],
        browserTarget,
      }),
      signal,
    });
  }

  getTask(taskId: string, signal?: AbortSignal): Promise<CrawlerTaskDetail> {
    return this.json<CrawlerTaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`, { signal });
  }

  rebindBrowserTarget(
    taskId: string,
    expectedBrowserTarget: BrowserTarget,
    browserTarget: BrowserTarget,
    signal?: AbortSignal,
  ): Promise<RebindBrowserTargetResponse> {
    return this.json<RebindBrowserTargetResponse>(
      `/api/tasks/${encodeURIComponent(taskId)}/rebind-browser-target`,
      {
        method: 'POST',
        body: JSON.stringify({ expectedBrowserTarget, browserTarget }),
        signal,
      },
    );
  }

  async cancelTask(taskId: string, signal?: AbortSignal): Promise<void> {
    await this.json(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', signal });
  }

  async resumeTask(taskId: string, signal?: AbortSignal): Promise<void> {
    await this.json(`/api/tasks/${encodeURIComponent(taskId)}/resume`, { method: 'POST', signal });
  }

  async openVerification(challengeDiscoveryId: string, signal?: AbortSignal): Promise<void> {
    await this.json(`/api/challenge-discovery/${encodeURIComponent(challengeDiscoveryId)}/open-browser`, { method: 'POST', signal });
  }

  getVerification(challengeDiscoveryId: string, signal?: AbortSignal): Promise<ChallengeDiscoveryJob> {
    return this.json<ChallengeDiscoveryJob>(`/api/challenge-discovery/${encodeURIComponent(challengeDiscoveryId)}`, { signal });
  }

  async completeVerification(challengeDiscoveryId: string, signal?: AbortSignal): Promise<ChallengeDiscoveryJob> {
    return await this.json<ChallengeDiscoveryJob>(`/api/challenge-discovery/${encodeURIComponent(challengeDiscoveryId)}/complete-human-verification`, {
      method: 'POST',
      body: JSON.stringify({ settle: true, allowNavigate: false }),
      signal,
    });
  }

  async cancelVerification(challengeDiscoveryId: string, signal?: AbortSignal): Promise<void> {
    await this.json(`/api/challenge-discovery/${encodeURIComponent(challengeDiscoveryId)}`, { method: 'DELETE', signal });
  }

}
