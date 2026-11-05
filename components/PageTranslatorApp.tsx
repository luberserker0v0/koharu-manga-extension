import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useJobMonitor } from '../hooks/useJobMonitor';
import { useBackgroundJobs } from '../hooks/useBackgroundJobs';
import { useSettings } from '../hooks/useSettings';
import { useTranslationWorkflow } from '../hooks/useTranslationWorkflow';
import { BackendClient } from '../lib/api/backend-client';
import type { PageRevisionManifest } from '../lib/api/types';
import { orderedTranslatedImages } from '../lib/artifacts/translated-images';
import { ComicCrawlerClient } from '../lib/comic-crawler/client';
import { ComicCrawlerError } from '../lib/comic-crawler/errors';
import type { ChapterImageManifest } from '../lib/comic-crawler/types';
import { originalCandidateFromChapterManifest, passiveSourcePagesForWorkflow, workflowManifestCompatibilityError } from '../lib/page-images/chapter-manifest';
import { ComicCrawlerDetector } from '../lib/page-images/comic-crawler-detector';
import type { PageDomBridge } from '../lib/page-images/bridge';
import { comicCrawlerDetectionTimeout } from '../lib/page-images/detection-policy';
import { loadCandidateFiles, requiredSourceOrigins } from '../lib/page-images/source-loader';
import type { DetectionResult, PageImageCandidate } from '../lib/page-images/types';
import { candidateForStoredSourceImage, candidatesForStoredWorkflow, sourcePageReferencesForWorkflow, workflowMappingComplete } from '../lib/page-images/workflow-mapping';
import { PassiveTranslationApplicator } from '../lib/page-images/passive-translation-applicator';
import { optionalMessage, t } from '../lib/i18n';
import { isTerminalJobStatus } from '../lib/domain/job-state';
import { chapterOcrBatchIsActive } from '../lib/text-regions/chapter-ocr-batch';
import { findWorkflowForChapter, loadWorkflow, loadWorkflowHistory, pageWorkflowKey, workflowMatchesChapter, type StoredWorkflow } from '../lib/storage/workflow';
import { ErrorNotice } from './ErrorNotice';
import { BackgroundJobsPanel } from './BackgroundJobsPanel';
import { ChapterOcrBatchPanel } from './ChapterOcrBatchPanel';
import { AdapterDiscoveryPanel } from './AdapterDiscoveryPanel';
import { JobPanel } from './JobPanel';
import { PageRevisionPanel } from './PageRevisionPanel';
import { ScrollControls } from './ScrollControls';
import { TextRegionInspectionPanel } from './TextRegionInspectionPanel';
import { PreflightReview } from './PreflightReview';
import { TranslationForm } from './TranslationForm';

type ScanPhase = 'checking' | 'ready' | 'scanning' | 'awaiting_source_permission' | 'loading_sources' | 'hidden' | 'error';

interface PendingSourceAccess {
  requestId: string;
  origins: string[];
}

interface InlineApplyProgress {
  jobId: string;
  phase: 'preparing' | 'applying' | 'completed' | 'failed';
  completed: number;
  total: number;
}

function mergeFallback(primary: DetectionResult, fallback: DetectionResult): DetectionResult {
  if (primary.images.length) return primary;
  return {
    ...fallback,
    warnings: [...primary.warnings, ...fallback.warnings],
    discoveryAvailable: primary.discoveryAvailable,
    adapter: primary.adapter,
    adapterStatus: primary.adapterStatus,
  };
}

function move<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return items;
  next.splice(to, 0, item);
  return next;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('artifact_read_failed')));
    reader.readAsDataURL(blob);
  });
}

export function PageTranslatorApp({ domBridge }: { domBridge: PageDomBridge }) {
  const [sourcePageUrl, setSourcePageUrl] = useState(() => pageWorkflowKey(location.href));
  const { settings, setShowPageNumbers } = useSettings();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<ScanPhase>('checking');
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [scanError, setScanError] = useState<unknown>(null);
  const [sourceProgress, setSourceProgress] = useState<[number, number] | null>(null);
  const [pendingSourceAccess, setPendingSourceAccess] = useState<PendingSourceAccess | null>(null);
  const [openingSourceAccess, setOpeningSourceAccess] = useState(false);
  const [inlineApplyProgress, setInlineApplyProgress] = useState<InlineApplyProgress | null>(null);
  const [chapterManifest, setChapterManifest] = useState<ChapterImageManifest | null>(null);
  const [pageApplied, setPageApplied] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [fabPosition, setFabPosition] = useState<{ x: number; y: number } | null>(null);
  const [fabDock, setFabDock] = useState<'left' | 'right'>('left');
  const [fabDragging, setFabDragging] = useState(false);
  const fabDrag = useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number; currentLeft: number; currentTop: number; width: number; height: number; moved: boolean } | null>(null);
  const fabSize = useRef({ width: 0, height: 0 });
  const suppressFabClick = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const deepDetection = useRef<Promise<DetectionResult | null> | null>(null);
  const inlineApplyOperation = useRef<{ jobId: string; promise: Promise<boolean> } | null>(null);
  const applyJobInlineRef = useRef<(jobId: string, saved?: StoredWorkflow | null) => Promise<boolean>>(() => Promise.reject(new Error('source_page_mapping_incomplete')));
  const applyResolvedUrlsRef = useRef<(pages: Array<{ sourceImageId: string; url: string }>) => Promise<boolean>>(() => Promise.reject(new Error('source_page_mapping_incomplete')));
  const applyPageRevisionManifestRef = useRef<(manifest: PageRevisionManifest, saved?: StoredWorkflow | null) => Promise<void>>(() => Promise.reject(new Error('source_page_mapping_incomplete')));
  const passiveApplicator = useRef<PassiveTranslationApplicator | null>(null);
  const passiveApplyCleanup = useRef<(() => void) | null>(null);
  const passiveAutoApplyAttempt = useRef<string | null>(null);
  const sourceController = useRef<AbortController | null>(null);
  const pendingSelection = useRef<PageImageCandidate[] | null>(null);
  const pendingSourceAccessRef = useRef<PendingSourceAccess | null>(null);
  const resumeTranslation = useRef<() => void>(() => undefined);
  const crawlerHistoryLookup = useRef<string | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const backend = useMemo(() => settings ? new BackendClient(settings, { useBackgroundProxy: true }) : null, [settings]);
  const crawler = useMemo(
    () => settings?.comicCrawler.enabled ? new ComicCrawlerClient(settings.comicCrawler, { useBackgroundProxy: true }) : null,
    [settings],
  );
  const workflow = useTranslationWorkflow(backend, sourcePageUrl);
  const monitor = useJobMonitor(backend, workflow.workflow?.jobId ?? null, workflow.discardMissingJob);
  const sourceImagePages = useMemo(
    () => sourcePageReferencesForWorkflow(workflow.workflow),
    [workflow.workflow],
  );
  const backgroundTasks = workflow.workflow?.backgroundTasks ?? [];
  useBackgroundJobs(backend, backgroundTasks, workflow.reconcileBackgroundJob);
  const lockedSourceImageIds = useMemo(() => [...new Set([
    ...backgroundTasks
      .filter((task) => task.kind !== 'ocr_text_review' && !isTerminalJobStatus(task.status))
      .flatMap((task) => task.sourceImageIds),
    ...(chapterOcrBatchIsActive(workflow.workflow?.chapterOcrBatch)
      ? sourceImagePages.map((page) => page.sourceImageId)
      : []),
  ])], [backgroundTasks, sourceImagePages, workflow.workflow?.chapterOcrBatch]);
  const images = result?.images ?? [];
  const selected = images.filter((image) => image.selected && image.loadStatus === 'loaded');
  const storedWorkflowMappingReady = workflowMappingComplete(result, workflow.workflow);
  const sourcePageSignature = sourceImagePages
    .map((page) => `${page.sourceImageId}:${page.sourceOrderIndex}`)
    .join('|');
  pendingSourceAccessRef.current = pendingSourceAccess;

  useEffect(() => {
    const saved = workflow.workflow;
    if (!settings?.showPageNumbers || !saved?.jobId || sourceImagePages.length === 0) {
      void domBridge.setPageNumberLabels([]);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      let candidates: PageImageCandidate[];
      if (chapterManifest && !workflowManifestCompatibilityError(chapterManifest, saved)) {
        candidates = sourceImagePages.map((page) => originalCandidateFromChapterManifest(
          chapterManifest,
          saved,
          page.sourceImageId,
        ));
      } else {
        const detected = result?.images.length
          ? result.images
          : (await domBridge.detect(false, controller.signal, true)).images;
        candidates = sourceImagePages.map((page) => {
          const candidate = candidateForStoredSourceImage(detected, saved, page.sourceImageId);
          if (!candidate) throw new Error('source_page_mapping_incomplete');
          return candidate;
        });
      }
      if (controller.signal.aborted) return;
      await domBridge.setPageNumberLabels(candidates.map((candidate, index) => ({
        candidate,
        pageNumber: sourceImagePages[index]!.sourceOrderIndex + 1,
        label: t('pageNumberBadge', String(sourceImagePages[index]!.sourceOrderIndex + 1)),
      })));
    })().catch(() => {
      if (!controller.signal.aborted) void domBridge.setPageNumberLabels([]);
    });
    return () => controller.abort();
  }, [
    chapterManifest?.revision,
    domBridge,
    result,
    workflow.workflow?.jobId,
    settings?.showPageNumbers,
    sourcePageSignature,
  ]);

  const loadOriginalImage = useCallback(async (sourceImageId: string, signal?: AbortSignal): Promise<Blob> => {
    const saved = workflow.workflow ?? await loadWorkflow(sourcePageUrl);
    if (!saved) throw new Error('source_page_mapping_incomplete');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let candidate: PageImageCandidate | null = null;
    if (result?.images.length) {
      try {
        candidate = candidateForStoredSourceImage(result.images, saved, sourceImageId);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'source_page_mapping_incomplete') throw error;
      }
    }
    if (!candidate && crawler && saved.comicCrawler?.chapterId) {
      let manifest = chapterManifest?.chapter.id === saved.comicCrawler.chapterId
        ? chapterManifest
        : await crawler.getChapterImageManifest(saved.comicCrawler.chapterId, signal);
      if (!manifest) {
        manifest = await crawler.resolveChapterImageManifest(
          saved.comicCrawler.chapterUrl || saved.sourcePageUrl || sourcePageUrl,
          saved.comicCrawler.adapterId,
          signal,
        );
      }
      if (manifest) {
        candidate = originalCandidateFromChapterManifest(manifest, saved, sourceImageId);
      }
    }
    if (!candidate) {
      const detected = await domBridge.detect(false, signal, true);
      try {
        candidate = candidateForStoredSourceImage(detected.images, saved, sourceImageId);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'source_page_mapping_incomplete') throw error;
      }
    }
    if (!candidate) throw new Error('source_page_mapping_incomplete');
    if (candidate.sourceUrl.startsWith('canvas:')) return domBridge.snapshotCanvas(candidate);
    const [file] = await loadCandidateFiles([candidate], signal);
    if (!file) throw new Error('page_image_fetch_failed');
    return file;
  }, [chapterManifest, crawler, domBridge, result, sourcePageUrl, workflow.workflow]);

  useEffect(() => {
    const listener = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)
        || message.type !== 'GET_ORIGINAL_PAGE_IMAGE') return undefined;
      const sourceImageId = 'sourceImageId' in message && typeof message.sourceImageId === 'string'
        ? message.sourceImageId
        : '';
      if (!sourceImageId) return Promise.resolve({ ok: false, error: 'source_page_mapping_incomplete' });
      return loadOriginalImage(sourceImageId)
        .then(async (blob) => ({ ok: true, dataUrl: await blobToDataUrl(blob) }))
        .catch((error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'page_image_fetch_failed',
        }));
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [loadOriginalImage]);

  const applyPageRevisions = (manifest: PageRevisionManifest, saved = workflow.workflow) => (
    applyPageRevisionManifestRef.current(manifest, saved)
  );

  useEffect(() => {
    const keepFabDocked = () => {
      setFabPosition((current) => {
        if (!current || !fabSize.current.width) return current;
        return {
          x: fabDock === 'left' ? 0 : Math.max(0, window.innerWidth - fabSize.current.width),
          y: Math.max(0, Math.min(window.innerHeight - fabSize.current.height, current.y)),
        };
      });
    };
    window.addEventListener('resize', keepFabDocked);
    return () => window.removeEventListener('resize', keepFabDocked);
  }, [fabDock]);

  const performDetection = async (deep: boolean): Promise<DetectionResult | null> => {
    if (!settings) return null;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setPhase(deep ? 'scanning' : 'checking');
    setScanError(null);
    try {
      const crawlerPromise = crawler
        ? new ComicCrawlerDetector(crawler).detect(location.href, {
            signal: nextController.signal,
            resolveOnly: !deep,
            timeoutMs: comicCrawlerDetectionTimeout(deep),
            renderContext: {
              viewport: {
                width: Math.max(1, Math.round(window.innerWidth)),
                height: Math.max(1, Math.round(window.innerHeight)),
              },
              deviceScaleFactor: Math.max(0.1, Math.min(10, window.devicePixelRatio || 1)),
            },
          })
        : null;
      const publish = (finalResult: DetectionResult) => {
        if (controller.current !== nextController || nextController.signal.aborted) return;
        setResult(finalResult);
        setPhase(finalResult.images.length || finalResult.discoveryAvailable || finalResult.adapterStatus === 'matched' ? 'ready' : 'hidden');
        return finalResult;
      };

      if (deep && crawlerPromise) {
        // The Browser Client and the DOM detector both prepare lazy content by
        // scrolling the real page. Running them concurrently causes competing
        // scroll restoration and previously mislabeled a healthy, slower
        // ComicCrawler request as unavailable whenever DOM detection won.
        const crawlerResult = await crawlerPromise;
        if (crawlerResult.images.length) {
          return publish(crawlerResult) ?? null;
        }
        const domResult = await domBridge.detect(true, nextController.signal);
        return publish(mergeFallback(crawlerResult, domResult)) ?? null;
      }

      const domPromise = domBridge.detect(deep, nextController.signal);
      const [domResult, crawlerResult] = await Promise.all([domPromise, crawlerPromise ?? Promise.resolve(null)]);
      return publish(crawlerResult ? mergeFallback(crawlerResult, domResult) : domResult) ?? null;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      setScanError(error);
      setPhase('error');
      return null;
    }
  };

  const detect = (deep: boolean): Promise<DetectionResult | null> => {
    if (!deep) return performDetection(false);
    if (deepDetection.current) return deepDetection.current;
    const operation = performDetection(true).finally(() => {
      if (deepDetection.current === operation) deepDetection.current = null;
    });
    deepDetection.current = operation;
    return operation;
  };

  useEffect(() => {
    const synchronizeUrl = () => {
      const current = pageWorkflowKey(location.href);
      setSourcePageUrl((previous) => previous === current ? previous : current);
    };
    window.addEventListener('popstate', synchronizeUrl);
    window.addEventListener('hashchange', synchronizeUrl);
    const interval = window.setInterval(synchronizeUrl, 500);
    return () => {
      window.removeEventListener('popstate', synchronizeUrl);
      window.removeEventListener('hashchange', synchronizeUrl);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const resumeAfterVerification = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)
        || message.type !== 'COMIC_CRAWLER_VERIFICATION_READY'
        || !('url' in message) || typeof message.url !== 'string') return;
      if (pageWorkflowKey(message.url) !== pageWorkflowKey(location.href)) return;
      void detect(true);
    };
    browser.runtime.onMessage.addListener(resumeAfterVerification);
    return () => browser.runtime.onMessage.removeListener(resumeAfterVerification);
  }, [settings, crawler, sourcePageUrl]);

  useEffect(() => {
    if (!settings) return;
    setOpen(false);
    setResult(null);
    setSourceProgress(null);
    void detect(false);
    return () => controller.current?.abort();
    // Re-scan only when settings finish loading; settings changes reload extension contexts.
  }, [settings, domBridge, sourcePageUrl]);

  useEffect(() => {
    setChapterManifest(null);
    if (!crawler) return;
    const controller = new AbortController();
    let disposed = false;
    void crawler.resolveChapterImageManifest(location.href, undefined, controller.signal)
      .then((manifest) => {
        if (!disposed) setChapterManifest(manifest);
      })
      .catch((error: unknown) => {
        if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return;
        // Manifest lookup is an optional, passive optimization. Adapter detection
        // and explicit translation remain available when no saved manifest can be read.
        setChapterManifest(null);
      });
    return () => { disposed = true; controller.abort(); };
  }, [crawler, sourcePageUrl]);

  useEffect(() => {
    if (!chapterManifest || workflow.phase === 'loading') return;
    const lookupKey = `manifest:${chapterManifest.chapter.id}:${chapterManifest.revision}`;
    if (crawlerHistoryLookup.current === lookupKey) return;
    crawlerHistoryLookup.current = lookupKey;
    let disposed = false;
    void (async () => {
      const history = await loadWorkflowHistory();
      const current = workflow.workflow?.jobId
        && workflowMatchesChapter(
          workflow.workflow,
          sourcePageUrl,
          chapterManifest.chapter.canonicalUrl,
          chapterManifest.chapter.id,
        )
        ? workflow.workflow
        : null;
      const previous = current ?? findWorkflowForChapter(
        history,
        sourcePageUrl,
        chapterManifest.chapter.canonicalUrl,
        chapterManifest.chapter.id,
      );
      if (disposed || !previous?.jobId || workflow.workflow?.jobId === previous.jobId) return;
      await workflow.resumeWorkflow(previous);
    })().catch((error: unknown) => {
      if (!disposed) setScanError(error);
    });
    return () => { disposed = true; };
  }, [chapterManifest, sourcePageUrl, workflow.phase, workflow.resumeWorkflow, workflow.workflow]);

  useEffect(() => {
    if (!settings?.comicCrawler.enabled || result?.detector !== 'comic_crawler'
      || result.adapterStatus !== 'matched' || !result.chapterUrl || !result.images.length) return;
    const lookupKey = result.chapterIdentity?.id ?? `${sourcePageUrl}\n${result.chapterUrl}`;
    if (crawlerHistoryLookup.current === lookupKey) return;
    if (workflow.phase === 'loading') return;
    crawlerHistoryLookup.current = lookupKey;
    let disposed = false;
    void (async () => {
      const history = await loadWorkflowHistory();
      const current = workflow.workflow?.jobId
        && workflowMatchesChapter(workflow.workflow, sourcePageUrl, result.chapterUrl!, result.chapterIdentity?.id)
        ? workflow.workflow
        : null;
      const previous = current ?? findWorkflowForChapter(
        history,
        sourcePageUrl,
        result.chapterUrl!,
        result.chapterIdentity?.id,
      );
      if (disposed || !previous?.jobId) return;
      if (workflow.workflow?.jobId !== previous.jobId) await workflow.resumeWorkflow(previous);
    })().catch((error: unknown) => {
      if (!disposed) setScanError(error);
    });
    return () => { disposed = true; };
  }, [backend, domBridge, result, settings?.comicCrawler.enabled, settings?.comicCrawler.autoApplyPreviousTranslation, sourcePageUrl, workflow.phase, workflow.workflow, workflow.resumeWorkflow]);

  useEffect(() => {
    crawlerHistoryLookup.current = null;
    passiveAutoApplyAttempt.current = null;
    passiveApplyCleanup.current?.();
    passiveApplyCleanup.current = null;
    passiveApplicator.current?.stop();
    passiveApplicator.current = null;
  }, [sourcePageUrl]);

  useEffect(() => () => {
    passiveApplyCleanup.current?.();
    passiveApplyCleanup.current = null;
    passiveApplicator.current?.stop();
    passiveApplicator.current = null;
  }, []);

  useEffect(() => { void domBridge.setLayout(open, phase !== 'hidden'); }, [domBridge, open, phase]);

  useEffect(() => {
    if (inlineApplyProgress?.phase !== 'completed') return;
    const timer = window.setTimeout(() => setInlineApplyProgress((current) => current?.phase === 'completed' ? null : current), 4_000);
    return () => window.clearTimeout(timer);
  }, [inlineApplyProgress?.phase]);

  const updateImages = (updater: (current: PageImageCandidate[]) => PageImageCandidate[]) => {
    setResult((current) => current ? { ...current, images: updater(current.images).map((image, order) => ({ ...image, order })) } : current);
  };

  const translate = async (resumePending = false) => {
    const translationSelection = resumePending ? pendingSelection.current ?? [] : selected.map((candidate) => ({ ...candidate }));
    if (!translationSelection.length) return;
    setScanError(null);
    const loadController = new AbortController();
    sourceController.current = loadController;
    try {
      const canvasSelected = translationSelection.filter((candidate) => candidate.sourceUrl.startsWith('canvas:'));
      const urlSelected = translationSelection.filter((candidate) => !candidate.sourceUrl.startsWith('canvas:'));
      const origins = await requiredSourceOrigins(urlSelected);
      if (origins.length) {
        const access = await browser.runtime.sendMessage({
          type: 'CHECK_SOURCE_ORIGINS',
          origins,
          pageUrl: location.href,
        }) as { granted?: boolean; missing?: string[]; requestId?: string } | undefined;
        if (!access?.granted) {
          if (!access?.requestId || !access.missing?.length) throw new Error('source_host_permission_required');
          pendingSelection.current = translationSelection;
          setPendingSourceAccess({ requestId: access.requestId, origins: access.missing });
          setPhase('awaiting_source_permission');
          return;
        }
      }
      pendingSelection.current = null;
      setPendingSourceAccess(null);
      setPhase('loading_sources');
      const filesById = new Map<string, File>();
      if (urlSelected.length) {
        const loaded = await loadCandidateFiles(
          urlSelected,
          loadController.signal,
          (current) => setSourceProgress([current, translationSelection.length]),
        );
        urlSelected.forEach((candidate, index) => filesById.set(candidate.id, loaded[index]!));
      }
      for (let index = 0; index < canvasSelected.length; index += 1) {
        if (loadController.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const candidate = canvasSelected[index]!;
        filesById.set(candidate.id, await domBridge.snapshotCanvas(candidate));
        setSourceProgress([urlSelected.length + index + 1, translationSelection.length]);
      }
      const files = translationSelection.map((candidate) => filesById.get(candidate.id)!).filter(Boolean);
      if (files.length !== translationSelection.length) throw new Error('page_image_fetch_failed');
      let manifestForTranslation = chapterManifest;
      const crawlerResult = result?.detector === 'comic_crawler' && result.chapterUrl
        && result.chapterIdentity && result.adapter
        ? result
        : null;
      if (crawlerResult && crawler) {
        manifestForTranslation = await crawler.getChapterImageManifest(crawlerResult.chapterIdentity!.id)
          .catch(() => null);
        if (manifestForTranslation) setChapterManifest(manifestForTranslation);
      }
      await workflow.startUpload(files, true, crawlerResult
        ? {
            adapterId: crawlerResult.adapter!.id,
            chapterUrl: crawlerResult.chapterUrl!,
            chapterId: crawlerResult.chapterIdentity!.id,
            canonicalUrl: crawlerResult.chapterIdentity!.canonicalUrl,
            ...(manifestForTranslation?.chapter.id === crawlerResult.chapterIdentity!.id
              ? { manifestRevision: manifestForTranslation.revision }
              : {}),
            pages: translationSelection.map((candidate, uploadOrder) => ({
              pageId: candidate.comicCrawler!.pageId,
              sourceOrderIndex: candidate.comicCrawler!.sourceOrderIndex,
              uploadOrder,
              fileName: files[uploadOrder]!.name,
              sourceUrl: candidate.sourceUrl,
              ...(candidate.comicCrawler!.sourceFingerprint
                ? { sourceFingerprint: candidate.comicCrawler!.sourceFingerprint }
                : {}),
            })),
          }
        : undefined);
      setSourceProgress(null);
      setPhase('ready');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setPhase('ready');
        return;
      }
      setScanError(error);
      setPhase('error');
    } finally {
      sourceController.current = null;
    }
  };

  resumeTranslation.current = () => { void translate(true); };

  useEffect(() => {
    const listener = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)
        || message.type !== 'SOURCE_ORIGINS_GRANTED') return;
      const requestId = 'requestId' in message && typeof message.requestId === 'string' ? message.requestId : '';
      const pageUrl = 'pageUrl' in message && typeof message.pageUrl === 'string' ? message.pageUrl : '';
      const pending = pendingSourceAccessRef.current;
      if (!pending || pending.requestId !== requestId || pageWorkflowKey(pageUrl) !== pageWorkflowKey(location.href)) return;
      setOpen(true);
      setPendingSourceAccess(null);
      setOpeningSourceAccess(false);
      resumeTranslation.current();
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  const openSourceAccess = async () => {
    if (!pendingSourceAccess || openingSourceAccess) return;
    setOpeningSourceAccess(true);
    setScanError(null);
    try {
      await browser.runtime.sendMessage({
        type: 'OPEN_SOURCE_ORIGIN_ACCESS',
        requestId: pendingSourceAccess.requestId,
      });
    } catch (error) {
      setScanError(error instanceof Error ? error : new Error('source_access_open_failed'));
    } finally {
      setOpeningSourceAccess(false);
    }
  };

  const loadPassiveManifest = async (saved: StoredWorkflow): Promise<ChapterImageManifest> => {
    if (!crawler || !saved.comicCrawler?.chapterId) throw new Error('source_page_manifest_unavailable');
    let manifest = chapterManifest?.chapter.id === saved.comicCrawler.chapterId
      ? chapterManifest
      : await crawler.getChapterImageManifest(saved.comicCrawler.chapterId);
    if (!manifest) {
      manifest = await crawler.resolveChapterImageManifest(
        saved.comicCrawler.chapterUrl || saved.sourcePageUrl || location.href,
        saved.comicCrawler.adapterId,
      );
    }
    const compatibilityError = workflowManifestCompatibilityError(manifest, saved);
    if (compatibilityError) throw new Error(compatibilityError);
    setChapterManifest(manifest);
    return manifest!;
  };

  const observePassiveApplication = async (
    operationId: string,
    sourceManifest: ChapterImageManifest,
    applicator: PassiveTranslationApplicator,
    total: number,
  ): Promise<void> => {
    passiveApplicator.current = applicator;
    let scanTimer: number | null = null;
    let scanRunning = false;
    let scanAgain = false;
    let disposed = false;
    const pendingCandidates = new Map<string, PageImageCandidate>();
    const resolvedCandidateKeys = new Set<string>();
    const scan = async () => {
      if (disposed) return;
      if (scanRunning) { scanAgain = true; return; }
      scanRunning = true;
      try {
        const visible = await domBridge.detect(false, undefined, true);
        for (const candidate of visible.images) {
          if (candidate.loadStatus !== 'loaded' || !/^https?:\/\//i.test(candidate.sourceUrl)) continue;
          const key = `${candidate.id}\n${candidate.sourceUrl}`;
          if (!resolvedCandidateKeys.has(key)) pendingCandidates.set(key, candidate);
        }
        const pending = [...pendingCandidates.entries()].slice(0, 500);
        if (!pending.length) return;
        const resolution = await crawler!.resolveChapterImagePages(
          sourceManifest.chapter.id,
          pending.map(([, candidate]) => candidate.sourceUrl),
          sourceManifest.revision,
        );
        resolution.matches.forEach((match, index) => {
          const entry = pending[index];
          if (!entry) return;
          const [key, candidate] = entry;
          if (match.status === 'ambiguous') return;
          pendingCandidates.delete(key);
          resolvedCandidateKeys.add(key);
          if (match.status === 'matched') applicator.offerResolved(match.pageId, candidate);
        });
      } catch (error) {
        if (error instanceof ComicCrawlerError && error.status === 409) {
          applicator.stop(new Error('source_page_manifest_changed'));
        } else if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setScanError(error);
        }
      } finally {
        scanRunning = false;
        if (scanAgain && !disposed) { scanAgain = false; scheduleScan(); }
      }
    };
    const scheduleScan = () => {
      if (disposed || scanTimer !== null) return;
      scanTimer = window.setTimeout(() => {
        scanTimer = null;
        void scan();
      }, 100);
    };
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'data-src', 'data-lazy-src'],
    });
    window.addEventListener('scroll', scheduleScan, { passive: true });
    window.addEventListener('resize', scheduleScan, { passive: true });
    document.addEventListener('load', scheduleScan, true);
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      if (scanTimer !== null) window.clearTimeout(scanTimer);
      observer.disconnect();
      window.removeEventListener('scroll', scheduleScan);
      window.removeEventListener('resize', scheduleScan);
      document.removeEventListener('load', scheduleScan, true);
    };
    passiveApplyCleanup.current = cleanup;
    setInlineApplyProgress({ jobId: operationId, phase: 'applying', completed: 0, total });
    scheduleScan();
    await applicator.completion;
    cleanup();
    setPageApplied(true);
    setInlineApplyProgress({ jobId: operationId, phase: 'completed', completed: total, total });
  };

  const applyJobInline = (jobId: string, savedWorkflow = workflow.workflow): Promise<boolean> => {
    if (inlineApplyOperation.current) {
      if (inlineApplyOperation.current.jobId === jobId) return inlineApplyOperation.current.promise;
      return Promise.reject(new Error('inline_application_in_progress'));
    }
    const operation = (async () => {
      if (!backend || !savedWorkflow) throw new Error('source_page_mapping_incomplete');
      const saved = savedWorkflow;
      if (saved.jobId !== jobId) throw new Error('source_page_mapping_incomplete');
      const expectedCount = saved.fileNames.length;
      const passivePages = passiveSourcePagesForWorkflow(saved);
      if (!passivePages) throw new Error('source_page_manifest_unavailable');
      setInlineApplyProgress({ jobId, phase: 'preparing', completed: 0, total: expectedCount });
      try {
        const sourceManifest = await loadPassiveManifest(saved);
        const translatedManifest = await backend.getTranslatedImages(jobId);
        const translated = orderedTranslatedImages(translatedManifest, expectedCount);
        const translatedBySourceId = new Map(translated.map((image) => [image.sourceImageId, image]));
        if (translatedBySourceId.size !== passivePages.length) throw new Error('translated_images_contract_invalid');

        const applicator = new PassiveTranslationApplicator({
          pages: passivePages,
          concurrency: 2,
          resolveTranslatedUrl: async (sourceImageId) => {
            const image = translatedBySourceId.get(sourceImageId);
            if (!image) throw new Error('source_page_mapping_incomplete');
            return blobToDataUrl(await backend.downloadTranslatedImage(jobId, image));
          },
          apply: (candidate, url) => domBridge.apply(candidate, url),
          onProgress: ({ completed, total }) => {
            setInlineApplyProgress({ jobId, phase: 'applying', completed, total });
          },
        });
        // Inline replacements turn page image URLs into data URLs, while
        // ComicCrawler resolves the original HTTP(S) URLs. Restore the source
        // DOM immediately before applying a newer revision so the resolver can
        // find the same page elements without requiring a browser refresh.
        if (pageApplied) {
          await domBridge.restore();
          setPageApplied(false);
        }
        await observePassiveApplication(jobId, sourceManifest, applicator, expectedCount);
        return true;
      } catch (error) {
        await domBridge.restore();
        setPageApplied(false);
        if (error instanceof Error && error.name === 'AbortError') {
          setInlineApplyProgress(null);
          return false;
        }
        setInlineApplyProgress((current) => ({
          jobId,
          phase: 'failed',
          completed: current?.completed ?? 0,
          total: current?.total ?? expectedCount,
        }));
        throw error;
      }
    })().finally(() => {
      passiveApplyCleanup.current?.();
      passiveApplyCleanup.current = null;
      passiveApplicator.current = null;
      if (inlineApplyOperation.current?.promise === operation) inlineApplyOperation.current = null;
    });
    inlineApplyOperation.current = { jobId, promise: operation };
    return operation;
  };
  applyJobInlineRef.current = applyJobInline;

  const applyResolvedUrls = (pages: Array<{ sourceImageId: string; url: string }>): Promise<boolean> => {
    const saved = workflow.workflow;
    const operationId = `revision:${saved?.jobId ?? 'unknown'}`;
    if (inlineApplyOperation.current) {
      if (inlineApplyOperation.current.jobId === operationId) return inlineApplyOperation.current.promise;
      return Promise.reject(new Error('inline_application_in_progress'));
    }
    const operation = (async () => {
      if (!saved?.jobId || pages.some((page) => !page.url.startsWith('data:image/'))) {
        throw new Error('source_page_mapping_incomplete');
      }
      const passivePages = passiveSourcePagesForWorkflow(saved);
      const urlsBySourceId = new Map(pages.map((page) => [page.sourceImageId, page.url]));
      if (!passivePages || urlsBySourceId.size !== passivePages.length
        || passivePages.some((page) => !urlsBySourceId.has(page.sourceImageId))) {
        throw new Error('source_page_mapping_incomplete');
      }
      setInlineApplyProgress({ jobId: operationId, phase: 'preparing', completed: 0, total: passivePages.length });
      try {
        const sourceManifest = await loadPassiveManifest(saved);
        const applicator = new PassiveTranslationApplicator({
          pages: passivePages,
          concurrency: 2,
          resolveTranslatedUrl: async (sourceImageId) => urlsBySourceId.get(sourceImageId)!,
          apply: (candidate, url) => domBridge.apply(candidate, url),
          onProgress: ({ completed, total }) => {
            setInlineApplyProgress({ jobId: operationId, phase: 'applying', completed, total });
          },
        });
        await observePassiveApplication(operationId, sourceManifest, applicator, passivePages.length);
        return true;
      } catch (error) {
        await domBridge.restore();
        setPageApplied(false);
        if (error instanceof Error && error.name === 'AbortError') {
          setInlineApplyProgress(null);
          return false;
        }
        setInlineApplyProgress((current) => ({
          jobId: operationId,
          phase: 'failed',
          completed: current?.completed ?? 0,
          total: current?.total ?? passivePages.length,
        }));
        throw error;
      }
    })().finally(() => {
      passiveApplyCleanup.current?.();
      passiveApplyCleanup.current = null;
      passiveApplicator.current = null;
      if (inlineApplyOperation.current?.promise === operation) inlineApplyOperation.current = null;
    });
    inlineApplyOperation.current = { jobId: operationId, promise: operation };
    return operation;
  };
  applyResolvedUrlsRef.current = applyResolvedUrls;

  const applyPageRevisionManifestPassive = async (
    manifest: PageRevisionManifest,
    savedWorkflow = workflow.workflow,
  ): Promise<void> => {
    if (!backend || !savedWorkflow) throw new Error('source_page_mapping_incomplete');
    const passivePages = passiveSourcePagesForWorkflow(savedWorkflow);
    const activeBySourceId = new Map(manifest.pages.map((page) => [
      page.sourceImageId,
      page.revisions.find((revision) => revision.revisionId === page.activeRevisionId)
        ?? page.revisions.find((revision) => revision.active),
    ]));
    if (!passivePages || activeBySourceId.size !== passivePages.length
      || passivePages.some((page) => !activeBySourceId.get(page.sourceImageId))) {
      throw new Error('source_page_mapping_incomplete');
    }
    const operationId = `revision:${manifest.rootJobId}:${manifest.pages
      .map((page) => page.activeRevisionId ?? '')
      .join(',')}`;
    if (inlineApplyOperation.current) {
      if (inlineApplyOperation.current.jobId === operationId) {
        await inlineApplyOperation.current.promise;
        return;
      }
      throw new Error('inline_application_in_progress');
    }
    const operation = (async () => {
      setInlineApplyProgress({ jobId: operationId, phase: 'preparing', completed: 0, total: passivePages.length });
      try {
        const sourceManifest = await loadPassiveManifest(savedWorkflow);
        const applicator = new PassiveTranslationApplicator({
          pages: passivePages,
          concurrency: 2,
          resolveTranslatedUrl: async (sourceImageId) => {
            const revision = activeBySourceId.get(sourceImageId);
            if (!revision) throw new Error('source_page_mapping_incomplete');
            return blobToDataUrl(await backend.downloadPageRevisionImage(revision));
          },
          apply: (candidate, url) => domBridge.apply(candidate, url),
          onProgress: ({ completed, total }) => {
            setInlineApplyProgress({ jobId: operationId, phase: 'applying', completed, total });
          },
        });
        await observePassiveApplication(operationId, sourceManifest, applicator, passivePages.length);
        return true;
      } catch (error) {
        await domBridge.restore();
        setPageApplied(false);
        if (error instanceof Error && error.name === 'AbortError') {
          setInlineApplyProgress(null);
          return false;
        }
        setInlineApplyProgress((current) => ({
          jobId: operationId,
          phase: 'failed',
          completed: current?.completed ?? 0,
          total: current?.total ?? passivePages.length,
        }));
        throw error;
      }
    })().finally(() => {
      passiveApplyCleanup.current?.();
      passiveApplyCleanup.current = null;
      passiveApplicator.current = null;
      if (inlineApplyOperation.current?.promise === operation) inlineApplyOperation.current = null;
    });
    inlineApplyOperation.current = { jobId: operationId, promise: operation };
    await operation;
  };
  applyPageRevisionManifestRef.current = applyPageRevisionManifestPassive;

  useEffect(() => {
    const listener = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return undefined;
      let operation: Promise<boolean>;
      if (message.type === 'APPLY_TRANSLATION_JOB') {
        const jobId = 'jobId' in message && typeof message.jobId === 'string' ? message.jobId : '';
        if (!jobId) return Promise.resolve({ ok: false, error: 'source_page_mapping_incomplete' });
        // Popup and content-script React trees do not share in-memory state.
        // Read the workflow that the popup just persisted so a newly-created
        // correction Job can replace the page immediately, without waiting for
        // a tab refresh to hydrate the content script again.
        operation = loadWorkflow(location.href)
          .then((saved) => applyJobInlineRef.current(jobId, saved));
      } else if (message.type === 'APPLY_PAGE_REVISIONS') {
        const pages = 'pages' in message && Array.isArray(message.pages)
          ? message.pages.flatMap((page): Array<{ sourceImageId: string; url: string }> => {
              if (!page || typeof page !== 'object') return [];
              const value = page as { sourceImageId?: unknown; url?: unknown };
              return typeof value.sourceImageId === 'string' && typeof value.url === 'string'
                ? [{ sourceImageId: value.sourceImageId, url: value.url }]
                : [];
            })
          : [];
        operation = applyResolvedUrlsRef.current(pages);
      } else {
        return undefined;
      }
      return operation
        .then((applied) => ({ ok: applied, applied: applied ? 1 : 0 }))
        .catch((error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'inline_replacement_incomplete',
        }));
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    const saved = workflow.workflow;
    if (!settings?.comicCrawler.enabled || !settings.comicCrawler.autoApplyPreviousTranslation
      || monitor.job?.status !== 'succeeded' || !saved?.jobId || pageApplied
      || !passiveSourcePagesForWorkflow(saved) || workflowManifestCompatibilityError(chapterManifest, saved)) return;
    const attemptKey = `${sourcePageUrl}:${saved.jobId}:${chapterManifest?.revision ?? ''}`;
    if (passiveAutoApplyAttempt.current === attemptKey) return;
    passiveAutoApplyAttempt.current = attemptKey;
    void applyJobInlineRef.current(saved.jobId, saved).catch((error: unknown) => setScanError(error));
  }, [monitor.job?.status, pageApplied, settings?.comicCrawler.autoApplyPreviousTranslation,
    settings?.comicCrawler.enabled, sourcePageUrl, workflow.workflow, chapterManifest]);

  const restoreInline = async () => {
    passiveApplicator.current?.stop();
    passiveApplyCleanup.current?.();
    await domBridge.restore();
    setPageApplied(false);
    setInlineApplyProgress(null);
  };

  const beginFabDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const left = fabPosition?.x ?? (fabDock === 'left' ? 0 : Math.max(0, window.innerWidth - rect.width));
    const top = fabPosition?.y ?? rect.top;
    fabSize.current = { width: rect.width, height: rect.height };
    fabDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left,
      top,
      currentLeft: left,
      currentTop: top,
      width: rect.width,
      height: rect.height,
      moved: false,
    };
    setFabPosition({ x: left, y: top });
    event.currentTarget.setPointerCapture(event.pointerId);
    setFabDragging(true);
  };

  const moveFab = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = fabDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 4) drag.moved = true;
    drag.currentLeft = Math.max(0, Math.min(window.innerWidth - drag.width, drag.left + deltaX));
    drag.currentTop = Math.max(0, Math.min(window.innerHeight - drag.height, drag.top + deltaY));
    setFabPosition({ x: drag.currentLeft, y: drag.currentTop });
  };

  const endFabDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = fabDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressFabClick.current = drag.moved;
    const dock = drag.currentLeft + drag.width / 2 < window.innerWidth / 2 ? 'left' : 'right';
    setFabDock(dock);
    setFabPosition({
      x: dock === 'left' ? 0 : Math.max(0, window.innerWidth - drag.width),
      y: drag.currentTop,
    });
    fabDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setFabDragging(false);
  };

  const openTranslator = () => {
    if (suppressFabClick.current) {
      suppressFabClick.current = false;
      return;
    }
    setOpen(true);
    if (workflow.workflow?.jobId) {
      setPhase('ready');
      return;
    }
    if (pendingSourceAccess || storedWorkflowMappingReady || (result?.images.length && !workflow.workflow?.comicCrawler?.pages?.length)) {
      setPhase((current) => current === 'hidden' ? 'ready' : current);
      return;
    }
    void detect(true);
  };

  const closeTranslator = () => {
    setOpen(false);
    setPhase((current) => current === 'awaiting_source_permission'
      ? current
      : result?.images.length || result?.discoveryAvailable || result?.adapterStatus === 'matched' ? 'ready' : 'hidden');
  };

  const cancelPageTranslation = async () => {
    controller.current?.abort();
    sourceController.current?.abort();
    passiveApplyCleanup.current?.();
    passiveApplyCleanup.current = null;
    passiveApplicator.current?.stop();
    passiveApplicator.current = null;
    workflow.cancelUpload();
    const pendingRequestId = pendingSourceAccessRef.current?.requestId;
    if (pendingRequestId) {
      await browser.runtime.sendMessage({
        type: 'CLEAR_PENDING_SOURCE_ORIGINS',
        requestId: pendingRequestId,
      }).catch(() => undefined);
    }
    if (settings?.comicCrawler.enabled) {
      await browser.runtime.sendMessage({
        type: 'COMIC_CRAWLER_CHAPTER_IMAGES_CANCEL',
        url: location.href,
      }).catch(() => undefined);
    }
    setOpen(false);
    setResult(null);
    setScanError(null);
    setSourceProgress(null);
    setPendingSourceAccess(null);
    pendingSelection.current = null;
    setDragIndex(null);
    setPhase('ready');
    await workflow.reset();
  };

  if (!settings) return null;
  const crawlerPreparing = open && phase === 'scanning' && Boolean(crawler)
    && !workflow.preflight && !workflow.workflow?.jobId;

  return (
    <div className="koharu-page-root">
      {!open && (
        <button
          className={`koharu-fab dock-${fabDock}${fabDragging ? ' is-dragging' : ''}`}
          type="button"
          style={fabPosition ? { left: fabPosition.x, top: fabPosition.y, right: 'auto', bottom: 'auto' } : undefined}
          onPointerDown={beginFabDrag}
          onPointerMove={moveFab}
          onPointerUp={endFabDrag}
          onPointerCancel={endFabDrag}
          onClick={openTranslator}
        >
          <span aria-hidden="true">小</span>{phase === 'checking' ? t('detectingPageImages') : t('translateThisPage')}
        </button>
      )}
      {crawlerPreparing && (
        <section className="crawler-scan-toast" role="status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <strong>{t('scanningPageImages')}</strong>
          <button type="button" onClick={() => void cancelPageTranslation()}>{t('cancelPageTranslation')}</button>
        </section>
      )}
      {!open && inlineApplyProgress && (
        <section className={`inline-apply-toast state-${inlineApplyProgress.phase}`} role="status" aria-live="polite">
          {inlineApplyProgress.phase === 'preparing' && <><div className="spinner" aria-hidden="true" /><strong>{t('preparingPageApplication')}</strong></>}
          {inlineApplyProgress.phase === 'applying' && (
            <>
              <strong>{t('applyingPageImages', [String(inlineApplyProgress.completed), String(inlineApplyProgress.total)])}</strong>
              <progress max={Math.max(1, inlineApplyProgress.total)} value={inlineApplyProgress.completed} />
            </>
          )}
          {inlineApplyProgress.phase === 'completed' && <strong>{t('pageApplicationCompleted')}</strong>}
          {inlineApplyProgress.phase === 'failed' && <strong>{t('pageApplicationFailed')}</strong>}
        </section>
      )}
      {open && !crawlerPreparing && (
        <aside className="koharu-drawer" aria-label={t('pageTranslatorTitle')} ref={drawerRef}>
          <header>
            <div><small>{t('quickModeEyebrow')}</small><h1>{t('pageTranslatorTitle')}</h1></div>
            <div className="drawer-header-actions">
              {!workflow.workflow?.jobId && (
                <button className="cancel-page-button" type="button" onClick={() => void cancelPageTranslation()}>{t('cancelPageTranslation')}</button>
              )}
              <button className="close-page-button" type="button" onClick={closeTranslator} aria-label={t('closePageTranslator')}>×</button>
            </div>
          </header>

          {!workflow.preflight && !workflow.workflow?.jobId && (
            <section className="page-review">
              <p className="muted">{t('pageImageReviewDescription')}</p>
              {result?.adapter && <div className="notice notice-success">{t('adapterDetected', result.adapter.name || result.adapter.id)}</div>}
              {result && <AdapterDiscoveryPanel client={crawler} pageUrl={location.href} result={result} />}
              {result?.warnings.map((warning, index) => <div className="notice notice-waiting" key={index}>{optionalMessage(`warning_${warning}`) || warning}</div>)}
              <ErrorNotice error={scanError || workflow.error} />
              {phase === 'awaiting_source_permission' && pendingSourceAccess && (
                <div className="notice notice-waiting">
                  <span>{t('sourceAccessWaiting', String(pendingSourceAccess.origins.length))}</span>
                </div>
              )}
              {(phase === 'checking' || phase === 'scanning') && <div className="scan-state"><div className="spinner" />{t('scanningPageImages')}</div>}
              {images.length === 0 && !['checking', 'scanning'].includes(phase) && <div className="empty-state">{t('noPageImages')}</div>}
              <ol className="page-image-list">
                {images.map((image, index) => (
                  <li
                    key={image.id}
                    draggable={phase !== 'awaiting_source_permission'}
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => { if (dragIndex !== null) updateImages((current) => move(current, dragIndex, index)); setDragIndex(null); }}
                  >
                    <input type="checkbox" checked={image.selected} disabled={image.loadStatus !== 'loaded' || phase === 'awaiting_source_permission'} onChange={(event) => updateImages((current) => current.map((item) => item.id === image.id ? { ...item, selected: event.target.checked } : item))} />
                    <img src={image.sourceUrl} alt="" referrerPolicy="no-referrer" />
                    <span><strong>{image.fileName}</strong><small>{image.width ?? '?'} × {image.height ?? '?'} · {t(`imageLoad_${image.loadStatus}`)}</small></span>
                    <span className="order-actions"><button type="button" disabled={index === 0 || phase === 'awaiting_source_permission'} onClick={() => updateImages((current) => move(current, index, index - 1))}>↑</button><button type="button" disabled={index === images.length - 1 || phase === 'awaiting_source_permission'} onClick={() => updateImages((current) => move(current, index, index + 1))}>↓</button></span>
                  </li>
                ))}
              </ol>
              {sourceProgress && <div className="notice notice-neutral">{t('loadingPageSources', [String(sourceProgress[0]), String(sourceProgress[1])])}</div>}
              {workflow.progress && (
                <div className="progress-block"><progress max="100" value={workflow.progress.percent} /><div className="progress-copy"><span>{workflow.progress.fileName}</span><span>{workflow.progress.percent}%</span></div></div>
              )}
              <div className="button-row">
                {(phase === 'loading_sources' || ['checking', 'uploading', 'preflighting'].includes(workflow.phase)) && <button className="secondary-button danger-button" type="button" onClick={() => { sourceController.current?.abort(); workflow.cancelUpload(); }}>{t('cancelUpload')}</button>}
                {phase === 'awaiting_source_permission' && pendingSourceAccess
                  ? <button className="primary-button" type="button" disabled={openingSourceAccess} onClick={() => void openSourceAccess()}>{openingSourceAccess ? t('openingSourceAccess') : t('authorizeSourceAccessAndContinue')}</button>
                  : <button className="primary-button" type="button" disabled={!selected.length || ['scanning', 'loading_sources'].includes(phase) || ['checking', 'uploading', 'preflighting'].includes(workflow.phase)} onClick={() => void translate()}>{t('translateSelectedImages', String(selected.length))}</button>}
              </div>
            </section>
          )}

          {workflow.preflight && !workflow.workflow?.jobId && (
            <div className="content-stack">
              <PreflightReview preflight={workflow.preflight} onMove={workflow.moveImage} />
              <TranslationForm client={backend!} initial={workflow.workflow?.bindings} busy={workflow.phase === 'creating'} disabled={!workflow.preflight.ready || !workflow.preflight.images.length} onSubmit={(values) => void workflow.createJob(values)} />
            </div>
          )}

          {workflow.workflow?.jobId && backend && (
            <div className="job-stack">
              <JobPanel
              client={backend}
              jobId={workflow.workflow.jobId}
              job={monitor.job}
              events={monitor.events}
              artifacts={monitor.artifacts}
              transport={monitor.transport}
              monitorError={monitor.monitorError}
              sourcePageUrl={workflow.workflow.sourcePageUrl}
              selectedImageCount={workflow.workflow.fileNames.length}
              sourceImagePages={sourceImagePages}
              autoApplyInline={!workflow.restored}
              pageApplied={pageApplied}
              showPageNumbers={settings.showPageNumbers}
              canRequeue={Boolean(workflow.workflow.preflightId)}
              requeueBusy={workflow.phase === 'checking'}
              onReset={() => void workflow.reset()}
              onDiscardMissingJob={() => void workflow.discardMissingJob()}
              onJobReplaced={(jobId) => void workflow.replaceJob(jobId)}
              onRequeue={() => void workflow.requeueFromPreflight()}
              onApplyJob={applyJobInline}
              onRestoreInline={restoreInline}
              onPageAppliedChange={setPageApplied}
              onShowPageNumbersChange={setShowPageNumbers}
              qualityImprovementPanel={monitor.job?.status === 'succeeded' ? ({ openOcr, openBackground }) => (
                <ChapterOcrBatchPanel
                  client={backend}
                  jobId={monitor.job!.id}
                  batch={workflow.workflow?.chapterOcrBatch}
                  workspace={workflow.workflow?.textRegionWorkspace}
                  backgroundTasks={backgroundTasks}
                  loadOriginalImage={loadOriginalImage}
                  onBatchChange={(batch) => workflow.saveChapterOcrBatch(batch)}
                  onBackgroundJob={(job, kind, sourceImageIds) => workflow.addBackgroundJob(job, kind, sourceImageIds)}
                  onOpenOcr={openOcr}
                  onOpenBackground={openBackground}
                />
              ) : undefined}
              textRegionPanel={monitor.job?.status === 'succeeded' ? (
                <TextRegionInspectionPanel
                  client={backend}
                  jobId={monitor.job.id}
                  loadOriginalImage={loadOriginalImage}
                  lockedSourceImageIds={lockedSourceImageIds}
                  storedWorkspace={workflow.workflow.textRegionWorkspace}
                  onWorkspaceChange={(workspace) => void workflow.saveTextRegionWorkspace(workspace)}
                  onReviewJobCreated={(job, sourceImageIds) => void workflow.addBackgroundJob(job, 'ocr_text_review', sourceImageIds)}
                  onJobCreated={(job, sourceImageIds) => void workflow.addBackgroundJob(job, 'text_region_correction', sourceImageIds)}
                />
              ) : undefined}
              pageRevisionPanel={monitor.job?.status === 'succeeded' ? (
                <PageRevisionPanel
                  client={backend}
                  rootJobId={monitor.job.revision?.rootJobId ?? workflow.workflow.rootJobId ?? monitor.job.id}
                  parentJobId={monitor.job.id}
                  currentJob={monitor.job}
                  lockedSourceImageIds={lockedSourceImageIds}
                  onJobCreated={(job, sourceImageIds) => void workflow.addBackgroundJob(job, 'selective_retranslation', sourceImageIds)}
                  onApplied={chapterManifest && passiveSourcePagesForWorkflow(workflow.workflow)
                    ? (manifest) => applyPageRevisions(manifest)
                    : undefined}
                />
              ) : undefined}
              backgroundTaskCount={backgroundTasks.length}
              backgroundJobsPanel={(
                <BackgroundJobsPanel
                  client={backend}
                  tasks={backgroundTasks}
                  sourceImagePages={sourceImagePages}
                  onRemove={(jobId) => workflow.removeBackgroundTask(jobId)}
                />
              )}
              />
            </div>
          )}
          <ScrollControls
            containerRef={drawerRef}
            className="page-scroll-controls"
            label={t('pageScrollControls')}
          />
        </aside>
      )}
    </div>
  );
}
