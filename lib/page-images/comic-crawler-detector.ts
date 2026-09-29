import { ComicCrawlerClient } from '../comic-crawler/client';
import { ComicCrawlerError, safeCrawlerError } from '../comic-crawler/errors';
import type { DetectionOptions, DetectionResult, ImageDetector, PageImageCandidate } from './types';

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
      if (!await this.client.status(options.signal)) throw new ComicCrawlerError('ComicCrawler is not ready.', 'unavailable');
      const adapter = await this.client.resolveAdapter(url, options.signal);
      if (adapter.status !== 'matched') {
        return { images: [], detector: 'comic_crawler', adapter: adapter.adapter, adapterStatus: adapter.status, warnings: [], discoveryAvailable: true };
      }
      const result = await this.client.extractChapterImages(url, options.signal);
      const seen = new Set<string>();
      const orderedUrls = result.imageUrls.flatMap((rawUrl) => {
        let parsed: URL;
        try { parsed = new URL(rawUrl); }
        catch { throw new ComicCrawlerError('ComicCrawler returned an invalid image URL.', 'contract'); }
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new ComicCrawlerError('ComicCrawler returned an unsupported image URL.', 'contract');
        parsed.hash = '';
        const sourceUrl = parsed.toString();
        if (seen.has(sourceUrl)) return [];
        seen.add(sourceUrl);
        return [sourceUrl];
      });
      const images: PageImageCandidate[] = orderedUrls.map((sourceUrl, order) => ({
          id: `crawler-${result.adapterId}-${order}`,
          order,
          sourceUrl,
          fileName: imageFileName(sourceUrl, order),
          width: null,
          height: null,
          origin: 'comic_crawler',
          loadStatus: 'loaded',
          selected: true,
        }));
      return {
        images,
        detector: 'comic_crawler',
        adapter: adapter.adapter ?? { id: result.adapterId },
        adapterStatus: 'matched',
        chapterUrl: result.chapterUrl,
        warnings: [],
        discoveryAvailable: false,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      return { images: [], detector: 'comic_crawler', warnings: [safeCrawlerError(error)], discoveryAvailable: false };
    }
  }
}
