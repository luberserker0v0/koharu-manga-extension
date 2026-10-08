import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorNotice } from '../../components/ErrorNotice';
import { JobPanel } from '../../components/JobPanel';
import { JobHistory } from '../../components/JobHistory';
import { PageAccessPanel } from '../../components/PageAccessPanel';
import { PreflightReview } from '../../components/PreflightReview';
import { SettingsPanel } from '../../components/SettingsPanel';
import { TranslationForm } from '../../components/TranslationForm';
import { useJobMonitor } from '../../hooks/useJobMonitor';
import { useSettings } from '../../hooks/useSettings';
import { useTranslationWorkflow } from '../../hooks/useTranslationWorkflow';
import { BackendClient } from '../../lib/api/backend-client';
import { ComicCrawlerClient } from '../../lib/comic-crawler/client';
import { t } from '../../lib/i18n';
import {
  findWorkflowForChapter,
  loadWorkflowHistory,
  pageWorkflowKey,
  workflowMatchesChapter,
} from '../../lib/storage/workflow';

export function App() {
  const { settings, save } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activePage, setActivePage] = useState<{ resolved: boolean; tabId?: number; url?: string }>({ resolved: false });
  const client = useMemo(() => settings ? new BackendClient(settings) : null, [settings]);
  const crawler = useMemo(() => settings?.comicCrawler.enabled ? new ComicCrawlerClient(settings.comicCrawler) : null, [settings]);
  const [crawlerCheck, setCrawlerCheck] = useState<'idle' | 'checking' | 'ready' | 'unavailable'>('idle');
  const scopedClient = activePage.resolved ? client : null;
  const workflow = useTranslationWorkflow(scopedClient, activePage.url);
  const monitor = useJobMonitor(scopedClient, workflow.workflow?.jobId ?? null);
  const checkedClient = useRef<BackendClient | null>(null);
  const crawlerWorkspaceLookup = useRef<string | null>(null);

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
    if (!crawler || !activePage.resolved || !activePage.url || workflow.phase === 'loading') return;
    const lookupKey = activePage.url;
    if (crawlerWorkspaceLookup.current === lookupKey) return;
    crawlerWorkspaceLookup.current = lookupKey;
    let disposed = false;
    void (async () => {
      const adapter = await crawler.resolveAdapter(activePage.url!);
      if (adapter.status !== 'matched') return;
      const chapter = await crawler.extractChapterImages(activePage.url!);
      const history = await loadWorkflowHistory();
      const current = workflow.workflow?.jobId
        && workflowMatchesChapter(workflow.workflow, activePage.url!, chapter.chapterUrl)
        ? workflow.workflow
        : null;
      const previous = current ?? findWorkflowForChapter(history, activePage.url!, chapter.chapterUrl);
      if (!disposed && previous?.jobId && workflow.workflow?.jobId !== previous.jobId) {
        await workflow.resumeWorkflow(previous);
      }
    })().catch(() => {
      // The connection strip reports ComicCrawler availability. Failure to
      // resolve a prior workspace must not block the normal popup workflow.
    });
    return () => { disposed = true; };
  }, [activePage.resolved, activePage.url, crawler, workflow.phase, workflow.resumeWorkflow, workflow.workflow]);

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
    return true;
  }, [activePage.tabId, activePage.url, workflow.workflow?.fileNames.length]);

  if (!settings || !client) {
    return <main className="app-shell loading-shell"><div className="spinner" /><span>{t('loadingExtension')}</span></main>;
  }

  const connectionState = workflow.runtime?.backend.status === 'ready' && workflow.runtime?.koharu.status === 'running';

  return (
    <main className="app-shell">
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
              </dl>
            </details>
          )}

          <ErrorNotice error={workflow.error} />

          {workflow.workflow?.jobId ? (
            <JobPanel
              client={client}
              jobId={workflow.workflow.jobId}
              job={monitor.job}
              events={monitor.events}
              artifacts={monitor.artifacts}
              transport={monitor.transport}
              monitorError={monitor.monitorError}
              uploadId={workflow.workflow.uploadId}
              uploadDeleted={Boolean(workflow.workflow.uploadDeletedAt)}
              sourcePageUrl={workflow.workflow.sourcePageUrl}
              selectedImageCount={workflow.workflow.fileNames.length}
              autoApplyInline={false}
              canRequeue={Boolean(workflow.workflow.preflightId) && !workflow.workflow.uploadDeletedAt}
              requeueBusy={workflow.phase === 'checking'}
              onReset={() => void workflow.reset()}
              onJobReplaced={(jobId) => void workflow.replaceJob(jobId)}
              onRequeue={() => void workflow.requeueFromPreflight()}
              onUploadDeleted={() => void workflow.markUploadDeleted()}
              onApplyJob={activePage.url ? applyToActivePage : undefined}
            />
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
    </main>
  );
}
