import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useJobMonitor } from '../hooks/useJobMonitor';
import { useSettings } from '../hooks/useSettings';
import { useTranslationWorkflow } from '../hooks/useTranslationWorkflow';
import { BackendClient } from '../lib/api/backend-client';
import { BackendApiError } from '../lib/api/errors';
import type { PageRevisionManifest } from '../lib/api/types';
import { orderedTranslatedImages } from '../lib/artifacts/translated-images';
import { ComicCrawlerClient } from '../lib/comic-crawler/client';
import { ComicCrawlerDetector } from '../lib/page-images/comic-crawler-detector';
import type { PageDomBridge } from '../lib/page-images/bridge';
import { loadCandidateFiles, requiredSourceOrigins } from '../lib/page-images/source-loader';
import type { DetectionResult, PageImageCandidate } from '../lib/page-images/types';
import { candidatesForStoredWorkflow } from '../lib/page-images/workflow-mapping';
import { optionalMessage, t } from '../lib/i18n';
import { findWorkflowForChapter, loadWorkflowHistory, pageWorkflowKey, workflowMatchesChapter } from '../lib/storage/workflow';
import { ErrorNotice } from './ErrorNotice';
import { AdapterDiscoveryPanel } from './AdapterDiscoveryPanel';
import { JobPanel } from './JobPanel';
import { PageRevisionPanel } from './PageRevisionPanel';
import { ScrollControls } from './ScrollControls';
import { TextRegionInspectionPanel } from './TextRegionInspectionPanel';
import { PreflightReview } from './PreflightReview';
import { TranslationForm } from './TranslationForm';

type ScanPhase = 'checking' | 'ready' | 'scanning' | 'loading_sources' | 'hidden' | 'error';
const CRAWLER_RESOLVE_TIMEOUT_MS = 5_000;
// ComicCrawler's existing-tab content preparation can legitimately use most of
// its 30-second browser command budget. Leave enough time for the Server to
// return its real result or diagnostic instead of racing it at the same limit.
const CRAWLER_EXTRACTION_TIMEOUT_MS = 45_000;

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
  const { settings } = useSettings();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<ScanPhase>('checking');
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [scanError, setScanError] = useState<unknown>(null);
  const [sourceProgress, setSourceProgress] = useState<[number, number] | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [fabPosition, setFabPosition] = useState<{ x: number; y: number } | null>(null);
  const [fabDock, setFabDock] = useState<'left' | 'right'>('left');
  const [fabDragging, setFabDragging] = useState(false);
  const fabDrag = useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number; currentLeft: number; currentTop: number; width: number; height: number; moved: boolean } | null>(null);
  const fabSize = useRef({ width: 0, height: 0 });
  const suppressFabClick = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const sourceController = useRef<AbortController | null>(null);
  const crawlerHistoryLookup = useRef<string | null>(null);
  const crawlerAutoApplyAttempt = useRef<string | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const backend = useMemo(() => settings ? new BackendClient(settings, { useBackgroundProxy: true }) : null, [settings]);
  const crawler = useMemo(
    () => settings?.comicCrawler.enabled ? new ComicCrawlerClient(settings.comicCrawler, { useBackgroundProxy: true }) : null,
    [settings],
  );
  const workflow = useTranslationWorkflow(backend, sourcePageUrl);
  const monitor = useJobMonitor(backend, workflow.workflow?.jobId ?? null, workflow.discardMissingJob);
  const images = result?.images ?? [];
  const selected = images.filter((image) => image.selected && image.loadStatus === 'loaded');

  const loadOriginalImage = useCallback(async (sourceImageId: string, signal?: AbortSignal): Promise<Blob> => {
    const saved = workflow.workflow;
    if (!saved || !result?.images.length) throw new Error('source_page_mapping_incomplete');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const candidates = candidatesForStoredWorkflow(result.images, saved);
    const sourceImages = [...(saved.sourceImages ?? [])].sort((left, right) => left.uploadOrder - right.uploadOrder);
    const sourceIndex = sourceImages.findIndex((source) => source.sourceImageId === sourceImageId);
    const candidate = candidates[sourceIndex];
    if (sourceIndex < 0 || !candidate) throw new Error('source_page_mapping_incomplete');
    if (candidate.sourceUrl.startsWith('canvas:')) return domBridge.snapshotCanvas(candidate);
    const [file] = await loadCandidateFiles([candidate], signal);
    if (!file) throw new Error('page_image_fetch_failed');
    return file;
  }, [domBridge, result, workflow.workflow]);

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

  const applyPageRevisions = async (manifest: PageRevisionManifest, saved = workflow.workflow) => {
    if (!backend || !saved || !result?.images.length) throw new Error('source_page_mapping_incomplete');
    const candidates = candidatesForStoredWorkflow(result.images, saved);
    const sourceImages = [...(saved.sourceImages ?? [])].sort((left, right) => left.uploadOrder - right.uploadOrder);
    const candidateBySourceId = new Map(sourceImages.map((source, index) => [source.sourceImageId, candidates[index]]));
    const pages = [...manifest.pages].sort((left, right) => left.sourceOrderIndex - right.sourceOrderIndex);
    if (pages.length !== candidates.length) throw new Error('artifact_image_count_mismatch');
    const targets = pages.map((page) => {
      const revision = page.revisions.find((item) => item.revisionId === page.activeRevisionId)
        ?? page.revisions.find((item) => item.active);
      const candidate = candidateBySourceId.get(page.sourceImageId);
      if (!revision || !candidate) throw new Error('source_page_mapping_incomplete');
      return { revision, candidate };
    });
    const blobs = await Promise.all(targets.map(({ revision }) => backend.downloadPageRevisionImage(revision)));
    const urls = await Promise.all(blobs.map(blobToDataUrl));
    for (let index = 0; index < targets.length; index += 1) {
      if (!await domBridge.apply(targets[index]!.candidate, urls[index]!)) {
        await domBridge.restore();
        throw new Error('inline_replacement_incomplete');
      }
    }
  };

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

  const detect = async (deep: boolean) => {
    if (!settings) return;
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
            timeoutMs: deep ? CRAWLER_EXTRACTION_TIMEOUT_MS : CRAWLER_RESOLVE_TIMEOUT_MS,
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
      };

      if (deep && crawlerPromise) {
        // The Browser Client and the DOM detector both prepare lazy content by
        // scrolling the real page. Running them concurrently causes competing
        // scroll restoration and previously mislabeled a healthy, slower
        // ComicCrawler request as unavailable whenever DOM detection won.
        const crawlerResult = await crawlerPromise;
        if (crawlerResult.images.length) {
          publish(crawlerResult);
          return;
        }
        const domResult = await domBridge.detect(true, nextController.signal);
        publish(mergeFallback(crawlerResult, domResult));
        return;
      }

      const domPromise = domBridge.detect(deep, nextController.signal);
      const [domResult, crawlerResult] = await Promise.all([domPromise, crawlerPromise ?? Promise.resolve(null)]);
      publish(crawlerResult ? mergeFallback(crawlerResult, domResult) : domResult);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setScanError(error);
      setPhase('error');
    }
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
      if (!settings.comicCrawler.autoApplyPreviousTranslation
        || crawlerAutoApplyAttempt.current === previous.jobId || !backend) return;
      crawlerAutoApplyAttempt.current = previous.jobId;
      const job = await backend.getJob(previous.jobId);
      if (job.status !== 'succeeded') return;
      try {
        const revisions = await backend.getPageRevisions(previous.rootJobId ?? previous.jobId);
        await applyPageRevisions(revisions, previous);
      } catch (error) {
        if (!(error instanceof BackendApiError) || error.status !== 404) throw error;
        const candidates = candidatesForStoredWorkflow(result.images, previous);
        const expectedCount = previous.fileNames.length;
        if (!expectedCount || candidates.length !== expectedCount) throw new Error('artifact_image_count_mismatch');
        const manifest = await backend.getTranslatedImages(previous.jobId);
        const translated = orderedTranslatedImages(manifest, expectedCount);
        const blobs = await Promise.all(translated.map((image) => backend.downloadTranslatedImage(previous.jobId!, image)));
        const urls = await Promise.all(blobs.map(blobToDataUrl));
        for (let index = 0; index < candidates.length; index += 1) {
          if (!await domBridge.apply(candidates[index]!, urls[index]!)) {
            await domBridge.restore();
            throw new Error('inline_replacement_incomplete');
          }
        }
      }
    })().catch((error: unknown) => {
      if (!disposed) setScanError(error);
    });
    return () => { disposed = true; };
  }, [backend, domBridge, result, settings?.comicCrawler.enabled, settings?.comicCrawler.autoApplyPreviousTranslation, sourcePageUrl, workflow.phase, workflow.workflow, workflow.resumeWorkflow]);

  useEffect(() => {
    crawlerHistoryLookup.current = null;
    crawlerAutoApplyAttempt.current = null;
  }, [sourcePageUrl]);

  useEffect(() => { void domBridge.setLayout(open, phase !== 'hidden'); }, [domBridge, open, phase]);

  const updateImages = (updater: (current: PageImageCandidate[]) => PageImageCandidate[]) => {
    setResult((current) => current ? { ...current, images: updater(current.images).map((image, order) => ({ ...image, order })) } : current);
  };

  const translate = async () => {
    if (!selected.length) return;
    setScanError(null);
    setPhase('loading_sources');
    const loadController = new AbortController();
    sourceController.current = loadController;
    try {
      const canvasSelected = selected.filter((candidate) => candidate.sourceUrl.startsWith('canvas:'));
      const urlSelected = selected.filter((candidate) => !candidate.sourceUrl.startsWith('canvas:'));
      const origins = await requiredSourceOrigins(urlSelected);
      if (origins.length) {
        const access = await browser.runtime.sendMessage({ type: 'CHECK_SOURCE_ORIGINS', origins }) as { granted?: boolean } | undefined;
        if (!access?.granted) throw new Error('source_host_permission_required');
      }
      const filesById = new Map<string, File>();
      if (urlSelected.length) {
        const loaded = await loadCandidateFiles(
          urlSelected,
          loadController.signal,
          (current) => setSourceProgress([current, selected.length]),
        );
        urlSelected.forEach((candidate, index) => filesById.set(candidate.id, loaded[index]!));
      }
      for (let index = 0; index < canvasSelected.length; index += 1) {
        if (loadController.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const candidate = canvasSelected[index]!;
        filesById.set(candidate.id, await domBridge.snapshotCanvas(candidate));
        setSourceProgress([urlSelected.length + index + 1, selected.length]);
      }
      const files = selected.map((candidate) => filesById.get(candidate.id)!).filter(Boolean);
      if (files.length !== selected.length) throw new Error('page_image_fetch_failed');
      await workflow.startUpload(files, true, result?.detector === 'comic_crawler' && result.chapterUrl
        && result.chapterIdentity && result.adapter
        ? {
            adapterId: result.adapter.id,
            chapterUrl: result.chapterUrl,
            chapterId: result.chapterIdentity.id,
            canonicalUrl: result.chapterIdentity.canonicalUrl,
            pages: selected.map((candidate, uploadOrder) => ({
              pageId: candidate.comicCrawler!.pageId,
              sourceOrderIndex: candidate.comicCrawler!.sourceOrderIndex,
              uploadOrder,
              fileName: files[uploadOrder]!.name,
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

  const applyInline = async (urls: string[]) => {
    if (urls.length !== selected.length) return false;
    for (let index = 0; index < selected.length; index += 1) {
      if (!await domBridge.apply(selected[index]!, urls[index]!)) {
        await domBridge.restore();
        throw new Error('inline_replacement_incomplete');
      }
    }
    return true;
  };

  const restoreInline = () => {
    void domBridge.restore();
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
    void detect(true);
  };

  const closeTranslator = () => {
    controller.current?.abort();
    setOpen(false);
    setPhase(result?.images.length || result?.discoveryAvailable || result?.adapterStatus === 'matched' ? 'ready' : 'hidden');
  };

  const cancelPageTranslation = async () => {
    controller.current?.abort();
    sourceController.current?.abort();
    workflow.cancelUpload();
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
    setDragIndex(null);
    setPhase('ready');
    await workflow.reset();
  };

  if (!settings) return null;

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
      {open && (
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
              {(phase === 'checking' || phase === 'scanning') && <div className="scan-state"><div className="spinner" />{t('scanningPageImages')}</div>}
              {images.length === 0 && !['checking', 'scanning'].includes(phase) && <div className="empty-state">{t('noPageImages')}</div>}
              <ol className="page-image-list">
                {images.map((image, index) => (
                  <li
                    key={image.id}
                    draggable
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => { if (dragIndex !== null) updateImages((current) => move(current, dragIndex, index)); setDragIndex(null); }}
                  >
                    <input type="checkbox" checked={image.selected} disabled={image.loadStatus !== 'loaded'} onChange={(event) => updateImages((current) => current.map((item) => item.id === image.id ? { ...item, selected: event.target.checked } : item))} />
                    <img src={image.sourceUrl} alt="" referrerPolicy="no-referrer" />
                    <span><strong>{image.fileName}</strong><small>{image.width ?? '?'} × {image.height ?? '?'} · {t(`imageLoad_${image.loadStatus}`)}</small></span>
                    <span className="order-actions"><button type="button" disabled={index === 0} onClick={() => updateImages((current) => move(current, index, index - 1))}>↑</button><button type="button" disabled={index === images.length - 1} onClick={() => updateImages((current) => move(current, index, index + 1))}>↓</button></span>
                  </li>
                ))}
              </ol>
              {sourceProgress && <div className="notice notice-neutral">{t('loadingPageSources', [String(sourceProgress[0]), String(sourceProgress[1])])}</div>}
              {workflow.progress && (
                <div className="progress-block"><progress max="100" value={workflow.progress.percent} /><div className="progress-copy"><span>{workflow.progress.fileName}</span><span>{workflow.progress.percent}%</span></div></div>
              )}
              <div className="button-row">
                {(phase === 'loading_sources' || ['checking', 'uploading', 'preflighting'].includes(workflow.phase)) && <button className="secondary-button danger-button" type="button" onClick={() => { sourceController.current?.abort(); workflow.cancelUpload(); }}>{t('cancelUpload')}</button>}
                <button className="primary-button" type="button" disabled={!selected.length || ['scanning', 'loading_sources'].includes(phase) || ['checking', 'uploading', 'preflighting'].includes(workflow.phase)} onClick={() => void translate()}>{t('translateSelectedImages', String(selected.length))}</button>
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
              selectedImageCount={selected.length}
              autoApplyInline={!workflow.restored && !monitor.job?.revision}
              canRequeue={Boolean(workflow.workflow.preflightId)}
              requeueBusy={workflow.phase === 'checking'}
              onReset={() => void workflow.reset()}
              onDiscardMissingJob={() => void workflow.discardMissingJob()}
              onJobReplaced={(jobId) => void workflow.replaceJob(jobId)}
              onRequeue={() => void workflow.requeueFromPreflight()}
              onApplyInline={selected.length && !monitor.job?.revision ? applyInline : undefined}
              onRestoreInline={selected.length ? restoreInline : undefined}
              textRegionPanel={monitor.job?.status === 'succeeded' ? (
                <TextRegionInspectionPanel
                  client={backend}
                  jobId={monitor.job.id}
                  loadOriginalImage={loadOriginalImage}
                  onJobCreated={(job) => void workflow.replaceJob(job.id, job.revision?.rootJobId, job.revision?.parentJobId)}
                />
              ) : undefined}
              pageRevisionPanel={monitor.job?.status === 'succeeded' ? (
                <PageRevisionPanel
                  client={backend}
                  rootJobId={monitor.job.revision?.rootJobId ?? workflow.workflow.rootJobId ?? monitor.job.id}
                  parentJobId={monitor.job.id}
                  currentJob={monitor.job}
                  onJobCreated={(job) => void workflow.replaceJob(job.id, job.revision?.rootJobId, job.revision?.parentJobId)}
                  onApplied={result?.images.length ? (manifest) => applyPageRevisions(manifest) : undefined}
                />
              ) : undefined}
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
