import { describe, expect, it } from 'vitest';
import { ComicCrawlerError, safeCrawlerError } from '../lib/comic-crawler/errors';

describe('ComicCrawler error normalization', () => {
  it('distinguishes a server browser-command timeout from an extension deadline', () => {
    expect(safeCrawlerError(new ComicCrawlerError(
      'Browser command "page.prepare.step" timed out.',
      'api',
      422,
    ))).toBe('comicCrawler_browser_timeout');

    expect(safeCrawlerError(new ComicCrawlerError(
      'Reader preparation stopped making progress.',
      'api',
      422,
    ))).toBe('comicCrawler_browser_timeout');

    expect(safeCrawlerError(new ComicCrawlerError(
      'ComicCrawler image detection timed out.',
      'unavailable',
      undefined,
      'timeout',
    ))).toBe('comicCrawler_timeout');
  });

  it('preserves actionable Browser Client connection failures', () => {
    expect(safeCrawlerError(new Error(
      'ComicCrawler returned an unsupported Browser Client protocol.',
    ))).toBe('comicCrawler_browser_protocol');
    expect(safeCrawlerError(new Error(
      'Browser Client credential is invalid.',
    ))).toBe('comicCrawler_browser_enrollment');
    expect(safeCrawlerError(new Error(
      'Browser Client WebSocket failed to open.',
    ))).toBe('comicCrawler_browser_connection');
  });
});
