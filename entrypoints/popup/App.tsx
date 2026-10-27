import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorNotice } from '../../components/ErrorNotice';
import { JobPanel } from '../../components/JobPanel';
import { PageRevisionPanel } from '../../components/PageRevisionPanel';
import { TextRegionInspectionPanel } from '../../components/TextRegionInspectionPanel';
import { JobHistory } from '../../components/JobHistory';
import { PageAccessPanel } from '../../components/PageAccessPanel';
import { ScrollControls } from '../../components/ScrollControls';
import { PreflightReview } from '../../components/PreflightReview';
import { SettingsPanel } from '../../components/SettingsPanel';
import { TranslationForm } from '../../components/TranslationForm';
import { useJobMonitor } from '../../hooks/useJobMonitor';
import { useSettings } from '../../hooks/useSettings';
import { useTranslationWorkflow } from '../../hooks/useTranslationWorkflow';
import { BackendClient } from '../../lib/api/backend-client';
import type { PageRevisionManifest } from '../../lib/api/types';
import { ComicCrawlerClient } from '../../lib/comic-crawler/client';
import { dataUrlToBlob } from '../../lib/data-url';
import { t } from '../../lib/i18n';
import { pageWorkflowKey } from '../../lib/storage/workflow';

export function App() {
  const scrollContainerRef = useRef<HTMLElement>(null);
  const { settings, save } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activePage, setActivePage] = useState<{ resolved: boolean; tabId?: number; url?: string }>({ resolved: false });
  const [activePageApplied, setActivePageApplied] = useState(false);
  const client = useMemo(() => settings ? new BackendClient(settings) : null, [settings]);
  const crawler = useMemo(
    () => settings?.comicCrawler.enabled ? new ComicCrawlerClient(settings.comicCrawler, { useBackgroundProxy: true }) : null,
    [settings],
  );
  const [crawlerCheck, setCrawlerCheck] = useState<'idle' | 'checking' | 'ready' | 'unavailable'>('idle');
  const scopedClient = activePage.resolved ? client : null;
  const workflow = useTranslationWorkflow(scopedClient, activePage.url);
  const monitor = useJobMonitor(scopedClient, workflow.workflow?.jobId ?? null, workflow.discardMissingJob);
  const checkedClient = useRef<BackendClient | null>(null);

  useEffect(() => {
    void (async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      let url: string | undefined;
      if (tab?.url) {
        try {
          const parsed = new URL(tab.url);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = pageWorkflowKey(tab.url);
        } catch { /* Unsupported browser URL. */ }
      }
      setActivePage({ resolved: true, tabId: tab?.id, url });
    })();
  }, []);

  useEffect(() => {
    setActivePageApplied(false);
    if (activePage.tabId === undefined || !activePage.url) return;
    let disposed = false;
    void browser.tabs.sendMessage(activePage.tabId, { type: 'GET_PAGE_TRANSLATION_STATE' })
      .then((response: { applied?: boolean } | undefined) => {
        if (!disposed) setActivePageApplied(response?.applied === true);
      })
      .catch(() => {
        if (!disposed) setActivePageApplied(false);
      });
    const listener = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)
        || message.type !== 'PAGE_TRANSLATION_STATE_CHANGED') return;
      const value = message as { url?: unknown; applied?: unknown };
      if (typeof value.url !== 'string' || typeof value.applied !== 'boolean') return;
      try {
        if (pageWorkflowKey(value.url) === activePage.url) setActivePageApplied(value.applied);
      } catch { /* Ignore malformed page URLs. */ }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => {
      disposed = true;
      browser.runtime.onMessage.removeListener(listener);
    };
  }, [activePage.tabId, activePage.url]);

  useEffect(() => {
    if (!client || workflow.phase === 'loading' || checkedClient.current === client) return;
    checkedClient.current = client;
    void workflow.refreshAvailability();
  }, [client, workflow.phase, workflow.refreshAvailability]);

  const checkCrawler = useCallback(async () => {
    if (!crawler) {
      setCrawlerCheck('idle');
      return;
    }
    setCrawlerCheck('checking');
    try {
      setCrawlerCheck(await crawler.status() ? 'ready' : 'unavailable');
    } catch {
      setCrawlerCheck('unavailable');
    }
  }, [crawler]);

  useEffect(() => { void checkCrawler(); }, [checkCrawler]);

  useEffect(() => {
    if (!crawler || !activePage.resolved || !activePage.url) return;
    void browser.runtime.sendMessage({ type: 'COMIC_CRAWLER_BROWSER_PREPARE_TAB' }).catch(() => {
      // ComicCrawler remains optional. The on-page translator reports an
      // actionable warning and uses DOM detection if preparation still fails.
    });
  }, [activePage.resolved, activePage.url, crawler]);

  const applyToActivePage = useCallback(async (jobId: string) => {
    if (activePage.tabId === undefined || !activePage.url) return false;
    const apply = async () => await browser.tabs.sendMessage(activePage.tabId!, {
      type: 'APPLY_TRANSLATION_JOB',
      jobId,
      expectedCount: workflow.workflow?.fileNames.length ?? 0,
    }) as { ok?: boolean; error?: string } | undefined;
    let response: { ok?: boolean; error?: string } | undefined;
    try {
      response = await apply();
    } catch {
      await browser.scripting.executeScript({
        target: { tabId: activePage.tabId },
        files: ['/content-scripts/page-translator.js'],
      });
      response = await apply();
    }
    if (!response?.ok) throw new Error(response?.error || 'inline_replacement_incomplete');
    setActivePageApplied(true);
    return true;
  }, [activePage.tabId, activePage.url, workflow.workflow?.fileNames.length]);

  const loadOriginalFromActivePage = useCallback(async (sourceImageId: string, signal?: AbortSignal): Promise<Blob> => {
    if (activePage.tabId === undefined || !activePage.url) throw new Error('source_page_mapping_incomplete');
    const request = async () => await browser.tabs.sendMessage(activePage.tabId!, {
      type: 'GET_ORIGINAL_PAGE_IMAGE',
      sourceImageId,
    }) as { ok?: boolean; dataUrl?: string; error?: string } | undefined;
    let response: { ok?: boolean; dataUrl?: string; error?: string } | undefined;
    try {
      response = await request();
    } catch {
      await browser.scripting.executeScript({
        target: { tabId: activePage.tabId },
        files: ['/content-scripts/page-translator.js'],
      });
      response = await request();
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!response?.ok || !response.dataUrl) throw new Error(response?.error || 'page_image_fetch_failed');
    return dataUrlToBlob(response.dataUrl);
  }, [activePage.tabId, activePage.url]);

  const applyRevisionsToActivePage = useCallback(async (manifest: PageRevisionManifest) => {
    if (activePage.tabId === undefined || !activePage.url || !client) return;
    const pages = [...manifest.pages]
      .sort((left, right) => left.sourceOrderIndex - right.sourceOrderIndex)
      .map((page) => ({
        sourceImageId: page.sourceImageId,
        revision: page.revisions.find((revision) => revision.revisionId === page.activeRevisionId)
          ?? page.revisions.find((revision) => revision.active),
      }));
    if (pages.some((page) => !page.revision)) throw new Error('source_page_mapping_incomplete');
    const blobs = await Promise.all(pages.map((page) => client.downloadPageRevisionImage(page.revision!)));
    const urls = await Promise.all(blobs.map((blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result)));
      reader.addEventListener('error', () => reject(reader.error ?? new Error('artifact_read_failed')));
      reader.readAsDataURL(blob);
    })));
    const send = async () => await browser.tabs.sendMessage(activePage.tabId!, {
      type: 'APPLY_PAGE_REVISIONS',
      pages: pages.map((page, index) => ({ sourceImageId: page.sourceImageId, url: urls[index] })),
    }) as { ok?: boolean; error?: string } | undefined;
    let response: { ok?: boolean; error?: string } | undefined;
    try {
      response = await send();
    } catch {
      await browser.scripting.executeScript({
        target: { tabId: activePage.tabId },
        files: ['/content-scripts/page-translator.js'],
      });
      response = await send();
    }
    if (!response?.ok) throw new Error(response?.error || 'inline_replacement_incomplete');
    setActivePageApplied(true);
  }, [activePage.tabId, activePage.url, client]);

  const restoreActivePage = useCallback(async () => {
    if (activePage.tabId === undefined) return;
    const response = await browser.tabs.sendMessage(activePage.tabId, { type: 'RESTORE_PAGE_IMAGES' }) as { ok?: boolean } | undefined;
    if (!response?.ok) throw new Error('inline_restore_failed');
    setActivePageApplied(false);
  }, [activePage.tabId]);

  if (!settings || !client) {
    return <main className="app-shell loading-shell"><div className="spinner" /><span>{t('loadingExtension')}</span></main>;
  }

  const connectionState = workflow.runtime?.backend.status === 'ready' && workflow.runtime?.koharu.status === 'running';

  return (
    <main className="app-shell" ref={scrollContainerRef}>
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true"><span>小</span></div>
        <div className="brand-copy">
          <h1>{t('extensionName')}</h1>
          <span>{t('extensionTagline')}</span>
        </div>
        <button className="icon-button settings-button" type="button" onClick={() => setSettingsOpen((open) => !open)} aria-label={t('openSettings')}>⚙</button>
      </header>
      <PageAccessPanel />

      {settingsOpen ? (
        <SettingsPanel settings={settings} onSave={save} onClose={() => setSettingsOpen(false)} />
      ) : (
        <>
          <div className="connection-strip">
            <span className={`connection-dot ${connectionState ? 'online' : ''}`} />
            <span>{connectionState ? t('backendReady') : workflow.phase === 'checking' ? t('checkingBackend') : t('backendNotChecked')}</span>
            <button type="button" onClick={() => void workflow.refreshAvailability()} disabled={workflow.phase === 'checking'}>{t('checkConnection')}</button>
          </div>
          {crawler && (
            <div className="connection-strip">
              <span className={`connection-dot ${crawlerCheck === 'ready' ? 'online' : ''}`} />
              <span>{crawlerCheck === 'ready' ? t('comicCrawlerReady') : crawlerCheck === 'checking' ? t('checkingComicCrawler') : crawlerCheck === 'unavailable' ? t('comicCrawlerUnavailable') : t('comicCrawlerNotChecked')}</span>
              {crawlerCheck === 'checking' && <span className="connection-spinner" aria-hidden="true" />}
              <button type="button" onClick={() => void checkCrawler()} disabled={crawlerCheck === 'checking'}>{t('checkConnection')}</button>
            </div>
          )}

          {workflow.workflow && (
            <details className="resume-details">
              <summary>{t('workflowIdentifiers')}</summary>
              <dl>
                <div><dt>{t('uploadIdLabel')}</dt><dd>{workflow.workflow.uploadId}</dd></div>
                {workflow.workflow.preflightId && <div><dt>{t('preflightIdLabel')}</dt><dd>{workflow.workflow.preflightId}</dd></div>}
                {workflow.workflow.jobId && <div><dt>{t('jobIdLabel')}</dt><dd>{workflow.workflow.jobId}</dd></div>}
                {workflow.workflow.rootJobId && <div><dt>{t('rootJobIdLabel')}</dt><dd>{workflow.workflow.rootJobId}</dd></div>}
              </dl>
            </details>
          )}

          <ErrorNotice error={workflow.error} />

          {workflow.workflow?.jobId ? (
            <div className="job-stack">
              <JobPanel
              client={client}
              jobId={workflow.workflow.jobId}
              job={monitor.job}
              events={monitor.events}
              artifacts={monitor.artifacts}
              transport={monitor.transport}
              monitorError={monitor.monitorError}
              sourcePageUrl={workflow.workflow.sourcePageUrl}
              selectedImageCount={workflow.workflow.fileNames.length}
              autoApplyInline={false}
              pageApplied={activePageApplied}
              canRequeue={Boolean(workflow.workflow.preflightId)}
              requeueBusy={workflow.phase === 'checking'}
              onReset={() => void workflow.reset()}
              onDiscardMissingJob={() => void workflow.discardMissingJob()}
              onJobReplaced={(jobId) => void workflow.replaceJob(jobId)}
              onRequeue={() => void workflow.requeueFromPreflight()}
              onApplyJob={activePage.url && !monitor.job?.revision ? applyToActivePage : undefined}
              onRestoreInline={activePage.url ? restoreActivePage : undefined}
              onPageAppliedChange={setActivePageApplied}
              textRegionPanel={monitor.job?.status === 'succeeded' ? (
                <TextRegionInspectionPanel
                  client={client}
                  jobId={monitor.job.id}
                  loadOriginalImage={activePage.url ? loadOriginalFromActivePage : undefined}
                  onJobCreated={(job) => void workflow.replaceJob(job.id, job.revision?.rootJobId, job.revision?.parentJobId)}
                />
              ) : undefined}
              pageRevisionPanel={monitor.job?.status === 'succeeded' ? (
                <PageRevisionPanel
                  client={client}
                  rootJobId={monitor.job.revision?.rootJobId ?? workflow.workflow.rootJobId ?? monitor.job.id}
                  parentJobId={monitor.job.id}
                  currentJob={monitor.job}
                  onJobCreated={(job) => void workflow.replaceJob(job.id, job.revision?.rootJobId, job.revision?.parentJobId)}
                  onApplied={activePage.url ? applyRevisionsToActivePage : undefined}
                />
              ) : undefined}
              />
            </div>
          ) : workflow.preflight ? (
            <div className="content-stack">
              <PreflightReview preflight={workflow.preflight} onMove={workflow.moveImage} />
              <TranslationForm
                client={client}
                initial={workflow.workflow?.bindings}
                busy={workflow.phase === 'creating'}
                disabled={!workflow.preflight.ready || workflow.preflight.images.length === 0}
                onSubmit={(values) => void workflow.createJob(values)}
              />
            </div>
          ) : (
            <div className="empty-state">
              <p><strong>{t('popupEmptyTitle')}</strong></p>
              <p className="muted">{t('popupEmptyDescription')}</p>
              <div className="button-row" style={{ justifyContent: 'center' }}>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={workflow.phase === 'checking'}
                  onClick={() => void workflow.refreshAvailability()}
                >
                  {t('checkConnection')}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                >
                  {t('openSettings')}
                </button>
              </div>
            </div>
          )}
          <JobHistory
            activeJobId={workflow.workflow?.jobId}
            onOpen={(saved) => void workflow.resumeWorkflow(saved)}
          />
        </>
      )}
      <footer>{t('footerPrivacy')}</footer>
      <ScrollControls
        containerRef={scrollContainerRef}
        className="popup-scroll-controls"
        label={t('popupScrollControls')}
      />
    </main>
  );
}
