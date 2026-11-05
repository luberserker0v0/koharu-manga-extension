import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useChapterOcrBatch } from '../hooks/useChapterOcrBatch';
import type { BackendClient } from '../lib/api/backend-client';
import type { JobResource, TextRegionSnapshot } from '../lib/api/types';
import type { StoredChapterOcrBatch } from '../lib/text-regions/chapter-ocr-batch';
import type { StoredBackgroundTask } from '../lib/text-regions/workspace';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const snapshot: TextRegionSnapshot = {
  jobId: 'job-parent', rootJobId: 'job-parent', snapshotFingerprint: 'snapshot-1',
  pages: [{
    sourceImageId: 'source-1', sourceOrderIndex: 0, sourceFileName: '001.png',
    pageRevisionId: 'revision-1', regionSetRevisionId: 'set-1',
    coordinateSpace: { kind: 'source_image_pixels', origin: 'top_left', width: 1000, height: 1500, rotationUnit: 'degrees_clockwise' },
    regions: [{
      id: 'region-1', readingOrder: 0,
      geometry: { x: 10, y: 20, width: 100, height: 80, rotation: 0 },
      sourceText: 'WR0NG', translatedText: '錯誤',
    }],
  }],
};

function job(overrides: Partial<JobResource>): JobResource {
  return {
    id: 'job-parent', type: 'translation', status: 'succeeded', stage: 'succeeded',
    result: {}, error: null, payload: { sourceLanguage: ['en'] },
    createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:01:00.000Z',
    ...overrides,
  };
}

describe('useChapterOcrBatch', () => {
  it('reviews every OCR page and submits the adopted text as one correction Job', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1000, height: 1500, close: vi.fn() }));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) {}
      getContext() { return { drawImage: vi.fn() }; }
      convertToBlob() { return Promise.resolve(new Blob(['crop'], { type: 'image/png' })); }
    });
    const reviewJob = job({ id: 'review-1', type: 'ocr_text_review', status: 'queued', stage: 'queued', result: null });
    const completedReview = job({
      id: 'review-1', type: 'ocr_text_review', result: {
        uploadId: 'upload-review', sourceLanguages: ['en'],
        summary: { total: 1, succeededCount: 1, failedCount: 0, changedCount: 1 },
        items: [{
          clientItemId: JSON.stringify(['source-1', 'existing', 'region-1']),
          originalText: 'WR0NG', correctedText: 'WRONG', changed: true, status: 'succeeded',
        }],
      },
    });
    const correctionJob = job({ id: 'correction-1', status: 'queued', stage: 'queued', result: null });
    const client = {
      getTextRegions: vi.fn().mockResolvedValue(snapshot),
      getJob: vi.fn(async (jobId: string) => jobId === 'review-1' ? completedReview : job({ id: jobId })),
      createUpload: vi.fn().mockResolvedValue({ uploadId: 'upload-review' }),
      uploadFiles: vi.fn().mockResolvedValue(undefined),
      completeUpload: vi.fn().mockResolvedValue(undefined),
      createOcrTextReviewJob: vi.fn().mockResolvedValue(reviewJob),
      createTextRegionCorrection: vi.fn().mockResolvedValue(correctionJob),
      deleteUpload: vi.fn().mockResolvedValue(undefined),
      cancelJob: vi.fn().mockResolvedValue(undefined),
    } as unknown as BackendClient;

    const { result } = renderHook(() => {
      const [batch, setBatch] = useState<StoredChapterOcrBatch>();
      const [tasks, setTasks] = useState<StoredBackgroundTask[]>([]);
      const automation = useChapterOcrBatch({
        client, jobId: 'job-parent', batch, backgroundTasks: tasks,
        loadOriginalImage: async () => new Blob(['page'], { type: 'image/png' }),
        onBatchChange: (next) => setBatch(next ?? undefined),
        onBackgroundJob: (nextJob, kind, sourceImageIds) => setTasks((current) => [
          ...current.filter((task) => task.jobId !== nextJob.id),
          {
            jobId: nextJob.id,
            kind,
            sourceImageIds,
            status: kind === 'ocr_text_review' ? 'succeeded' : nextJob.status,
            stage: kind === 'ocr_text_review' ? 'succeeded' : nextJob.stage,
            createdAt: nextJob.createdAt,
            updatedAt: nextJob.updatedAt,
            error: null,
          },
        ]),
      });
      return { automation, batch, tasks };
    });

    await waitFor(() => expect(result.current.automation.snapshot).toEqual(snapshot));
    await act(async () => { await result.current.automation.start(); });
    await waitFor(() => expect(client.createTextRegionCorrection).toHaveBeenCalledTimes(1));

    expect(client.createTextRegionCorrection).toHaveBeenCalledWith('job-parent', {
      pages: [{
        sourceImageId: 'source-1', baseRegionSetRevisionId: 'set-1',
        operations: [{ type: 'update', regionId: 'region-1', sourceText: 'WRONG' }],
      }],
    });
    expect(result.current.batch).toMatchObject({
      status: 'translating', correctionJobId: 'correction-1',
      summary: { succeededRegions: 1, changedRegions: 1, correctionPages: 1 },
    });
  });
});
