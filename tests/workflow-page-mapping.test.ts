import { describe, expect, it } from 'vitest';
import type { PageImageCandidate } from '../lib/page-images/types';
import { candidatesForStoredWorkflow } from '../lib/page-images/workflow-mapping';
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
