export class ComicCrawlerError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'api' | 'contract' | 'unavailable',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ComicCrawlerError';
  }
}

export function safeCrawlerError(error: unknown): string {
  if (error instanceof ComicCrawlerError) return `comicCrawler_${error.kind}`;
  return 'comicCrawler_unavailable';
}
