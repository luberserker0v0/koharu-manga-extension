import { describe, expect, it } from 'vitest';
import type { DetectionResult, PageImageCandidate } from '../lib/page-images/types';
import { candidateForStoredSourceImage, candidatesForStoredWorkflow, sourceImageMatchKey, sourcePageReferencesForWorkflow, workflowMappingComplete } from '../lib/page-images/workflow-mapping';
import type { StoredWorkflow } from '../lib/storage/workflow';

function candidate(pageId: string, sourceOrderIndex: number, sourceFingerprint?: string): PageImageCandidate {
  return {
    id: `crawler:${pageId}`,
    order: sourceOrderIndex,
    sourceUrl: `https://cdn.test/${pageId}.jpg`,
    fileName: `${pageId}.jpg`,
    width: null,
    height: null,
    origin: 'comic_crawler',
    loadStatus: 'loaded',
    selected: true,
    comicCrawler: {
      chapterId: 'chapter-1',
      pageId,
      sourceOrderIndex,
      ...(sourceFingerprint ? { sourceFingerprint } : {}),
    },
  };
}

function workflow(pages: StoredWorkflow['comicCrawler'] extends infer T
  ? T extends { pages?: infer P } ? P : never
  : never): StoredWorkflow {
  return {
    uploadId: 'upload-1',
    jobId: 'job-1',
    fileNames: ['b.jpg', 'a.jpg'],
    updatedAt: '2026-10-19T00:00:00.000Z',
    comicCrawler: {
      adapterId: 'reader',
      chapterUrl: 'https://reader.test/chapter',
      chapterId: 'chapter-1',
      pages: pages as NonNullable<StoredWorkflow['comicCrawler']>['pages'],
    },
  };
}

describe('stored ComicCrawler page mapping', () => {
  it('maps generic page images by the uploaded filename instead of current DOM order', () => {
    const first = { ...candidate('page-a', 0), comicCrawler: undefined, fileName: 'a.jpg', origin: 'dom' as const };
    const second = { ...candidate('page-b', 1), comicCrawler: undefined, fileName: 'b.jpg', origin: 'dom' as const };
    const saved: StoredWorkflow = {
      uploadId: 'upload-1', jobId: 'job-1', fileNames: ['b.jpg', 'a.jpg'], updatedAt: '2026-10-19T00:00:00.000Z',
      sourceImages: [
        { sourceImageId: 'source-b', uploadOrder: 0, fileName: 'b.jpg' },
        { sourceImageId: 'source-a', uploadOrder: 1, fileName: 'a.jpg' },
      ],
    };

    expect(candidatesForStoredWorkflow([first, second], saved).map((item) => item.fileName))
      .toEqual(['b.jpg', 'a.jpg']);
  });

  it('maps saved output order by stable page ID instead of current DOM order', () => {
    const current = [candidate('page-a', 0), candidate('page-b', 1)];
    const saved = workflow([
      { pageId: 'page-b', sourceOrderIndex: 1, uploadOrder: 0, fileName: 'b.jpg' },
      { pageId: 'page-a', sourceOrderIndex: 0, uploadOrder: 1, fileName: 'a.jpg' },
    ]);

    expect(candidatesForStoredWorkflow(current, saved).map((item) => item.comicCrawler?.pageId))
      .toEqual(['page-b', 'page-a']);
  });

  it('finds the original candidate using an authoritative source image ID', () => {
    const current = [candidate('page-a', 0), candidate('page-b', 1)];
    const saved = workflow([
      { pageId: 'page-b', sourceOrderIndex: 1, uploadOrder: 0, fileName: 'b.jpg', sourceImageId: 'source-b' },
      { pageId: 'page-a', sourceOrderIndex: 0, uploadOrder: 1, fileName: 'a.jpg', sourceImageId: 'source-a' },
    ]);

    expect(candidateForStoredSourceImage(current, saved, 'source-a')?.comicCrawler?.pageId).toBe('page-a');
  });

  it('keeps authoritative chapter page numbers for selective retranslation summaries', () => {
    const saved = workflow([
      { pageId: 'page-b', sourceOrderIndex: 7, uploadOrder: 0, fileName: '008.jpg', sourceImageId: 'source-b' },
      { pageId: 'page-a', sourceOrderIndex: 2, uploadOrder: 1, fileName: '003.jpg', sourceImageId: 'source-a' },
    ]);
    saved.sourceImages = [
      { sourceImageId: 'source-b', uploadOrder: 0, fileName: '008.jpg' },
      { sourceImageId: 'source-a', uploadOrder: 1, fileName: '003.jpg' },
    ];

    expect(sourcePageReferencesForWorkflow(saved)).toEqual([
      { sourceImageId: 'source-a', sourceOrderIndex: 2, sourceFileName: '003.jpg' },
      { sourceImageId: 'source-b', sourceOrderIndex: 7, sourceFileName: '008.jpg' },
    ]);
  });

  it('does not mistake a partial generic scan for a complete ComicCrawler chapter mapping', () => {
    const saved = workflow([
      { pageId: 'page-b', sourceOrderIndex: 1, uploadOrder: 0, fileName: 'b.jpg' },
      { pageId: 'page-a', sourceOrderIndex: 0, uploadOrder: 1, fileName: 'a.jpg' },
    ]);
    const partialDomResult: DetectionResult = {
      images: [{ ...candidate('visible-page', 0), comicCrawler: undefined, origin: 'dom' }],
      detector: 'dom',
      adapterStatus: 'matched',
      adapter: { id: 'reader' },
      warnings: [],
      discoveryAvailable: false,
    };
    const completeCrawlerResult: DetectionResult = {
      ...partialDomResult,
      images: [candidate('page-a', 0), candidate('page-b', 1)],
      detector: 'comic_crawler',
    };

    expect(workflowMappingComplete(partialDomResult, saved)).toBe(false);
    expect(workflowMappingComplete(completeCrawlerResult, saved)).toBe(true);
  });

  it('matches a passively loaded DOM image using the persisted stable source URL', () => {
    const saved = workflow([
      { pageId: 'page-a', sourceOrderIndex: 0, uploadOrder: 0, fileName: 'a.jpg', sourceUrl: 'https://old-cdn.test/books/1/a.jpg?token=old' },
      { pageId: 'page-b', sourceOrderIndex: 1, uploadOrder: 1, fileName: 'b.jpg', sourceUrl: 'https://old-cdn.test/books/1/b.jpg?expires=1' },
    ]);
    saved.fileNames = ['a.jpg', 'b.jpg'];
    const current = [
      { ...candidate('unrelated-a', 0), comicCrawler: undefined, origin: 'dom' as const, sourceUrl: 'https://new-cdn.test/books/1/a.jpg?token=renewed' },
      { ...candidate('unrelated-b', 1), comicCrawler: undefined, origin: 'dom' as const, sourceUrl: 'https://new-cdn.test/books/1/b.jpg?expires=999' },
    ];

    expect(candidatesForStoredWorkflow(current, saved)).toEqual(current);
    expect(sourceImageMatchKey(current[0]!.sourceUrl)).toBe('/books/1/a.jpg');
  });

  it('refuses to apply an older translation when a source fingerprint changed', () => {
    const current = [candidate('page-a', 0, 'etag:new')];
    const saved = workflow([
      { pageId: 'page-a', sourceOrderIndex: 0, uploadOrder: 0, fileName: 'a.jpg', sourceFingerprint: 'etag:old' },
    ]);

    expect(() => candidatesForStoredWorkflow(current, saved)).toThrow('source_page_changed');
  });

  it('refuses partial application when a saved page is no longer present', () => {
    const saved = workflow([
      { pageId: 'page-missing', sourceOrderIndex: 0, uploadOrder: 0, fileName: 'missing.jpg' },
    ]);

    expect(() => candidatesForStoredWorkflow([], saved)).toThrow('source_page_mapping_incomplete');
  });
});
