import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackendClient } from '../lib/api/backend-client';
import { isAbortError } from '../lib/api/errors';
import type { RuntimeStatus, SourcePreflight, UploadProgress } from '../lib/api/types';
import { buildQuickTranslationRequest, type TranslationFormValues } from '../lib/domain/translation-request';
import {
  clearWorkflow,
  discardMissingWorkflow,
  loadWorkflow,
  saveWorkflow,
  type StoredWorkflow,
} from '../lib/storage/workflow';

export type WorkflowPhase =
  | 'loading'
  | 'idle'
  | 'checking'
  | 'uploading'
  | 'preflighting'
  | 'review'
  | 'creating'
  | 'monitoring'
  | 'unavailable';

function sortFiles(files: File[]): File[] {
  return [...files].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
}

const GLOBAL_SCOPE = '__global__';

export function useTranslationWorkflow(client: BackendClient | null, sourcePageUrl?: string) {
  const [phase, setPhase] = useState<WorkflowPhase>('loading');
  const [workflow, setWorkflow] = useState<StoredWorkflow | null>(null);
  const [restored, setRestored] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [preflight, setPreflight] = useState<SourcePreflight | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<unknown>(null);
  const operation = useRef<AbortController | null>(null);
  const requestedScope = sourcePageUrl ?? GLOBAL_SCOPE;
  const [loadedScope, setLoadedScope] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let disposed = false;
    void (async () => {
      try {
        const saved = await loadWorkflow(sourcePageUrl);
        if (disposed) return;
        setWorkflow(saved);
        setRestored(Boolean(saved));
        setPreflight(null);
        setError(null);
        setLoadedScope(requestedScope);
        if (saved?.jobId) {
          setPhase('monitoring');
        } else if (saved?.preflightId) {
          const restored = await client.getPreflight(saved.preflightId);
          if (!disposed) {
            setPreflight(restored);
            setPhase('review');
          }
        } else {
          setPhase('idle');
        }
      } catch (restoreError) {
        if (!disposed) {
          setError(restoreError);
          setLoadedScope(requestedScope);
          setPhase('unavailable');
        }
      }
    })();
    return () => { disposed = true; operation.current?.abort(); };
  }, [client, requestedScope, sourcePageUrl]);

  const checkBackend = useCallback(async (signal?: AbortSignal) => {
    if (!client) throw new Error('settings_not_loaded');
    setError(null);
    setRuntime(null);
    setPhase('checking');
    const health = await client.health(signal);
    if (!health.ok) throw new Error('backend_health_unavailable');
    const readiness = await client.readiness(signal);
    if (!readiness.ok || !readiness.capabilities.koharuJobs) throw new Error('koharu_not_ready');
    const status = await client.runtimeStatus(signal);
    setRuntime(status);
    if (status.backend?.status !== 'ready') throw new Error('backend_not_ready');
    if (status.koharu?.status !== 'running') throw new Error('koharu_not_ready');
    return status;
  }, [client]);

  const refreshAvailability = useCallback(async () => {
    const controller = new AbortController();
    operation.current = controller;
    try {
      await checkBackend(controller.signal);
      setPhase(workflow?.jobId ? 'monitoring' : preflight ? 'review' : 'idle');
    } catch (nextError) {
      if (!isAbortError(nextError)) {
        setError(nextError);
        setPhase('unavailable');
      }
    } finally {
      operation.current = null;
    }
  }, [checkBackend, preflight, workflow?.jobId]);

  const startUpload = useCallback(async (
    selected: File[],
    preserveOrder = false,
    comicCrawler?: StoredWorkflow['comicCrawler'],
  ) => {
    if (!client) return;
    const files = preserveOrder ? [...selected] : sortFiles(selected);
    if (!files.length) {
      setError(new Error('no_images_selected'));
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    setProgress(null);
    setPreflight(null);
    setError(null);
    try {
      await checkBackend(controller.signal);
      const upload = await client.createUpload(controller.signal);
      const record: StoredWorkflow = {
        uploadId: upload.uploadId,
        sourcePageUrl,
        fileNames: files.map((file) => file.name),
        ...(comicCrawler ? { comicCrawler } : {}),
        updatedAt: new Date().toISOString(),
      };
      setRestored(false);
      setWorkflow(record);
      await saveWorkflow(record);
      setPhase('uploading');
      await client.uploadFiles(upload.uploadId, files, setProgress, controller.signal);
      await client.completeUpload(upload.uploadId, controller.signal);
      setPhase('preflighting');
      const result = await client.createPreflight(upload.uploadId, controller.signal);
      const sourceByFileName = new Map(result.images.map((image) => [image.fileName, image.id]));
      const next: StoredWorkflow = {
        ...record,
        preflightId: result.preflightId,
        sourceImages: result.images.map((image, uploadOrder) => ({
          sourceImageId: image.id,
          uploadOrder,
          fileName: image.fileName,
        })),
        ...(record.comicCrawler?.pages ? {
          comicCrawler: {
            ...record.comicCrawler,
            pages: record.comicCrawler.pages.map((page) => ({
              ...page,
              ...(sourceByFileName.get(page.fileName) ? { sourceImageId: sourceByFileName.get(page.fileName) } : {}),
            })),
          },
        } : {}),
        updatedAt: new Date().toISOString(),
      };
      setWorkflow(next);
      setPreflight(result);
      await saveWorkflow(next);
      setPhase('review');
    } catch (nextError) {
      setError(nextError);
      if (isAbortError(nextError)) {
        setPhase('idle');
      } else {
        setPhase('unavailable');
      }
    } finally {
      operation.current = null;
    }
  }, [checkBackend, client, sourcePageUrl]);

  const moveImage = useCallback((from: number, direction: -1 | 1) => {
    setPreflight((current) => {
      if (!current) return current;
      const to = from + direction;
      if (to < 0 || to >= current.images.length) return current;
      const images = [...current.images];
      const [moved] = images.splice(from, 1);
      if (!moved) return current;
      images.splice(to, 0, moved);
      return { ...current, images: images.map((image, orderIndex) => ({ ...image, orderIndex })) };
    });
  }, []);

  const createJob = useCallback(async (values: TranslationFormValues) => {
    if (!client || !workflow?.preflightId || !preflight) return;
    const controller = new AbortController();
    operation.current = controller;
    setError(null);
    setPhase('creating');
    try {
      await checkBackend(controller.signal);
      const ordered = await client.reorderPreflight(
        workflow.preflightId,
        preflight.images.map((image) => image.id),
        controller.signal,
      );
      setPreflight(ordered);
      const crawlerPagesByFileName = new Map(workflow.comicCrawler?.pages?.map((page) => [page.fileName, page]));
      const reorderedCrawlerPages = crawlerPagesByFileName?.size
        ? ordered.images.map((image, uploadOrder) => {
            const page = crawlerPagesByFileName.get(image.fileName);
            if (!page) throw new Error('source_page_mapping_incomplete');
            return { ...page, uploadOrder };
          })
        : workflow.comicCrawler?.pages;
      const payload = buildQuickTranslationRequest(values, workflow.preflightId);
      const job = await client.createTranslationJob(payload, controller.signal);
      const sourceImagesById = new Map(workflow.sourceImages?.map((image) => [image.sourceImageId, image]));
      const next: StoredWorkflow = {
        ...workflow,
        jobId: job.id,
        rootJobId: job.id,
        fileNames: ordered.images.map((image) => image.fileName),
        sourceImages: ordered.images.map((image, uploadOrder) => ({
          sourceImageId: image.id,
          uploadOrder,
          fileName: sourceImagesById.get(image.id)?.fileName ?? image.fileName,
        })),
        ...(workflow.comicCrawler ? {
          comicCrawler: {
            ...workflow.comicCrawler,
            ...(reorderedCrawlerPages ? { pages: reorderedCrawlerPages } : {}),
          },
        } : {}),
        bindings: {
          mangaId: values.mangaId.trim(),
          translatorId: values.translatorId.trim(),
          chapterId: values.chapterId.trim(),
          targetLanguage: values.targetLanguage.trim(),
          sourceLanguage: values.sourceLanguage.trim(),
          exportFormat: values.exportFormat,
          translationProviderId: values.translationProviderId.trim() || undefined,
          translationModelId: values.translationModelId.trim() || undefined,
        },
        updatedAt: new Date().toISOString(),
      };
      setWorkflow(next);
      await saveWorkflow(next);
      setPhase('monitoring');
    } catch (nextError) {
      setError(nextError);
      setPhase('review');
    } finally {
      operation.current = null;
    }
  }, [checkBackend, client, preflight, workflow]);

  const reset = useCallback(async () => {
    operation.current?.abort();
    await clearWorkflow(sourcePageUrl);
    setWorkflow(null);
    setRestored(false);
    setPreflight(null);
    setProgress(null);
    setError(null);
    setPhase('idle');
  }, [sourcePageUrl]);

  const discardMissingJob = useCallback(async () => {
    operation.current?.abort();
    const missingJobId = workflow?.jobId;
    if (missingJobId) await discardMissingWorkflow(missingJobId, sourcePageUrl);
    else await clearWorkflow(sourcePageUrl);
    setWorkflow(null);
    setRestored(false);
    setPreflight(null);
    setProgress(null);
    setError(null);
    setPhase('idle');
  }, [sourcePageUrl, workflow?.jobId]);

  const replaceJob = useCallback(async (jobId: string, rootJobId?: string, parentJobId?: string) => {
    if (!workflow) return;
    const next = {
      ...workflow,
      jobId,
      rootJobId: rootJobId ?? workflow.rootJobId ?? workflow.jobId ?? jobId,
      ...(parentJobId ? { parentJobId } : {}),
      updatedAt: new Date().toISOString(),
    };
    setRestored(false);
    setWorkflow(next);
    await saveWorkflow(next);
    setPhase('monitoring');
  }, [workflow]);

  const requeueFromPreflight = useCallback(async () => {
    if (!client || !workflow?.preflightId) return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setError(null);
    setPhase('checking');
    try {
      const restored = await client.getPreflight(workflow.preflightId, controller.signal);
      const { jobId: _dropped, ...rest } = workflow;
      void _dropped;
      const next: StoredWorkflow = { ...rest, updatedAt: new Date().toISOString() };
      delete next.jobId;
      setRestored(false);
      setWorkflow(next);
      setPreflight(restored);
      await saveWorkflow(next);
      setPhase('review');
    } catch (nextError) {
      setError(nextError);
      setPhase(workflow.jobId ? 'monitoring' : 'review');
    } finally {
      operation.current = null;
    }
  }, [client, workflow]);

  const resumeWorkflow = useCallback(async (saved: StoredWorkflow) => {
    operation.current?.abort();
    setWorkflow(saved);
    setRestored(true);
    setPreflight(null);
    setProgress(null);
    setError(null);
    await saveWorkflow(saved);
    setPhase(saved.jobId ? 'monitoring' : saved.preflightId ? 'review' : 'idle');
    if (saved.preflightId && !saved.jobId && client) setPreflight(await client.getPreflight(saved.preflightId));
  }, [client]);

  const scopeReady = loadedScope === requestedScope;
  return {
    phase,
    workflow: scopeReady ? workflow : null,
    restored: scopeReady && restored,
    runtime,
    preflight: scopeReady ? preflight : null,
    progress,
    error,
    refreshAvailability,
    startUpload,
    cancelUpload: () => operation.current?.abort(),
    moveImage,
    createJob,
    reset,
    discardMissingJob,
    replaceJob,
    requeueFromPreflight,
    resumeWorkflow,
  };
}
