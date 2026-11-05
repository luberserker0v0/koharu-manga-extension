import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranslationWorkflow } from '../hooks/useTranslationWorkflow';
import type { BackendClient } from '../lib/api/backend-client';
import type { JobResource } from '../lib/api/types';
import type { StoredWorkflow } from '../lib/storage/workflow';
import { emptyChapterOcrBatchSummary } from '../lib/text-regions/chapter-ocr-batch';

const values: Record<string, unknown> = {};

function job(id: string, status: string, revision?: JobResource['revision']): JobResource {
  return {
    id,
    type: 'translation',
    status,
    stage: status,
    result: status === 'succeeded' ? {} : null,
    error: null,
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:01:00.000Z',
    revision,
  };
}

beforeEach(() => {
  for (const key of Object.keys(values)) delete values[key];
  values.currentWorkflow = {
    uploadId: 'upload-1',
    jobId: 'job-parent',
    fileNames: ['001.png', '002.png'],
    updatedAt: '2026-11-04T00:00:00.000Z',
  } satisfies StoredWorkflow;
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[]) => Array.isArray(key)
          ? Object.fromEntries(key.map((item) => [item, values[item]]))
          : ({ [key]: values[key] })),
        set: vi.fn(async (entries: Record<string, unknown>) => { Object.assign(values, entries); }),
        remove: vi.fn(async (key: string) => { delete values[key]; }),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('background revision workflow', () => {
  it('keeps the current completed job available while a page revision is queued, then promotes the successful child', async () => {
    const client = {} as BackendClient;
    const { result } = renderHook(() => useTranslationWorkflow(client));
    await waitFor(() => expect(result.current.workflow?.jobId).toBe('job-parent'));

    await act(async () => {
      await result.current.addBackgroundJob(job('job-child', 'queued'), 'text_region_correction', ['source-2']);
    });
    expect(result.current.workflow?.jobId).toBe('job-parent');
    expect(result.current.workflow?.backgroundTasks).toEqual([
      expect.objectContaining({ jobId: 'job-child', status: 'queued', sourceImageIds: ['source-2'] }),
    ]);

    await act(async () => {
      await result.current.reconcileBackgroundJob(job('job-child', 'succeeded', {
        rootJobId: 'job-parent',
        parentJobId: 'job-parent',
        reason: 'text_region_correction',
        sourceImageIds: ['source-2'],
      }));
    });

    expect(result.current.workflow?.jobId).toBe('job-child');
    expect(result.current.workflow?.rootJobId).toBe('job-parent');
    expect(result.current.workflow?.backgroundTasks?.[0]).toMatchObject({
      jobId: 'job-child',
      status: 'succeeded',
    });
    expect(result.current.workflow?.backgroundTasks?.[0]?.reconciledAt).toBeTruthy();
    expect((values.currentWorkflow as StoredWorkflow).jobId).toBe('job-child');
  });

  it('persists AI review completion without replacing the translated job', async () => {
    const { result } = renderHook(() => useTranslationWorkflow({} as BackendClient));
    await waitFor(() => expect(result.current.workflow?.jobId).toBe('job-parent'));

    await act(async () => {
      await result.current.addBackgroundJob(job('review-job', 'queued'), 'ocr_text_review', ['source-1']);
      await result.current.reconcileBackgroundJob(job('review-job', 'succeeded'));
    });

    expect(result.current.workflow?.jobId).toBe('job-parent');
    expect(result.current.workflow?.backgroundTasks?.[0]).toMatchObject({
      jobId: 'review-job',
      status: 'succeeded',
      kind: 'ocr_text_review',
    });
  });

  it('marks a persisted whole-chapter batch complete when its correction child succeeds', async () => {
    const { result } = renderHook(() => useTranslationWorkflow({} as BackendClient));
    await waitFor(() => expect(result.current.workflow?.jobId).toBe('job-parent'));
    await act(async () => {
      await result.current.saveChapterOcrBatch({
        id: 'batch-1',
        baseJobId: 'job-parent',
        status: 'translating',
        processedSourceImageIds: ['source-1'],
        reviewJobs: [],
        sourceImageIds: ['source-1'],
        summary: emptyChapterOcrBatchSummary(),
        correctionJobId: 'job-batch-correction',
        createdAt: '2026-11-04T00:00:00.000Z',
        updatedAt: '2026-11-04T00:01:00.000Z',
      });
      await result.current.addBackgroundJob(job('job-batch-correction', 'queued'), 'text_region_correction', ['source-1']);
      await result.current.reconcileBackgroundJob(job('job-batch-correction', 'succeeded', {
        rootJobId: 'job-parent', parentJobId: 'job-parent', reason: 'text_region_correction', sourceImageIds: ['source-1'],
      }));
    });

    expect(result.current.workflow?.jobId).toBe('job-batch-correction');
    expect(result.current.workflow?.chapterOcrBatch).toMatchObject({
      id: 'batch-1', status: 'succeeded', correctionJobId: 'job-batch-correction', error: null,
    });
  });
});
