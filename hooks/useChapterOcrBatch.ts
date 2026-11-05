import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BackendClient } from '../lib/api/backend-client';
import { isAbortError } from '../lib/api/errors';
import type { JobResource, TextRegionSnapshot } from '../lib/api/types';
import { isTerminalJobStatus } from '../lib/domain/job-state';
import {
  buildChapterOcrCorrections,
  chapterOcrBatchIsActive,
  chapterOcrTargetsForPage,
  emptyChapterOcrBatchSummary,
  OCR_REVIEW_BATCH_LIMIT,
  type StoredChapterOcrBatch,
  type StoredChapterOcrReviewJob,
} from '../lib/text-regions/chapter-ocr-batch';
import { createOcrReviewCrops, sourceLanguagesFromJob } from '../lib/text-regions/ocr-review';
import type { StoredBackgroundTask, StoredTextRegionWorkspace } from '../lib/text-regions/workspace';

export interface ChapterOcrBatchProgress {
  phase: 'preparing' | 'reviewing' | 'submitting' | 'translating';
  completed: number;
  total: number;
  percent: number;
}

interface UseChapterOcrBatchOptions {
  client: BackendClient;
  jobId: string;
  batch?: StoredChapterOcrBatch;
  workspace?: StoredTextRegionWorkspace;
  backgroundTasks: StoredBackgroundTask[];
  loadOriginalImage?: (sourceImageId: string, signal?: AbortSignal) => Promise<Blob>;
  onBatchChange: (batch: StoredChapterOcrBatch | null) => void | Promise<void>;
  onBackgroundJob: (
    job: JobResource,
    kind: 'ocr_text_review' | 'text_region_correction',
    sourceImageIds: string[],
  ) => void | Promise<void>;
}

function chunks<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): string { return new Date().toISOString(); }

function batchId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `chapter-ocr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function useChapterOcrBatch({
  client,
  jobId,
  batch,
  workspace,
  backgroundTasks,
  loadOriginalImage,
  onBatchChange,
  onBackgroundJob,
}: UseChapterOcrBatchOptions) {
  const [snapshot, setSnapshot] = useState<TextRegionSnapshot | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<unknown>(null);
  const [operationError, setOperationError] = useState<unknown>(null);
  const [progress, setProgress] = useState<ChapterOcrBatchProgress | null>(null);
  const preparation = useRef<AbortController | null>(null);
  const finalizing = useRef(false);
  const callbackRef = useRef({ onBatchChange, onBackgroundJob, loadOriginalImage, workspace });
  callbackRef.current = { onBatchChange, onBackgroundJob, loadOriginalImage, workspace };

  const persist = useCallback(async (next: StoredChapterOcrBatch) => {
    await callbackRef.current.onBatchChange(next);
    return next;
  }, []);

  const loadSnapshot = useCallback(async (targetJobId = jobId, signal?: AbortSignal) => {
    setLoadingSnapshot(true);
    setAvailabilityError(null);
    try {
      const next = await client.getTextRegions(targetJobId, undefined, signal);
      setSnapshot(next);
      return next;
    } catch (error) {
      if (!isAbortError(error)) setAvailabilityError(error);
      throw error;
    } finally {
      if (!signal?.aborted) setLoadingSnapshot(false);
    }
  }, [client, jobId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadSnapshot(jobId, controller.signal).catch(() => {});
    return () => controller.abort();
  }, [jobId, loadSnapshot]);

  const start = useCallback(async () => {
    if (!loadOriginalImage || chapterOcrBatchIsActive(batch)) return;
    const createdAt = now();
    setOperationError(null);
    setProgress({ phase: 'preparing', completed: 0, total: snapshot?.pages.length ?? 0, percent: 0 });
    await persist({
      id: batchId(),
      baseJobId: jobId,
      status: 'preparing',
      processedSourceImageIds: [],
      reviewJobs: [],
      sourceImageIds: [],
      summary: emptyChapterOcrBatchSummary(),
      error: null,
      createdAt,
      updatedAt: createdAt,
    });
  }, [batch, jobId, loadOriginalImage, persist, snapshot?.pages.length]);

  useEffect(() => {
    if (!batch || batch.status !== 'preparing' || preparation.current) return;
    const controller = new AbortController();
    preparation.current = controller;
    void (async () => {
      let working = batch;
      let abandonedUploadId = '';
      const save = async (update: Partial<StoredChapterOcrBatch>) => {
        working = await persist({ ...working, ...update, updatedAt: now() });
      };
      try {
        const originalLoader = callbackRef.current.loadOriginalImage;
        if (!originalLoader) throw new Error('ocr_review_original_image_unavailable');
        const [nextSnapshot, sourceJob] = await Promise.all([
          client.getTextRegions(working.baseJobId, undefined, controller.signal),
          client.getJob(working.baseJobId, controller.signal),
        ]);
        setSnapshot(nextSnapshot);
        const workspaceValue = callbackRef.current.workspace;
        const eligiblePages = nextSnapshot.pages.filter((page) => page.regions.length > 0
          || (workspaceValue?.createdDrafts ?? []).some(([, draft]) => draft.sourceImageId === page.sourceImageId));
        const totalRegions = eligiblePages.reduce((sum, page) => sum + chapterOcrTargetsForPage(page, workspaceValue).length, 0);
        await save({
          sourceImageIds: eligiblePages.map((page) => page.sourceImageId),
          summary: {
            ...emptyChapterOcrBatchSummary(),
            ...working.summary,
            totalChapterPages: nextSnapshot.pages.length,
            totalPages: nextSnapshot.pages.filter((page) => page.regions.length > 0).length,
            totalRegions,
          },
        });

        for (let pageIndex = 0; pageIndex < eligiblePages.length; pageIndex += 1) {
          if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const page = eligiblePages[pageIndex]!;
          if (working.processedSourceImageIds.includes(page.sourceImageId)) continue;
          const scheduled = new Set(working.reviewJobs.flatMap((item) => item.targets.map((target) => target.clientItemId)));
          const targets = chapterOcrTargetsForPage(page, workspaceValue)
            .filter((target) => !scheduled.has(target.clientItemId));
          setProgress({
            phase: 'preparing',
            completed: pageIndex,
            total: eligiblePages.length,
            percent: eligiblePages.length ? Math.round(pageIndex / eligiblePages.length * 100) : 100,
          });
          if (targets.length > 0) {
            const image = await originalLoader(page.sourceImageId, controller.signal);
            for (const targetChunk of chunks(targets, OCR_REVIEW_BATCH_LIMIT)) {
              const crops = await createOcrReviewCrops(image, page, targetChunk);
              const upload = await client.createUpload(controller.signal, 'ocr_review');
              abandonedUploadId = upload.uploadId;
              await client.uploadFiles(upload.uploadId, crops.map((item) => item.file), () => {}, controller.signal);
              await client.completeUpload(upload.uploadId, controller.signal);
              const reviewJob = await client.createOcrTextReviewJob({
                uploadId: upload.uploadId,
                sourceLanguages: sourceLanguagesFromJob(sourceJob),
                items: crops.map((item) => item.request),
              }, controller.signal);
              abandonedUploadId = '';
              const storedJob: StoredChapterOcrReviewJob = {
                jobId: reviewJob.id,
                sourceImageIds: [page.sourceImageId],
                targets: targetChunk.map((target) => ({
                  clientItemId: target.clientItemId,
                  sourceImageId: target.sourceImageId,
                  regionId: target.regionId,
                  targetKind: target.targetKind,
                  originalText: target.originalText,
                })),
              };
              await save({ reviewJobs: [...working.reviewJobs, storedJob] });
              await callbackRef.current.onBackgroundJob(reviewJob, 'ocr_text_review', [page.sourceImageId]);
            }
          }
          await save({ processedSourceImageIds: [...working.processedSourceImageIds, page.sourceImageId] });
        }
        await save({ status: 'reviewing', error: null });
        setProgress({ phase: 'reviewing', completed: 0, total: working.summary.totalRegions, percent: 0 });
      } catch (error) {
        if (abandonedUploadId) void client.deleteUpload(abandonedUploadId).catch(() => {});
        if (!isAbortError(error)) {
          setOperationError(error);
          await save({ status: 'failed', error: errorMessage(error) });
        }
      } finally {
        if (preparation.current === controller) preparation.current = null;
      }
    })();
    return () => controller.abort();
  }, [batch?.id, batch?.status, client, persist]);

  const taskById = useMemo(() => new Map(backgroundTasks.map((task) => [task.jobId, task])), [backgroundTasks]);
  const reviewStateKey = batch?.reviewJobs.map((item) => `${item.jobId}:${taskById.get(item.jobId)?.status ?? 'missing'}`).join('|') ?? '';

  useEffect(() => {
    if (!batch) return;
    for (const reviewJob of batch.reviewJobs) {
      if (taskById.has(reviewJob.jobId)) continue;
      void client.getJob(reviewJob.jobId)
        .then((job) => callbackRef.current.onBackgroundJob(job, 'ocr_text_review', reviewJob.sourceImageIds))
        .catch(setOperationError);
    }
    if (batch.correctionJobId && !taskById.has(batch.correctionJobId)) {
      void client.getJob(batch.correctionJobId)
        .then((job) => callbackRef.current.onBackgroundJob(job, 'text_region_correction', batch.sourceImageIds))
        .catch(setOperationError);
    }
  }, [batch?.id, batch?.correctionJobId, client, reviewStateKey, taskById]);

  useEffect(() => {
    if (!batch || !['reviewing', 'submitting'].includes(batch.status) || batch.correctionJobId || finalizing.current) return;
    const reviewTasks = batch.reviewJobs.map((item) => taskById.get(item.jobId));
    if (reviewTasks.some((task) => !task || !isTerminalJobStatus(task.status))) {
      const completed = reviewTasks.filter((task) => task && isTerminalJobStatus(task.status)).length;
      setProgress({
        phase: 'reviewing', completed, total: reviewTasks.length,
        percent: reviewTasks.length ? Math.round(completed / reviewTasks.length * 100) : 100,
      });
      return;
    }
    finalizing.current = true;
    void (async () => {
      let working = batch;
      const save = async (update: Partial<StoredChapterOcrBatch>) => {
        working = await persist({ ...working, ...update, updatedAt: now() });
      };
      try {
        setProgress({ phase: 'submitting', completed: 0, total: 1, percent: 0 });
        await save({ status: 'submitting', error: null });
        const [nextSnapshot, ...reviewJobs] = await Promise.all([
          client.getTextRegions(working.baseJobId),
          ...working.reviewJobs.map((item) => client.getJob(item.jobId)),
        ]);
        setSnapshot(nextSnapshot);
        const correction = buildChapterOcrCorrections(
          nextSnapshot,
          callbackRef.current.workspace,
          working.reviewJobs,
          reviewJobs,
        );
        const summary = { ...working.summary, ...correction.summary };
        if (correction.pages.length === 0) {
          const allFailed = summary.reviewedRegions > 0 && summary.succeededRegions === 0;
          await save({
            status: allFailed ? 'failed' : 'succeeded',
            summary,
            error: allFailed ? 'ocr_text_review_all_items_failed' : null,
          });
          setProgress(null);
          return;
        }
        const correctionJob = await client.createTextRegionCorrection(working.baseJobId, { pages: correction.pages });
        await save({
          status: 'translating',
          correctionJobId: correctionJob.id,
          sourceImageIds: correction.pages.map((page) => page.sourceImageId),
          summary,
        });
        await callbackRef.current.onBackgroundJob(
          correctionJob,
          'text_region_correction',
          correction.pages.map((page) => page.sourceImageId),
        );
        setProgress({ phase: 'translating', completed: 0, total: 1, percent: 0 });
      } catch (error) {
        setOperationError(error);
        await save({ status: 'failed', error: errorMessage(error) });
        setProgress(null);
      } finally {
        finalizing.current = false;
      }
    })();
  }, [batch?.id, batch?.status, client, persist, reviewStateKey, taskById]);

  const correctionTask = batch?.correctionJobId ? taskById.get(batch.correctionJobId) : undefined;
  useEffect(() => {
    if (!batch || batch.status !== 'translating' || !correctionTask) return;
    if (!isTerminalJobStatus(correctionTask.status)) {
      setProgress({ phase: 'translating', completed: 0, total: 1, percent: 0 });
    }
  }, [batch?.id, batch?.status, correctionTask?.status]);

  useEffect(() => {
    if (batch && ['succeeded', 'failed', 'canceled'].includes(batch.status)) setProgress(null);
  }, [batch?.id, batch?.status]);

  const cancel = useCallback(async () => {
    if (!batch || !chapterOcrBatchIsActive(batch)) return;
    preparation.current?.abort();
    const canceling = await persist({ ...batch, status: 'cancel_requested', updatedAt: now() });
    const jobIds = [...canceling.reviewJobs.map((item) => item.jobId), ...(canceling.correctionJobId ? [canceling.correctionJobId] : [])];
    const results = await Promise.allSettled(jobIds.filter((id) => {
      const task = taskById.get(id);
      return !task || !isTerminalJobStatus(task.status);
    }).map((id) => client.cancelJob(id)));
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    await persist({
      ...canceling,
      status: rejected ? 'failed' : 'canceled',
      error: rejected ? errorMessage(rejected.reason) : null,
      updatedAt: now(),
    });
    if (rejected) setOperationError(rejected.reason);
    setProgress(null);
  }, [batch, client, persist, taskById]);

  return {
    snapshot,
    loadingSnapshot,
    availabilityError,
    operationError,
    progress,
    active: chapterOcrBatchIsActive(batch),
    start,
    cancel,
  };
}
