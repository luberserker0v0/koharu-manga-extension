import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { BackendClient } from '../lib/api/backend-client';
import { BackendApiError, isAbortError } from '../lib/api/errors';
import { JobMonitor } from '../lib/api/job-monitor';
import type {
  JobResource,
  TextRegion,
  TextRegionGeometry,
  TextRegionPage,
  TextRegionSnapshot,
} from '../lib/api/types';
import { t } from '../lib/i18n';
import {
  createOcrReviewCrops,
  parseOcrTextReviewResult,
  sourceLanguagesFromJob,
} from '../lib/text-regions/ocr-review';
import {
  buildTextRegionPageCorrections,
  correctionFromDraft,
  draftFromRegion,
  textRegionDraftKey,
  type CreatedTextRegionDraft,
  type TextRegionDraft,
} from '../lib/text-regions/corrections';
import type {
  StoredActiveOcrReview,
  StoredOcrReviewTarget,
  StoredTextRegionWorkspace,
} from '../lib/text-regions/workspace';
import { ErrorNotice } from './ErrorNotice';
import { TextRegionAiReviewPanel, type PageReviewDraft } from './TextRegionAiReviewPanel';

function backendErrorCode(error: unknown): string | null {
  if (!(error instanceof BackendApiError) || !error.detail || typeof error.detail !== 'object') return null;
  const code = (error.detail as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function percent(value: number, total: number): string {
  return `${Math.max(0, Math.min(100, value / total * 100))}%`;
}

function numericValue(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.round(Math.min(maximum, Math.max(minimum, value)) * 100) / 100;
}

function createOperationId(): string {
  const id = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `create-${id}`;
}

const MIN_PREVIEW_ZOOM = 50;
const MAX_PREVIEW_ZOOM = 300;
const PREVIEW_ZOOM_STEP = 25;

function draftKeySourceImageId(key: string): string | null {
  try {
    const value = JSON.parse(key);
    return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
  } catch { return null; }
}

export function TextRegionInspectionPanel({
  client,
  jobId,
  onJobCreated,
  loadOriginalImage,
  lockedSourceImageIds = [],
  storedWorkspace,
  onWorkspaceChange,
  onReviewJobCreated,
}: {
  client: BackendClient;
  jobId: string;
  onJobCreated: (job: JobResource, sourceImageIds: string[]) => void;
  loadOriginalImage?: (sourceImageId: string, signal?: AbortSignal) => Promise<Blob>;
  lockedSourceImageIds?: string[];
  storedWorkspace?: StoredTextRegionWorkspace;
  onWorkspaceChange?: (workspace: StoredTextRegionWorkspace | null) => void | Promise<void>;
  onReviewJobCreated?: (job: JobResource, sourceImageIds: string[]) => void;
}) {
  const restoredWorkspace = storedWorkspace?.baseJobId === jobId ? storedWorkspace : undefined;
  const [snapshot, setSnapshot] = useState<TextRegionSnapshot | null>(null);
  const [selectedSourceImageId, setSelectedSourceImageId] = useState('');
  const [selectedRegionId, setSelectedRegionId] = useState('');
  const [showBoxes, setShowBoxes] = useState(true);
  const [showText, setShowText] = useState(false);
  const [previewMode, setPreviewMode] = useState<'original' | 'translated'>(() => loadOriginalImage ? 'original' : 'translated');
  const [previewZoom, setPreviewZoom] = useState(100);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Map<string, TextRegionDraft>>(() => new Map(restoredWorkspace?.drafts ?? []));
  const [createdDrafts, setCreatedDrafts] = useState<Map<string, CreatedTextRegionDraft>>(() => new Map(restoredWorkspace?.createdDrafts ?? []));
  const [deletedRegionKeys, setDeletedRegionKeys] = useState<Set<string>>(() => new Set(restoredWorkspace?.deletedRegionKeys ?? []));
  const [addingRegion, setAddingRegion] = useState(false);
  const [creationPreview, setCreationPreview] = useState<TextRegionDraft['geometry'] | null>(null);
  const [instructions, setInstructions] = useState(restoredWorkspace?.instructions ?? '');
  const [loading, setLoading] = useState(true);
  const [imageLoading, setImageLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reviewDrafts, setReviewDrafts] = useState<Map<string, PageReviewDraft>>(() => new Map(restoredWorkspace?.reviewDrafts ?? []));
  const [reviewingSourceImageId, setReviewingSourceImageId] = useState('');
  const [reviewError, setReviewError] = useState<unknown>(null);
  const [reviewFailureSummary, setReviewFailureSummary] = useState<{ failed: number; total: number } | null>(null);
  const [reviewJobId, setReviewJobId] = useState('');
  const [activeReview, setActiveReview] = useState<StoredActiveOcrReview | undefined>(restoredWorkspace?.activeReview);
  const [reviewProgress, setReviewProgress] = useState<{ phase: 'preparing' | 'uploading' | 'queued' | 'running'; completed: number; total: number; percent: number } | null>(null);
  const [cancelingReview, setCancelingReview] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const imageUrlRef = useRef<string | null>(null);
  const imageRequestRef = useRef(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const reviewRequestRef = useRef<AbortController | null>(null);
  const reviewMonitorRef = useRef<JobMonitor | null>(null);
  const storedWorkspaceRef = useRef(storedWorkspace);
  const onWorkspaceChangeRef = useRef(onWorkspaceChange);
  storedWorkspaceRef.current = storedWorkspace;
  onWorkspaceChangeRef.current = onWorkspaceChange;
  const pointerEdit = useRef<{
    pointerId: number;
    sourceImageId: string;
    regionId: string;
    mode: 'move' | 'resize';
    clientX: number;
    clientY: number;
    geometry: TextRegionDraft['geometry'];
  } | null>(null);
  const pointerCreate = useRef<{
    pointerId: number;
    sourceImageId: string;
    startX: number;
    startY: number;
  } | null>(null);

  const loadSnapshot = useCallback(async (signal?: AbortSignal) => {
    const saved = storedWorkspaceRef.current?.baseJobId === jobId ? storedWorkspaceRef.current : undefined;
    setSnapshot(null);
    setSelectedSourceImageId('');
    setSelectedRegionId('');
    setDrafts(new Map(saved?.drafts ?? []));
    setCreatedDrafts(new Map(saved?.createdDrafts ?? []));
    setDeletedRegionKeys(new Set(saved?.deletedRegionKeys ?? []));
    setAddingRegion(false);
    setCreationPreview(null);
    setInstructions(saved?.instructions ?? '');
    reviewRequestRef.current?.abort();
    reviewRequestRef.current = null;
    reviewMonitorRef.current?.stop();
    reviewMonitorRef.current = null;
    setReviewDrafts(new Map(saved?.reviewDrafts ?? []));
    setReviewingSourceImageId('');
    setReviewJobId('');
    setActiveReview(saved?.activeReview);
    setReviewProgress(null);
    setCancelingReview(false);
    setReviewError(null);
    setReviewFailureSummary(null);
    setError(null);
    setLoading(true);
    try {
      const next = await client.getTextRegions(jobId, undefined, signal);
      setSnapshot(next);
      const selectedPage = next.pages.find((item) => item.sourceImageId === saved?.selectedSourceImageId) ?? next.pages[0];
      setSelectedSourceImageId(selectedPage?.sourceImageId ?? '');
      const selectedRegionExists = selectedPage?.regions.some((item) => item.id === saved?.selectedRegionId);
      setSelectedRegionId(selectedRegionExists ? saved?.selectedRegionId ?? '' : selectedPage?.regions[0]?.id ?? '');
    } catch (nextError) {
      if (!isAbortError(nextError)) setError(nextError);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [client, jobId]);

  useEffect(() => {
    if (!snapshot || !onWorkspaceChangeRef.current) return;
    const timer = window.setTimeout(() => {
      const hasContent = drafts.size || createdDrafts.size || deletedRegionKeys.size || reviewDrafts.size || instructions.trim() || activeReview;
      void onWorkspaceChangeRef.current?.(hasContent ? {
        baseJobId: jobId,
        selectedSourceImageId,
        selectedRegionId,
        drafts: [...drafts.entries()],
        createdDrafts: [...createdDrafts.entries()],
        deletedRegionKeys: [...deletedRegionKeys],
        reviewDrafts: [...reviewDrafts.entries()],
        ...(activeReview ? { activeReview } : {}),
        instructions,
        updatedAt: new Date().toISOString(),
      } : null);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeReview, createdDrafts, deletedRegionKeys, drafts, instructions, jobId, reviewDrafts, selectedRegionId, selectedSourceImageId, snapshot]);

  useEffect(() => {
    const controller = new AbortController();
    void loadSnapshot(controller.signal);
    return () => controller.abort();
  }, [loadSnapshot]);

  const page = useMemo(() => snapshot?.pages.find((item) => item.sourceImageId === selectedSourceImageId)
    ?? snapshot?.pages[0]
    ?? null, [selectedSourceImageId, snapshot]);
  const pageLocked = Boolean(page && lockedSourceImageIds.includes(page.sourceImageId));
  const selectedCreatedKey = page ? textRegionDraftKey(page.sourceImageId, selectedRegionId) : '';
  const createdRegion = selectedCreatedKey ? createdDrafts.get(selectedCreatedKey) ?? null : null;
  const selectedExistingRegion = page?.regions.find((item) => item.id === selectedRegionId) ?? null;
  const region = createdRegion ? null : selectedExistingRegion ?? (!selectedRegionId ? page?.regions[0] ?? null : null);
  const regionKey = page && region ? textRegionDraftKey(page.sourceImageId, region.id) : '';
  const regionDraft = createdRegion ?? (region ? drafts.get(regionKey) ?? draftFromRegion(region) : null);
  const pageCreatedDrafts = useMemo(() => page
    ? [...createdDrafts.values()].filter((draft) => draft.sourceImageId === page.sourceImageId)
    : [], [createdDrafts, page]);
  const regionDeleted = Boolean(regionKey && deletedRegionKeys.has(regionKey));
  const pageReview = page ? reviewDrafts.get(page.sourceImageId) ?? null : null;
  const reviewTargets = useMemo(() => {
    if (!page) return [];
    const existing = page.regions.flatMap((item, index) => {
      const key = textRegionDraftKey(page.sourceImageId, item.id);
      if (deletedRegionKeys.has(key)) return [];
      const draft = drafts.get(key) ?? draftFromRegion(item);
      return [{
        id: item.id,
        readingOrder: index,
        geometry: draft.geometry,
        sourceText: draft.sourceText,
        targetKind: 'existing' as const,
      }];
    });
    const created = pageCreatedDrafts.map((item, index) => ({
      id: item.clientOperationId,
      readingOrder: existing.length + index,
      geometry: item.geometry,
      sourceText: item.sourceText,
      targetKind: 'created' as const,
    }));
    return [...existing, ...created];
  }, [deletedRegionKeys, drafts, page, pageCreatedDrafts]);

  const correctionState = useMemo(() => {
    if (!snapshot) return { pages: [], operationCount: 0, error: null as unknown };
    try {
      const pages = buildTextRegionPageCorrections(snapshot.pages, drafts, createdDrafts, deletedRegionKeys);
      return {
        pages,
        operationCount: pages.reduce((sum, item) => sum + item.operations.length, 0),
        error: null as unknown,
      };
    } catch (validationError) {
      return { pages: [], operationCount: 0, error: validationError };
    }
  }, [createdDrafts, deletedRegionKeys, drafts, snapshot]);
  const unlockedCorrectionPages = correctionState.pages.filter((item) => !lockedSourceImageIds.includes(item.sourceImageId));
  const unlockedOperationCount = unlockedCorrectionPages.reduce((sum, item) => sum + item.operations.length, 0);

  useEffect(() => {
    if (!snapshot || !page) return;
    const controller = new AbortController();
    const requestId = ++imageRequestRef.current;
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = null;
    setImageUrl(null);
    setImageLoading(true);
    setError(null);
    void (async () => {
      let blob: Blob;
      if (previewMode === 'original' && loadOriginalImage) {
        blob = await loadOriginalImage(page.sourceImageId, controller.signal);
      } else {
        const manifest = await client.getPageRevisions(snapshot.rootJobId, controller.signal);
        const revisionPage = manifest.pages.find((item) => item.sourceImageId === page.sourceImageId);
        const revision = revisionPage?.revisions.find((item) => item.revisionId === page.pageRevisionId);
        if (!revision) throw new Error('source_page_mapping_incomplete');
        blob = await client.downloadPageRevisionImage(revision, controller.signal);
      }
      const nextUrl = URL.createObjectURL(blob);
      if (controller.signal.aborted || imageRequestRef.current !== requestId) {
        URL.revokeObjectURL(nextUrl);
        return;
      }
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = nextUrl;
      setImageUrl(nextUrl);
    })().catch((nextError: unknown) => {
      if (!isAbortError(nextError) && imageRequestRef.current === requestId) setError(nextError);
    }).finally(() => {
      if (!controller.signal.aborted && imageRequestRef.current === requestId) setImageLoading(false);
    });
    return () => controller.abort();
  }, [
    client,
    loadOriginalImage,
    page?.pageRevisionId,
    page?.sourceImageId,
    previewMode,
    snapshot?.rootJobId,
  ]);

  useEffect(() => () => {
    reviewRequestRef.current?.abort();
    reviewMonitorRef.current?.stop();
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
  }, []);

  const updateSpecificDraft = (
    targetPage: TextRegionPage,
    targetRegion: TextRegion,
    update: (draft: TextRegionDraft) => TextRegionDraft,
  ) => {
    setDrafts((current) => {
      const next = new Map(current);
      const key = textRegionDraftKey(targetPage.sourceImageId, targetRegion.id);
      const value = update(next.get(key) ?? draftFromRegion(targetRegion));
      try {
        if (correctionFromDraft(targetRegion, value)) next.set(key, value); else next.delete(key);
      } catch {
        next.set(key, value);
      }
      return next;
    });
  };

  const updateDraft = (update: (draft: TextRegionDraft) => TextRegionDraft) => {
    if (!page) return;
    if (createdRegion) {
      setCreatedDrafts((current) => {
        const next = new Map(current);
        next.set(selectedCreatedKey, { ...createdRegion, ...update(createdRegion) });
        return next;
      });
    } else if (region) {
      updateSpecificDraft(page, region, update);
    }
  };

  const updateGeometry = (field: keyof TextRegionGeometry, value: string) => {
    updateDraft((current) => ({
      ...current,
      geometry: { ...current.geometry, [field]: numericValue(value) },
    }));
  };

  const resetRegion = () => {
    if (!page) return;
    if (createdRegion) {
      setCreatedDrafts((current) => {
        const next = new Map(current);
        next.delete(selectedCreatedKey);
        return next;
      });
      setSelectedRegionId(page.regions[0]?.id ?? '');
      return;
    }
    if (!region) return;
    setDrafts((current) => {
      const next = new Map(current);
      next.delete(textRegionDraftKey(page.sourceImageId, region.id));
      return next;
    });
    setDeletedRegionKeys((current) => {
      const next = new Set(current);
      next.delete(textRegionDraftKey(page.sourceImageId, region.id));
      return next;
    });
  };

  const toggleDeleteRegion = () => {
    if (!page || !region) return;
    const key = textRegionDraftKey(page.sourceImageId, region.id);
    setDeletedRegionKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const updateRegionDraft = (
    targetPage: TextRegionPage,
    regionId: string,
    update: (draft: TextRegionDraft) => TextRegionDraft,
  ) => {
    const createdKey = textRegionDraftKey(targetPage.sourceImageId, regionId);
    const created = createdDrafts.get(createdKey);
    if (created) {
      setCreatedDrafts((current) => {
        const next = new Map(current);
        const latest = next.get(createdKey);
        if (latest) next.set(createdKey, { ...latest, ...update(latest) });
        return next;
      });
      return;
    }
    const existing = targetPage.regions.find((candidate) => candidate.id === regionId);
    if (existing) updateSpecificDraft(targetPage, existing, update);
  };

  const startPointerEdit = (
    event: ReactPointerEvent<HTMLButtonElement>,
    targetPage: TextRegionPage,
    regionId: string,
    geometry: TextRegionDraft['geometry'],
  ) => {
    if (pageLocked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedRegionId(regionId);
    const mode = (event.target as HTMLElement).closest('.text-region-resize-handle') ? 'resize' : 'move';
    pointerEdit.current = {
      pointerId: event.pointerId,
      sourceImageId: targetPage.sourceImageId,
      regionId,
      mode,
      clientX: event.clientX,
      clientY: event.clientY,
      geometry: { ...geometry },
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const applyPointerEdit = (
    event: ReactPointerEvent<HTMLButtonElement>,
    targetPage: TextRegionPage,
    regionId: string,
  ) => {
    const active = pointerEdit.current;
    const stage = stageRef.current;
    if (!active || active.pointerId !== event.pointerId || !stage
      || active.sourceImageId !== targetPage.sourceImageId || active.regionId !== regionId) return;
    const bounds = stage.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const deltaX = (event.clientX - active.clientX) * targetPage.coordinateSpace.width / bounds.width;
    const deltaY = (event.clientY - active.clientY) * targetPage.coordinateSpace.height / bounds.height;
    const geometry = active.mode === 'move'
      ? {
          ...active.geometry,
          x: clamp(active.geometry.x + deltaX, 0, targetPage.coordinateSpace.width - active.geometry.width),
          y: clamp(active.geometry.y + deltaY, 0, targetPage.coordinateSpace.height - active.geometry.height),
        }
      : {
          ...active.geometry,
          width: clamp(active.geometry.width + deltaX, 1, targetPage.coordinateSpace.width - active.geometry.x),
          height: clamp(active.geometry.height + deltaY, 1, targetPage.coordinateSpace.height - active.geometry.y),
        };
    updateRegionDraft(targetPage, regionId, (current) => ({ ...current, geometry }));
  };

  const endPointerEdit = (
    event: ReactPointerEvent<HTMLButtonElement>,
    targetPage: TextRegionPage,
    regionId: string,
  ) => {
    if (pointerEdit.current?.pointerId !== event.pointerId) return;
    // Some mobile extension surfaces coalesce or omit the final pointermove.
    // Commit the pointerup coordinates as well so the position the user sees
    // at release is always represented in the correction request.
    applyPointerEdit(event, targetPage, regionId);
    pointerEdit.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const cancelPointerEdit = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pointerEdit.current?.pointerId !== event.pointerId) return;
    pointerEdit.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const pointerPosition = (event: ReactPointerEvent<HTMLDivElement>, targetPage: TextRegionPage) => {
    const stage = stageRef.current;
    if (!stage) return null;
    const bounds = stage.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    return {
      x: clamp((event.clientX - bounds.left) * targetPage.coordinateSpace.width / bounds.width, 0, targetPage.coordinateSpace.width),
      y: clamp((event.clientY - bounds.top) * targetPage.coordinateSpace.height / bounds.height, 0, targetPage.coordinateSpace.height),
    };
  };

  const startRegionCreation = (event: ReactPointerEvent<HTMLDivElement>, targetPage: TextRegionPage) => {
    if (pageLocked || !addingRegion || event.button !== 0 || event.target !== event.currentTarget) return;
    const point = pointerPosition(event, targetPage);
    if (!point) return;
    event.preventDefault();
    pointerCreate.current = { pointerId: event.pointerId, sourceImageId: targetPage.sourceImageId, startX: point.x, startY: point.y };
    setCreationPreview({ x: point.x, y: point.y, width: 1, height: 1, rotation: 0 });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const continueRegionCreation = (event: ReactPointerEvent<HTMLDivElement>, targetPage: TextRegionPage) => {
    const active = pointerCreate.current;
    if (!active || active.pointerId !== event.pointerId || active.sourceImageId !== targetPage.sourceImageId) return;
    const point = pointerPosition(event, targetPage);
    if (!point) return;
    setCreationPreview({
      x: Math.min(active.startX, point.x),
      y: Math.min(active.startY, point.y),
      width: Math.max(1, Math.abs(point.x - active.startX)),
      height: Math.max(1, Math.abs(point.y - active.startY)),
      rotation: 0,
    });
  };

  const endRegionCreation = (event: ReactPointerEvent<HTMLDivElement>, targetPage: TextRegionPage) => {
    const active = pointerCreate.current;
    if (!active || active.pointerId !== event.pointerId || active.sourceImageId !== targetPage.sourceImageId) return;
    const point = pointerPosition(event, targetPage);
    const geometry = point ? {
      x: Math.min(active.startX, point.x),
      y: Math.min(active.startY, point.y),
      width: Math.max(1, Math.abs(point.x - active.startX)),
      height: Math.max(1, Math.abs(point.y - active.startY)),
      rotation: 0,
    } : creationPreview;
    pointerCreate.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setCreationPreview(null);
    if (!geometry || geometry.width <= 1 || geometry.height <= 1) return;
    const clientOperationId = createOperationId();
    const draft: CreatedTextRegionDraft = {
      sourceImageId: targetPage.sourceImageId,
      clientOperationId,
      sourceText: '',
      geometry,
    };
    setCreatedDrafts((current) => new Map(current).set(
      textRegionDraftKey(targetPage.sourceImageId, clientOperationId),
      draft,
    ));
    setSelectedRegionId(clientOperationId);
    setAddingRegion(false);
  };

  const cancelRegionCreation = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerCreate.current?.pointerId !== event.pointerId) return;
    pointerCreate.current = null;
    setCreationPreview(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const monitorOcrReview = useCallback((
    ocrReviewJobId: string,
    targetPage: TextRegionPage,
    targets: StoredOcrReviewTarget[],
  ) => {
    reviewMonitorRef.current?.stop();
    setReviewJobId(ocrReviewJobId);
    setReviewingSourceImageId(targetPage.sourceImageId);
    setReviewProgress((current) => current ?? {
      phase: 'queued', completed: 0, total: targets.length, percent: 0,
    });
    const monitor = new JobMonitor(client, ocrReviewJobId, {
      onJob: (nextJob) => {
        if (nextJob.status === 'succeeded') {
          try {
            const result = parseOcrTextReviewResult(nextJob);
            const byId = new Map(result.items.map((item) => [item.clientItemId, item]));
            const regions = targets.map((item) => {
              const reviewItem = byId.get(item.id);
              return {
                clientItemId: item.id,
                originalText: item.sourceText,
                targetKind: item.targetKind,
                box: [item.geometry.x, item.geometry.y, item.geometry.width, item.geometry.height] as [number, number, number, number],
                text: reviewItem?.correctedText ?? item.sourceText,
                status: reviewItem?.status ?? 'failed',
                error: reviewItem?.error,
                code: reviewItem?.code,
              };
            });
            setReviewDrafts((current) => new Map(current).set(targetPage.sourceImageId, {
              count: regions.length,
              regions,
              baseRegionSetRevisionId: targetPage.regionSetRevisionId,
            }));
            setReviewFailureSummary(result.summary.failedCount > 0
              ? { failed: result.summary.failedCount, total: result.summary.total }
              : null);
            if (result.summary.failedCount === result.summary.total) {
              setReviewError(new Error('ocr_text_review_all_items_failed'));
            }
            setShowBoxes(true);
            setShowText(true);
          } catch (nextError) {
            setReviewError(nextError);
          }
          monitor.stop();
          reviewMonitorRef.current = null;
          setActiveReview(undefined);
          setReviewingSourceImageId('');
          setReviewJobId('');
          setReviewProgress(null);
        } else if (['failed', 'canceled', 'blocked'].includes(nextJob.status)) {
          if (nextJob.status !== 'canceled') setReviewError(new Error(nextJob.error || `ocr_text_review_${nextJob.status}`));
          monitor.stop();
          reviewMonitorRef.current = null;
          setActiveReview(undefined);
          setReviewingSourceImageId('');
          setReviewJobId('');
          setReviewProgress(null);
        }
      },
      onEvent: (event) => {
        if (event.type !== 'ocr_text_review.progress') return;
        const completed = Number(event.payload?.completed || 0);
        const total = Number(event.payload?.total || targets.length);
        setReviewProgress({
          phase: 'running', completed, total,
          percent: total ? Math.round(completed / total * 100) : 0,
        });
      },
      onTransport: () => {},
      onError: () => {},
    });
    reviewMonitorRef.current = monitor;
    void monitor.start();
  }, [client]);

  useEffect(() => {
    if (!snapshot || !activeReview || reviewMonitorRef.current) return;
    const targetPage = snapshot.pages.find((item) => item.sourceImageId === activeReview.sourceImageId);
    if (!targetPage) {
      setActiveReview(undefined);
      setReviewError(new Error('text_region_page_not_found'));
      return;
    }
    monitorOcrReview(activeReview.jobId, targetPage, activeReview.targets);
  }, [activeReview, monitorOcrReview, snapshot]);

  const reviewCurrentPage = async () => {
    if (!page || reviewTargets.length === 0 || reviewingSourceImageId) return;
    if (!loadOriginalImage) {
      setReviewError(new Error('ocr_review_original_image_unavailable'));
      return;
    }
    reviewRequestRef.current?.abort();
    reviewMonitorRef.current?.stop();
    reviewMonitorRef.current = null;
    const controller = new AbortController();
    reviewRequestRef.current = controller;
    setReviewingSourceImageId(page.sourceImageId);
    setReviewJobId('');
    setReviewProgress({ phase: 'preparing', completed: 0, total: reviewTargets.length, percent: 0 });
    setCancelingReview(false);
    setReviewError(null);
    setReviewFailureSummary(null);
    setPreviewMode('original');
    let abandonedUploadId = '';
    try {
      const [image, sourceJob] = await Promise.all([
        loadOriginalImage(page.sourceImageId, controller.signal),
        client.getJob(jobId, controller.signal),
      ]);
      const targets = reviewTargets;
      const crops = await createOcrReviewCrops(image, page, targets);
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const upload = await client.createUpload(controller.signal, 'ocr_review');
      abandonedUploadId = upload.uploadId;
      setReviewProgress({ phase: 'uploading', completed: 0, total: crops.length, percent: 0 });
      await client.uploadFiles(upload.uploadId, crops.map((item) => item.file), (progress) => {
        setReviewProgress({
          phase: 'uploading',
          completed: progress.fileIndex,
          total: progress.fileCount,
          percent: progress.percent,
        });
      }, controller.signal);
      await client.completeUpload(upload.uploadId, controller.signal);
      setReviewProgress({ phase: 'queued', completed: 0, total: crops.length, percent: 0 });
      const reviewJob = await client.createOcrTextReviewJob({
        uploadId: upload.uploadId,
        sourceLanguages: sourceLanguagesFromJob(sourceJob),
        items: crops.map((item) => item.request),
      }, controller.signal);
      abandonedUploadId = '';
      reviewRequestRef.current = null;
      const active: StoredActiveOcrReview = {
        jobId: reviewJob.id,
        sourceImageId: page.sourceImageId,
        targets: targets.map((target) => ({ ...target, geometry: { ...target.geometry } })),
      };
      setActiveReview(active);
      onReviewJobCreated?.(reviewJob, [page.sourceImageId]);
      monitorOcrReview(reviewJob.id, page, active.targets);
    } catch (nextError) {
      if (abandonedUploadId) void client.deleteUpload(abandonedUploadId).catch(() => {});
      if (!isAbortError(nextError)) setReviewError(nextError);
      setReviewingSourceImageId('');
      setReviewProgress(null);
    } finally {
      if (reviewRequestRef.current === controller) {
        reviewRequestRef.current = null;
      }
    }
  };

  const stopWaitingForReview = async () => {
    if (cancelingReview) return;
    setCancelingReview(true);
    reviewRequestRef.current?.abort();
    reviewRequestRef.current = null;
    try {
      if (reviewJobId) await client.cancelJob(reviewJobId);
      else {
        reviewMonitorRef.current?.stop();
        reviewMonitorRef.current = null;
        setReviewingSourceImageId('');
        setReviewProgress(null);
      }
    } catch (nextError) {
      setReviewError(nextError);
    } finally {
      setCancelingReview(false);
    }
  };

  const updateReviewText = (sourceImageId: string, index: number, text: string) => {
    setReviewDrafts((current) => {
      const draft = current.get(sourceImageId);
      const region = draft?.regions[index];
      if (!draft || !region) return current;
      const regions = draft.regions.map((item, itemIndex) => itemIndex === index ? { ...item, text } : item);
      return new Map(current).set(sourceImageId, { ...draft, count: regions.length, regions });
    });
  };

  const discardReview = (sourceImageId: string) => {
    setReviewDrafts((current) => {
      const next = new Map(current);
      next.delete(sourceImageId);
      return next;
    });
    setReviewError(null);
    setReviewFailureSummary(null);
  };

  const adoptReview = () => {
    if (!page || !pageReview) return;
    setDrafts((current) => {
      const next = new Map(current);
      pageReview.regions.forEach((suggestion) => {
        if (suggestion.targetKind !== 'existing' || suggestion.status === 'failed' || !suggestion.text.trim()) return;
        const existing = page.regions.find((item) => item.id === suggestion.clientItemId);
        if (!existing) return;
        const key = textRegionDraftKey(page.sourceImageId, existing.id);
        const value = { ...(next.get(key) ?? draftFromRegion(existing)), sourceText: suggestion.text };
        try {
          if (correctionFromDraft(existing, value)) next.set(key, value); else next.delete(key);
        } catch {
          next.set(key, value);
        }
      });
      return next;
    });
    setCreatedDrafts((current) => {
      const next = new Map(current);
      pageReview.regions.forEach((suggestion) => {
        if (suggestion.targetKind !== 'created' || suggestion.status === 'failed' || !suggestion.text.trim()) return;
        const key = textRegionDraftKey(page.sourceImageId, suggestion.clientItemId);
        const draft = next.get(key);
        if (draft) next.set(key, { ...draft, sourceText: suggestion.text });
      });
      return next;
    });
    discardReview(page.sourceImageId);
    setShowBoxes(true);
    setShowText(true);
  };

  const submitCorrections = async () => {
    if (!unlockedCorrectionPages.length || correctionState.error) return;
    setSubmitting(true);
    setError(null);
    try {
      const instructionText = instructions.trim();
      const job = await client.createTextRegionCorrection(jobId, {
        pages: unlockedCorrectionPages,
        ...(instructionText ? { instructions: instructionText } : {}),
      });
      const submittedIds = new Set(unlockedCorrectionPages.map((item) => item.sourceImageId));
      setDrafts((current) => new Map([...current].filter(([key]) => !submittedIds.has(draftKeySourceImageId(key) ?? ''))));
      setCreatedDrafts((current) => new Map([...current].filter(([, draft]) => !submittedIds.has(draft.sourceImageId))));
      setDeletedRegionKeys((current) => new Set([...current].filter((key) => !submittedIds.has(draftKeySourceImageId(key) ?? ''))));
      setReviewDrafts((current) => new Map([...current].filter(([sourceImageId]) => !submittedIds.has(sourceImageId))));
      setInstructions('');
      onJobCreated(job, [...submittedIds]);
    } catch (nextError) {
      setError(nextError);
    } finally { setSubmitting(false); }
  };

  const unavailableCode = backendErrorCode(error);
  const unavailable = unavailableCode === 'text_region_snapshot_unavailable'
    || unavailableCode === 'text_region_coordinate_space_unavailable';
  const stale = unavailableCode === 'stale_region_set_revision';

  return (
    <section className="panel text-region-panel" aria-labelledby="text-region-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{t('textRegionEyebrow')}</p>
          <h2 id="text-region-title">{t('textRegionTitle')}</h2>
        </div>
        {snapshot && <span className="count-badge">{snapshot.pages.reduce((sum, item) => sum + item.regions.length, 0)}</span>}
      </div>
      <p className="muted">{t('textRegionDescription')}</p>
      {loading ? <div className="scan-state"><div className="spinner" />{t('textRegionLoading')}</div> : null}
      {unavailable ? <div className="notice notice-neutral">{t(`error_${unavailableCode}`)}</div> : null}
      {stale ? (
        <div className="notice notice-error" role="alert">
          <p>{t('error_stale_region_set_revision')}</p>
          <button className="secondary-button" type="button" onClick={() => void loadSnapshot()}>{t('textRegionReload')}</button>
        </div>
      ) : null}
      {!unavailable && !stale ? <ErrorNotice error={error} /> : null}
      <ErrorNotice error={reviewError} />
      {reviewFailureSummary && reviewFailureSummary.failed < reviewFailureSummary.total && (
        <div className="notice notice-neutral" role="status">
          {t('textRegionAiReviewPartialFailure', [String(reviewFailureSummary.failed), String(reviewFailureSummary.total)])}
        </div>
      )}
      {correctionState.error ? <ErrorNotice error={correctionState.error} /> : null}
      {!loading && !error && snapshot?.pages.length === 0 && <div className="empty-state">{t('textRegionEmpty')}</div>}
      {snapshot && page && (
        <>
          <div className="text-region-toolbar">
            <div className="text-region-image-switch" role="group" aria-label={t('textRegionImageMode')}>
              <button
                type="button"
                className={previewMode === 'original' ? 'active' : ''}
                disabled={!loadOriginalImage}
                aria-pressed={previewMode === 'original'}
                onClick={() => setPreviewMode('original')}
              >
                {t('textRegionOriginalImage')}
              </button>
              <button
                type="button"
                className={previewMode === 'translated' ? 'active' : ''}
                aria-pressed={previewMode === 'translated'}
                onClick={() => setPreviewMode('translated')}
              >
                {t('textRegionTranslatedImage')}
              </button>
            </div>
            <div className="text-region-zoom" role="group" aria-label={t('textRegionZoomControls')}>
              <button
                type="button"
                disabled={previewZoom <= MIN_PREVIEW_ZOOM}
                aria-label={t('textRegionZoomOut')}
                onClick={() => setPreviewZoom((current) => Math.max(MIN_PREVIEW_ZOOM, current - PREVIEW_ZOOM_STEP))}
              >
                −
              </button>
              <button
                type="button"
                className="zoom-value"
                title={t('textRegionZoomReset')}
                aria-label={t('textRegionZoomReset')}
                onClick={() => setPreviewZoom(100)}
              >
                {previewZoom}%
              </button>
              <button
                type="button"
                disabled={previewZoom >= MAX_PREVIEW_ZOOM}
                aria-label={t('textRegionZoomIn')}
                onClick={() => setPreviewZoom((current) => Math.min(MAX_PREVIEW_ZOOM, current + PREVIEW_ZOOM_STEP))}
              >
                +
              </button>
            </div>
            <label>
              <span>{t('textRegionPageLabel')}</span>
              <select
                value={page.sourceImageId}
                onChange={(event) => {
                  const nextPage = snapshot.pages.find((item) => item.sourceImageId === event.target.value);
                  const nextCreated = [...createdDrafts.values()].find((item) => item.sourceImageId === event.target.value);
                  setSelectedSourceImageId(event.target.value);
                  setSelectedRegionId(nextPage?.regions[0]?.id ?? nextCreated?.clientOperationId ?? '');
                  setAddingRegion(false);
                  setCreationPreview(null);
                }}
              >
                {snapshot.pages.map((item) => {
                  const changed = item.regions.filter((candidate) => {
                    const key = textRegionDraftKey(item.sourceImageId, candidate.id);
                    return drafts.has(key) || deletedRegionKeys.has(key);
                  }).length + [...createdDrafts.values()].filter((candidate) => candidate.sourceImageId === item.sourceImageId).length;
                  return (
                    <option key={item.sourceImageId} value={item.sourceImageId}>
                      {t('textRegionPageOption', String(item.sourceOrderIndex + 1))} · {item.sourceFileName}{changed ? ` · ${t('textRegionChangedCount', String(changed))}` : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            <div className="text-region-toggles">
              <label><input type="checkbox" checked={showBoxes} onChange={(event) => setShowBoxes(event.target.checked)} />{t('textRegionShowBoxes')}</label>
              <label><input type="checkbox" checked={showText} onChange={(event) => setShowText(event.target.checked)} />{t('textRegionShowText')}</label>
            </div>
            <button
              className={`secondary-button text-region-add-button${addingRegion ? ' active' : ''}`}
              type="button"
              disabled={pageLocked}
              aria-pressed={addingRegion}
              onClick={() => {
                setAddingRegion((current) => !current);
                setCreationPreview(null);
                setShowBoxes(true);
                if (loadOriginalImage) setPreviewMode('original');
              }}
            >
              {t(addingRegion ? 'textRegionCancelAdd' : 'textRegionAdd')}
            </button>
            <button
              className="secondary-button text-region-ai-button"
              type="button"
              disabled={pageLocked || !loadOriginalImage || reviewTargets.length === 0 || Boolean(reviewingSourceImageId)}
              onClick={() => void reviewCurrentPage()}
            >
              {reviewingSourceImageId === page.sourceImageId ? t('textRegionAiReviewRunning') : t('textRegionAiReviewStart')}
            </button>
            {reviewingSourceImageId === page.sourceImageId && (
              <button className="secondary-button danger-button" type="button" disabled={cancelingReview} onClick={() => void stopWaitingForReview()}>
                {t(cancelingReview ? 'textRegionAiReviewCanceling' : 'textRegionAiReviewCancel')}
              </button>
            )}
            {reviewingSourceImageId === page.sourceImageId && reviewProgress && (
              <p className="field-help">
                {t(`textRegionAiReviewPhase_${reviewProgress.phase}`, [String(reviewProgress.completed), String(reviewProgress.total), String(reviewProgress.percent)])}
              </p>
            )}
            {!loadOriginalImage && <p className="field-help">{t('textRegionAiReviewOriginalUnavailable')}</p>}
            {pageLocked && <p className="field-help notice notice-waiting">{t('backgroundJobPageLockedDescription')}</p>}
            {correctionState.operationCount > 0 && <p className="field-help">{t('textRegionAiReviewManualConflict')}</p>}
            {reviewTargets.length === 0 && <p className="field-help">{t('textRegionAiReviewNeedsBoxes')}</p>}
            {addingRegion && <p className="field-help text-region-add-help">{t('textRegionAddHelp')}</p>}
          </div>
          <div className="text-region-preview">
            {imageLoading && <div className="scan-state"><div className="spinner" />{t(previewMode === 'original' ? 'textRegionOriginalImageLoading' : 'textRegionImageLoading')}</div>}
            {imageUrl && !imageLoading && (
              <div className="text-region-stage" ref={stageRef} style={{ width: `${previewZoom}%` }}>
                <img src={imageUrl} alt={t(previewMode === 'original' ? 'textRegionOriginalPreviewAlt' : 'textRegionPreviewAlt', String(page.sourceOrderIndex + 1))} />
                <div
                  className={`text-region-overlay${showBoxes ? ' show-boxes' : ''}${showText ? ' show-text' : ''}${addingRegion ? ' adding' : ''}`}
                  onPointerDown={(event) => startRegionCreation(event, page)}
                  onPointerMove={(event) => continueRegionCreation(event, page)}
                  onPointerUp={(event) => endRegionCreation(event, page)}
                  onPointerCancel={cancelRegionCreation}
                >
                  {page.regions.map((item, index) => {
                    const itemKey = textRegionDraftKey(page.sourceImageId, item.id);
                    const itemDraft = drafts.get(itemKey);
                    const deleted = deletedRegionKeys.has(itemKey);
                    const geometry = itemDraft?.geometry ?? item.geometry;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`${item.id === region?.id ? 'selected' : ''}${itemDraft ? ' changed' : ''}${deleted ? ' deleted' : ''}`.trim()}
                        style={{
                          left: percent(geometry.x, page.coordinateSpace.width),
                          top: percent(geometry.y, page.coordinateSpace.height),
                          width: percent(geometry.width, page.coordinateSpace.width),
                          height: percent(geometry.height, page.coordinateSpace.height),
                          transform: `rotate(${geometry.rotation ?? 0}deg)`,
                        }}
                        onClick={() => setSelectedRegionId(item.id)}
                        onPointerDown={deleted ? undefined : (event) => startPointerEdit(event, page, item.id, geometry)}
                        onPointerMove={deleted ? undefined : (event) => applyPointerEdit(event, page, item.id)}
                        onPointerUp={deleted ? undefined : (event) => endPointerEdit(event, page, item.id)}
                        onPointerCancel={cancelPointerEdit}
                        aria-label={t('textRegionSelect', String(index + 1))}
                      >
                        <span className="text-region-number">{index + 1}</span>
                        <span className="text-region-overlay-text">{deleted ? t('textRegionDeleted') : itemDraft?.sourceText ?? item.sourceText}</span>
                        {item.id === region?.id && showBoxes && !deleted && (
                          <span className="text-region-resize-handle" aria-label={t('textRegionResizeHandle')} />
                        )}
                      </button>
                    );
                  })}
                  {pageCreatedDrafts.map((item, index) => (
                    <button
                      key={item.clientOperationId}
                      type="button"
                      className={`created changed${item.clientOperationId === createdRegion?.clientOperationId ? ' selected' : ''}`}
                      style={{
                        left: percent(item.geometry.x, page.coordinateSpace.width),
                        top: percent(item.geometry.y, page.coordinateSpace.height),
                        width: percent(item.geometry.width, page.coordinateSpace.width),
                        height: percent(item.geometry.height, page.coordinateSpace.height),
                        transform: `rotate(${item.geometry.rotation ?? 0}deg)`,
                      }}
                      onClick={() => setSelectedRegionId(item.clientOperationId)}
                      onPointerDown={(event) => startPointerEdit(event, page, item.clientOperationId, item.geometry)}
                      onPointerMove={(event) => applyPointerEdit(event, page, item.clientOperationId)}
                      onPointerUp={(event) => endPointerEdit(event, page, item.clientOperationId)}
                      onPointerCancel={cancelPointerEdit}
                      aria-label={t('textRegionSelectCreated', String(page.regions.length + index + 1))}
                    >
                      <span className="text-region-number">+</span>
                      <span className="text-region-overlay-text">{item.sourceText || t('textRegionNew')}</span>
                      {item.clientOperationId === createdRegion?.clientOperationId && showBoxes && (
                        <span className="text-region-resize-handle" aria-label={t('textRegionResizeHandle')} />
                      )}
                    </button>
                  ))}
                  {pageReview?.regions.map((item, index) => (
                    <span
                      key={`ai-review-${index}`}
                      className="text-region-ai-overlay"
                      style={{
                        left: percent(item.box[0], page.coordinateSpace.width),
                        top: percent(item.box[1], page.coordinateSpace.height),
                        width: percent(item.box[2], page.coordinateSpace.width),
                        height: percent(item.box[3], page.coordinateSpace.height),
                      }}
                    >
                      <span className="text-region-number">AI {index + 1}</span>
                      <span className="text-region-overlay-text">{item.text}</span>
                    </span>
                  ))}
                  {creationPreview && (
                    <span
                      className="text-region-create-preview"
                      style={{
                        left: percent(creationPreview.x, page.coordinateSpace.width),
                        top: percent(creationPreview.y, page.coordinateSpace.height),
                        width: percent(creationPreview.width, page.coordinateSpace.width),
                        height: percent(creationPreview.height, page.coordinateSpace.height),
                      }}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
          {pageReview && (
            <TextRegionAiReviewPanel
              draft={pageReview}
              onUpdateText={(index, text) => updateReviewText(page.sourceImageId, index, text)}
              onDiscard={() => discardReview(page.sourceImageId)}
              onAdopt={adoptReview}
            />
          )}
          <div className="text-region-list" role="list" aria-label={t('textRegionListLabel')}>
            {page.regions.map((item, index) => {
              const itemKey = textRegionDraftKey(page.sourceImageId, item.id);
              const deleted = deletedRegionKeys.has(itemKey);
              const changed = drafts.has(itemKey) || deleted;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="listitem"
                  className={`${item.id === region?.id ? 'selected' : ''}${changed ? ' changed' : ''}${deleted ? ' deleted' : ''}`.trim()}
                  onClick={() => setSelectedRegionId(item.id)}
                >
                  <span>{index + 1}</span>
                  <strong>{deleted ? t('textRegionDeleted') : drafts.get(itemKey)?.sourceText || item.sourceText || t('textRegionNoSourceText')}</strong>
                  {changed && <i aria-label={t('textRegionChanged')}>{deleted ? t('textRegionDeletedMark') : t('textRegionChangedMark')}</i>}
                </button>
              );
            })}
            {pageCreatedDrafts.map((item, index) => (
              <button
                key={item.clientOperationId}
                type="button"
                role="listitem"
                className={`created changed${item.clientOperationId === createdRegion?.clientOperationId ? ' selected' : ''}`}
                onClick={() => setSelectedRegionId(item.clientOperationId)}
              >
                <span>{page.regions.length + index + 1}</span>
                <strong>{item.sourceText || t('textRegionNew')}</strong>
                <i aria-label={t('textRegionChanged')}>{t('textRegionNewMark')}</i>
              </button>
            ))}
          </div>
          {(region || createdRegion) && regionDraft && (
            <div className="text-region-editor">
              <div className="text-region-editor-heading">
                <strong>{t(createdRegion ? 'textRegionNew' : regionDeleted ? 'textRegionDeleted' : 'textRegionExisting')}</strong>
                {createdRegion ? (
                  <button className="secondary-button danger-button" type="button" disabled={pageLocked} onClick={resetRegion}>{t('textRegionCancelCreated')}</button>
                ) : (
                  <button className="secondary-button danger-button" type="button" disabled={pageLocked} onClick={toggleDeleteRegion}>
                    {t(regionDeleted ? 'textRegionRestoreDeleted' : 'textRegionDelete')}
                  </button>
                )}
              </div>
              <label className="text-region-source-editor">
                <span>{t('textRegionSourceText')}</span>
                <textarea
                  value={regionDraft.sourceText}
                  maxLength={10000}
                  disabled={regionDeleted || pageLocked}
                  onChange={(event) => updateDraft((current) => ({ ...current, sourceText: event.target.value }))}
                />
              </label>
              <div className="text-region-geometry" role="group" aria-label={t('textRegionGeometry')}>
                {(['x', 'y', 'width', 'height', 'rotation'] as const).map((field) => (
                  <label key={field}>
                    <span>{t(`textRegionGeometry_${field}`)}</span>
                    <input
                      type="number"
                      step={field === 'rotation' ? '0.1' : '1'}
                      min={field === 'width' || field === 'height' ? '0.01' : field === 'rotation' ? undefined : '0'}
                      value={Number.isFinite(regionDraft.geometry[field] ?? 0) ? regionDraft.geometry[field] : ''}
                      disabled={regionDeleted || pageLocked}
                      onChange={(event) => updateGeometry(field, event.target.value)}
                    />
                  </label>
                ))}
              </div>
              <p className="field-help">{t('textRegionGeometryHelp', [String(page.coordinateSpace.width), String(page.coordinateSpace.height)])}</p>
              {region && <dl className="text-region-detail">
                <div><dt>{t('textRegionTranslatedText')}</dt><dd>{region.translatedText || t('textRegionNoTranslatedText')}</dd></div>
                {typeof region.ocrConfidence === 'number' && (
                  <div><dt>{t('textRegionConfidence')}</dt><dd>{Math.round(region.ocrConfidence * 1000) / 10}%</dd></div>
                )}
              </dl>}
              {region && <button className="secondary-button" type="button" disabled={!drafts.has(regionKey) && !regionDeleted} onClick={resetRegion}>{t('textRegionResetRegion')}</button>}
            </div>
          )}
          <label className="revision-instruction-field">
            <span>{t('textRegionInstructionsLabel')}</span>
            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder={t('textRegionInstructionsPlaceholder')}
            />
          </label>
          <p className="field-help">{t('textRegionCorrectionHelp')}</p>
          <div className="text-region-submit-summary">
            <span>{t('textRegionBatchSummary', [String(unlockedOperationCount), String(unlockedCorrectionPages.length)])}</span>
            <button
              className="secondary-button"
              type="button"
              disabled={(!drafts.size && !createdDrafts.size && !deletedRegionKeys.size) || submitting}
              onClick={() => {
                setDrafts(new Map());
                setCreatedDrafts(new Map());
                setDeletedRegionKeys(new Set());
                setSelectedRegionId(page.regions[0]?.id ?? '');
              }}
            >
              {t('textRegionResetAll')}
            </button>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={!unlockedOperationCount || Boolean(correctionState.error) || submitting}
            onClick={() => void submitCorrections()}
          >
            {submitting ? t('textRegionCorrectionCreating') : t('textRegionSubmitCorrections', String(unlockedOperationCount))}
          </button>
        </>
      )}
    </section>
  );
}
