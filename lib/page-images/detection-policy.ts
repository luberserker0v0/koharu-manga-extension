export const CRAWLER_RESOLVE_TIMEOUT_MS = 5_000;

/**
 * Adapter resolution is a short capability check. Full chapter extraction is
 * governed by ComicCrawler's reader boundary, command timeout, and caller
 * cancellation; the extension must not race it with a second wall-clock limit.
 */
export function comicCrawlerDetectionTimeout(deep: boolean): number | undefined {
  return deep ? undefined : CRAWLER_RESOLVE_TIMEOUT_MS;
}
