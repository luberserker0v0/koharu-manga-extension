import type { ChapterImagesVerificationData } from './types';

export class ComicCrawlerError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'api' | 'contract' | 'unavailable',
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ComicCrawlerError';
  }
}

export class ChapterImagesVerificationRequiredError extends ComicCrawlerError {
  constructor(
    message: string,
    readonly verification: ChapterImagesVerificationData,
  ) {
    super(message, 'api', 409, 'CHAPTER_IMAGES_VERIFICATION_REQUIRED');
    this.name = 'ChapterImagesVerificationRequiredError';
  }
}

export function safeCrawlerError(error: unknown): string {
  if (error instanceof ChapterImagesVerificationRequiredError) return 'comicCrawler_verification_required';
  if (error instanceof Error) {
    if (/^(?:Error:\s*)?comicCrawler_browser_target_required$/.test(error.message)
      || /browser (?:resource|worker).*(?:not found|not registered|offline|disconnect)/i.test(error.message)) {
      return 'comicCrawler_browser_target_required';
    }
    if ((error instanceof ComicCrawlerError && error.code === 'timeout') || /tim(?:ed|e)[ -]?out/i.test(error.message)) {
      return 'comicCrawler_timeout';
    }
    if (/(?:challenge|verification).*(?:required|waiting)|(?:required|waiting).*(?:challenge|verification)/i.test(error.message)) {
      return 'comicCrawler_verification_required';
    }
  }
  if (error instanceof ComicCrawlerError) return `comicCrawler_${error.kind}`;
  return 'comicCrawler_unavailable';
}
