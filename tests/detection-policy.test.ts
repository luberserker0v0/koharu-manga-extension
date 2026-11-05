import { describe, expect, it } from 'vitest';
import {
  CRAWLER_RESOLVE_TIMEOUT_MS,
  comicCrawlerDetectionTimeout,
} from '../lib/page-images/detection-policy';

describe('ComicCrawler detection timeout policy', () => {
  it('uses a short deadline only for adapter resolution', () => {
    expect(comicCrawlerDetectionTimeout(false)).toBe(CRAWLER_RESOLVE_TIMEOUT_MS);
  });

  it('lets ComicCrawler own full chapter extraction completion', () => {
    expect(comicCrawlerDetectionTimeout(true)).toBeUndefined();
  });
});
