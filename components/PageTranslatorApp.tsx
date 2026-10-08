import { useEffect, useMemo, useRef, useState } from 'react';
import { useJobMonitor } from '../hooks/useJobMonitor';
import { useSettings } from '../hooks/useSettings';
import { useTranslationWorkflow } from '../hooks/useTranslationWorkflow';
import { BackendClient } from '../lib/api/backend-client';
import { orderedTranslatedImages } from '../lib/artifacts/translated-images';
import { ComicCrawlerClient } from '../lib/comic-crawler/client';
import { ComicCrawlerDetector } from '../lib/page-images/comic-crawler-detector';
import type { PageDomBridge } from '../lib/page-images/bridge';
import { loadCandidateFiles, requiredSourceOrigins } from '../lib/page-images/source-loader';
import type { DetectionResult, PageImageCandidate } from '../lib/page-images/types';
import { optionalMessage, t } from '../lib/i18n';
import { findWorkflowForChapter, loadWorkflowHistory, pageWorkflowKey, workflowMatchesChapter } from '../lib/storage/workflow';
import { ErrorNotice } from './ErrorNotice';
import { AdapterDiscoveryPanel } from './AdapterDiscoveryPanel';
import { JobPanel } from './JobPanel';
import { PreflightReview } from './PreflightReview';
import { TranslationForm } from './TranslationForm';

type ScanPhase = 'checking' | 'ready' | 'scanning' | 'loading_sources' | 'hidden' | 'error';

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
  const backend = useMemo(() => settings ? new BackendClient(settings, { useBackgroundProxy: true }) : null, [settings]);
  const crawler = useMemo(
    () => settings?.comicCrawler.enabled ? new ComicCrawlerClient(settings.comicCrawler, { useBackgroundProxy: true }) : null,
    [settings],
  );
  const workflow = useTranslationWorkflow(backend, sourcePageUrl);
  const monitor = useJobMonitor(backend, workflow.workflow?.jobId ?? null);

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
      const domPromise = domBridge.detect(deep, nextController.signal);
      const crawlerResult = crawler
        ? await new ComicCrawlerDetector(crawler).detect(location.href, { signal: nextController.signal })
        : null;
      const domResult = await domPromise;
      const finalResult = crawlerResult ? mergeFallback(crawlerResult, domResult) : domResult;
      setResult(finalResult);
      setPhase(finalResult.images.length || finalResult.discoveryAvailable ? 'ready' : 'hidden');
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
    const lookupKey = `${sourcePageUrl}\n${result.chapterUrl}`;
    if (crawlerHistoryLookup.current === lookupKey) return;
    if (workflow.phase === 'loading') return;
    crawlerHistoryLookup.current = lookupKey;
    let disposed = false;
    void (async () => {
      const history = await loadWorkflowHistory();
      const current = workflow.workflow?.jobId
        && workflowMatchesChapter(workflow.workflow, sourcePageUrl, result.chapterUrl!)
        ? workflow.workflow
        : null;
      const previous = current ?? findWorkflowForChapter(history, sourcePageUrl, result.chapterUrl!);
      if (disposed || !previous?.jobId) return;
      if (workflow.workflow?.jobId !== previous.jobId) await workflow.resumeWorkflow(previous);
      if (!settings.comicCrawler.autoApplyPreviousTranslation
        || crawlerAutoApplyAttempt.current === previous.jobId || !backend) return;
      crawlerAutoApplyAttempt.current = previous.jobId;
      const job = await backend.getJob(previous.jobId);
      if (job.status !== 'succeeded') return;
      const candidates = result.images.filter((image) => image.selected && image.loadStatus === 'loaded');
      const expectedCount = previous.fileNames.length;
      if (!expectedCount || candidates.length !== expectedCount) throw new Error('artifact_image_count_mismatch');
      const manifest = await backend.getTranslatedImages(previous.jobId);
      const images = orderedTranslatedImages(manifest, expectedCount);
      const blobs = await Promise.all(images.map((image) => backend.downloadTranslatedImage(previous.jobId!, image)));
      const urls = await Promise.all(blobs.map((blob) => new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => resolve(String(reader.result)));
        reader.addEventListener('error', () => reject(reader.error ?? new Error('artifact_read_failed')));
        reader.readAsDataURL(blob);
      })));
      for (let index = 0; index < candidates.length; index += 1) {
        if (!await domBridge.apply(candidates[index]!, urls[index]!)) {
          await domBridge.restore();
          throw new Error('inline_replacement_incomplete');
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

  const images = result?.images ?? [];
  const selected = images.filter((image) => image.selected && image.loadStatus === 'loaded');

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
      await workflow.startUpload(files, true, result?.detector === 'comic_crawler' && result.chapterUrl && result.adapter
        ? { adapterId: result.adapter.id, chapterUrl: result.chapterUrl }
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
        <aside className="koharu-drawer" aria-label={t('pageTranslatorTitle')}>
          <header>
            <div><small>{t('quickModeEyebrow')}</small><h1>{t('pageTranslatorTitle')}</h1></div>
            <button type="button" onClick={() => setOpen(false)} aria-label={t('closePageTranslator')}>×</button>
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
            <JobPanel
              client={backend}
              jobId={workflow.workflow.jobId}
              job={monitor.job}
              events={monitor.events}
              artifacts={monitor.artifacts}
              transport={monitor.transport}
              monitorError={monitor.monitorError}
              uploadId={workflow.workflow.uploadId}
              uploadDeleted={Boolean(workflow.workflow.uploadDeletedAt)}
              sourcePageUrl={workflow.workflow.sourcePageUrl}
              selectedImageCount={selected.length}
              autoApplyInline={!workflow.restored}
              canRequeue={Boolean(workflow.workflow.preflightId) && !workflow.workflow.uploadDeletedAt}
              requeueBusy={workflow.phase === 'checking'}
              onReset={() => void workflow.reset()}
              onJobReplaced={(jobId) => void workflow.replaceJob(jobId)}
              onRequeue={() => void workflow.requeueFromPreflight()}
              onUploadDeleted={() => void workflow.markUploadDeleted()}
              onApplyInline={selected.length ? applyInline : undefined}
              onRestoreInline={selected.length ? restoreInline : undefined}
            />
          )}
        </aside>
      )}
    </div>
  );
}
