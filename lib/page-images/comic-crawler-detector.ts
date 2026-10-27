import { ComicCrawlerClient } from '../comic-crawler/client';
import { ComicCrawlerError, safeCrawlerError } from '../comic-crawler/errors';
import type { DetectionOptions, DetectionResult, ImageDetector, PageImageCandidate } from './types';

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number | undefined, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!timeoutMs || timeoutMs <= 0) return operation;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    const timer = setTimeout(() => finish(() => reject(
      new ComicCrawlerError('ComicCrawler image detection timed out.', 'unavailable', undefined, 'timeout'),
    )), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function imageFileName(url: string, order: number): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    if (/\.(?:avif|bmp|gif|hei[cf]|jpe?g|png|tiff?|webp)$/i.test(name)) return name;
  } catch { /* synthesize below */ }
  return `page-${String(order + 1).padStart(3, '0')}.jpg`;
}

export class ComicCrawlerDetector implements ImageDetector {
  constructor(readonly client: ComicCrawlerClient) {}

  async detect(url: string, options: DetectionOptions = {}): Promise<DetectionResult> {
    try {
      return await withDeadline((async () => {
        if (!await this.client.status(options.signal)) throw new ComicCrawlerError('ComicCrawler is not ready.', 'unavailable');
        const adapter = await this.client.resolveAdapter(url, options.signal);
        if (adapter.status !== 'matched') {
          return { images: [], detector: 'comic_crawler', adapter: adapter.adapter, adapterStatus: adapter.status, warnings: [], discoveryAvailable: true } satisfies DetectionResult;
        }
        if (options.resolveOnly) {
          return {
            images: [],
            detector: 'comic_crawler',
            adapter: adapter.adapter,
            adapterStatus: 'matched',
            warnings: [],
            discoveryAvailable: false,
          } satisfies DetectionResult;
        }
        const result = await this.client.extractChapterImages(url, {
          signal: options.signal,
          renderContext: options.renderContext,
        });
        const orderedImages = result.images.map((descriptor) => {
          const rawUrl = descriptor.url;
          let parsed: URL;
          try { parsed = new URL(rawUrl); }
          catch { throw new ComicCrawlerError('ComicCrawler returned an invalid image URL.', 'contract'); }
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new ComicCrawlerError('ComicCrawler returned an unsupported image URL.', 'contract');
          parsed.hash = '';
          const sourceUrl = parsed.toString();
          return { descriptor, sourceUrl };
        });
        const images: PageImageCandidate[] = orderedImages.map(({ descriptor, sourceUrl }, order) => ({
          id: `crawler:${descriptor.id}`,
          order,
          sourceUrl,
          fileName: imageFileName(sourceUrl, order),
          width: null,
          height: null,
          origin: 'comic_crawler',
          loadStatus: 'loaded',
          comicCrawler: {
            chapterId: result.chapter.id,
            pageId: descriptor.id,
            sourceOrderIndex: descriptor.orderIndex,
            ...(descriptor.sourceFingerprint ? { sourceFingerprint: descriptor.sourceFingerprint } : {}),
          },
          selected: true,
        }));
        return {
          images,
          detector: 'comic_crawler',
          adapter: adapter.adapter ?? { id: result.adapterId },
          adapterStatus: 'matched',
          chapterUrl: result.chapterUrl,
          chapterIdentity: result.chapter,
          warnings: [],
          discoveryAvailable: false,
        } satisfies DetectionResult;
      })(), options.timeoutMs, options.signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      return { images: [], detector: 'comic_crawler', warnings: [safeCrawlerError(error)], discoveryAvailable: false };
    }
  }
}
