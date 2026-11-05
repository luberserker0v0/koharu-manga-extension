import { describe, expect, it } from 'vitest';
import type { JobResource, TextRegionSnapshot } from '../lib/api/types';
import {
  buildChapterOcrCorrections,
  chapterOcrTargetsForPage,
  type StoredChapterOcrReviewJob,
} from '../lib/text-regions/chapter-ocr-batch';
import { textRegionDraftKey } from '../lib/text-regions/corrections';
import type { StoredTextRegionWorkspace } from '../lib/text-regions/workspace';

const snapshot: TextRegionSnapshot = {
  jobId: 'job-1',
  rootJobId: 'job-1',
  snapshotFingerprint: 'snapshot-1',
  pages: [{
    sourceImageId: 'source-1',
    sourceOrderIndex: 0,
    sourceFileName: '001.png',
    pageRevisionId: 'page-revision-1',
    regionSetRevisionId: 'region-set-1',
    coordinateSpace: { kind: 'source_image_pixels', origin: 'top_left', width: 1000, height: 1500, rotationUnit: 'degrees_clockwise' },
    regions: [
      { id: 'region-1', readingOrder: 0, geometry: { x: 10, y: 20, width: 100, height: 80, rotation: 0 }, sourceText: 'WR0NG', translatedText: '錯誤' },
      { id: 'region-2', readingOrder: 1, geometry: { x: 30, y: 120, width: 140, height: 90, rotation: 0 }, sourceText: 'MANUAL', translatedText: '手動' },
    ],
  }],
};

function workspace(): StoredTextRegionWorkspace {
  return {
    baseJobId: 'job-1',
    drafts: [[textRegionDraftKey('source-1', 'region-2'), {
      sourceText: 'MANUALLY FIXED',
      geometry: { x: 30, y: 120, width: 140, height: 90, rotation: 0 },
    }]],
    createdDrafts: [],
    deletedRegionKeys: [],
    reviewDrafts: [],
    instructions: '',
    updatedAt: '2026-11-04T00:00:00.000Z',
  };
}

function completedReview(items: Array<Record<string, unknown>>): JobResource {
  return {
    id: 'review-1',
    type: 'ocr_text_review',
    status: 'succeeded',
    stage: 'succeeded',
    result: { uploadId: 'upload-1', sourceLanguages: ['en'], summary: {}, items },
    error: null,
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:01:00.000Z',
  };
}

describe('whole-chapter OCR batch', () => {
  it('reviews untouched OCR while preserving manually corrected text', () => {
    const targets = chapterOcrTargetsForPage(snapshot.pages[0]!, workspace());

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ regionId: 'region-1', originalText: 'WR0NG' });
  });

  it('adopts successful AI text and combines it with existing manual drafts in one correction request', () => {
    const target = chapterOcrTargetsForPage(snapshot.pages[0]!, workspace())[0]!;
    const reviewJobs: StoredChapterOcrReviewJob[] = [{
      jobId: 'review-1', sourceImageIds: ['source-1'], targets: [{
        clientItemId: target.clientItemId,
        sourceImageId: target.sourceImageId,
        regionId: target.regionId,
        targetKind: target.targetKind,
        originalText: target.originalText,
      }],
    }];
    const result = buildChapterOcrCorrections(snapshot, workspace(), reviewJobs, [completedReview([{
      clientItemId: target.clientItemId,
      originalText: 'WR0NG',
      correctedText: 'WRONG',
      changed: true,
      status: 'succeeded',
    }])]);

    expect(result.pages).toEqual([{
      sourceImageId: 'source-1',
      baseRegionSetRevisionId: 'region-set-1',
      operations: [
        { type: 'update', regionId: 'region-1', sourceText: 'WRONG' },
        { type: 'update', regionId: 'region-2', sourceText: 'MANUALLY FIXED' },
      ],
    }]);
    expect(result.summary).toEqual({
      reviewedRegions: 1,
      succeededRegions: 1,
      failedRegions: 0,
      changedRegions: 1,
      correctionPages: 1,
      unchangedPages: 0,
      failedWithoutRetranslationPages: 0,
      partialFailurePages: 0,
      retranslatedPageNumbers: [1],
      unchangedPageNumbers: [],
      failedPageNumbers: [],
      partialFailurePageNumbers: [],
    });
  });

  it('counts a failed review item without fabricating a correction', () => {
    const target = chapterOcrTargetsForPage(snapshot.pages[0]!, undefined)[0]!;
    const reviewJobs: StoredChapterOcrReviewJob[] = [{
      jobId: 'review-1', sourceImageIds: ['source-1'], targets: [{
        clientItemId: target.clientItemId,
        sourceImageId: target.sourceImageId,
        regionId: target.regionId,
        targetKind: target.targetKind,
        originalText: target.originalText,
      }],
    }];
    const result = buildChapterOcrCorrections(snapshot, undefined, reviewJobs, [completedReview([{
      clientItemId: target.clientItemId,
      originalText: 'WR0NG',
      correctedText: 'WR0NG',
      changed: false,
      status: 'failed',
      error: 'vision failed',
    }])]);

    expect(result.pages).toEqual([]);
    expect(result.summary.failedRegions).toBe(1);
    expect(result.summary.failedWithoutRetranslationPages).toBe(1);
    expect(result.summary.failedPageNumbers).toEqual([1]);
  });

  it('explains OCR pages that need no retranslation because every suggestion is unchanged', () => {
    const targets = chapterOcrTargetsForPage(snapshot.pages[0]!, undefined);
    const reviewJobs: StoredChapterOcrReviewJob[] = [{
      jobId: 'review-1', sourceImageIds: ['source-1'], targets: targets.map((target) => ({
        clientItemId: target.clientItemId,
        sourceImageId: target.sourceImageId,
        regionId: target.regionId,
        targetKind: target.targetKind,
        originalText: target.originalText,
      })),
    }];
    const result = buildChapterOcrCorrections(snapshot, undefined, reviewJobs, [completedReview(targets.map((target) => ({
      clientItemId: target.clientItemId,
      originalText: target.originalText,
      correctedText: target.originalText,
      changed: false,
      status: 'succeeded',
    })))]);

    expect(result.pages).toEqual([]);
    expect(result.summary.unchangedPages).toBe(1);
    expect(result.summary.unchangedPageNumbers).toEqual([1]);
    expect(result.summary.failedWithoutRetranslationPages).toBe(0);
  });

  it('separates partial AI failures from pages that could not be retranslated', () => {
    const targets = chapterOcrTargetsForPage(snapshot.pages[0]!, undefined);
    const reviewJobs: StoredChapterOcrReviewJob[] = [{
      jobId: 'review-1', sourceImageIds: ['source-1'], targets: targets.map((target) => ({
        clientItemId: target.clientItemId,
        sourceImageId: target.sourceImageId,
        regionId: target.regionId,
        targetKind: target.targetKind,
        originalText: target.originalText,
      })),
    }];
    const result = buildChapterOcrCorrections(snapshot, undefined, reviewJobs, [completedReview([
      {
        clientItemId: targets[0]!.clientItemId,
        originalText: targets[0]!.originalText,
        correctedText: 'WRONG', changed: true, status: 'succeeded',
      },
      {
        clientItemId: targets[1]!.clientItemId,
        originalText: targets[1]!.originalText,
        correctedText: targets[1]!.originalText, changed: false, status: 'failed',
      },
    ])]);

    expect(result.summary.correctionPages).toBe(1);
    expect(result.summary.partialFailurePages).toBe(1);
    expect(result.summary.partialFailurePageNumbers).toEqual([1]);
    expect(result.summary.failedWithoutRetranslationPages).toBe(0);
  });
});
