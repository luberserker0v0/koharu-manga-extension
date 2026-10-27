import { useCallback, useEffect, useState } from 'react';
import type { BrowserWorkspaceSnapshot } from '../lib/comic-crawler/browser-task-coordinator';
import type { AdapterResolution } from '../lib/comic-crawler/types';
import { formatLocalDate, t } from '../lib/i18n';
import { ErrorNotice } from './ErrorNotice';

const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

async function send<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  return await browser.runtime.sendMessage({ type, ...payload }) as T;
}

export function ComicCrawlerBrowserPanel() {
  const [workspace, setWorkspace] = useState<BrowserWorkspaceSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    const next = await send<BrowserWorkspaceSnapshot>('COMIC_CRAWLER_BROWSER_STATUS');
    setWorkspace(next);
    return next;
  }, []);

  useEffect(() => {
    void refresh().catch(setError);
  }, [refresh]);

  useEffect(() => {
    const task = workspace?.task;
    if ((!task?.taskId && !task?.challengeDiscoveryId) || TERMINAL_TASK_STATES.has(task.status)) return;
    const timer = window.setInterval(() => {
      void refresh().catch(setError);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refresh, workspace?.task?.challengeDiscoveryId, workspace?.task?.taskId, workspace?.task?.status]);

  const act = async (name: string, type: string) => {
    setBusy(name);
    setError(null);
    try {
      await send(type);
      await refresh();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(null);
    }
  };

  const createTask = async () => {
    const targetUrl = workspace?.client.resource?.url;
    if (!targetUrl) return;
    setBusy('create');
    setError(null);
    try {
      const resolution = await send<AdapterResolution>('COMIC_CRAWLER_RESOLVE_ADAPTER', { url: targetUrl });
      const allowDiscovery = resolution.status !== 'matched';
      if (allowDiscovery && !window.confirm(t('browserClientDiscoveryConfirm'))) return;
      await send('COMIC_CRAWLER_BROWSER_CREATE_TASK', { allowDiscovery });
      await refresh();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(null);
    }
  };

  if (!workspace) {
    return <section className="panel centered-panel"><div className="spinner" /><span>{t('browserClientLoading')}</span></section>;
  }

  const { client, task } = workspace;
  const connected = client.status === 'connected';
  const waitingVerification = task?.status === 'waiting_verification'
    || Boolean(task?.challengeDiscoveryId && !task.taskId && task.status !== 'verification_completed');
  const taskTerminal = task ? TERMINAL_TASK_STATES.has(task.status) : false;
  const canCreateTask = !task || taskTerminal || task.status === 'verification_completed';
  const progress = task?.detail?.progress;

  return (
    <section className="panel browser-client-panel" aria-labelledby="browser-client-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{t('browserClientEyebrow')}</p>
          <h2 id="browser-client-title">{t('browserClientTitle')}</h2>
        </div>
      </div>

      <div className="connection-strip">
        <span className={`connection-dot ${connected ? 'online' : ''}`} />
        <span>{t(`browserClientStatus_${client.status}`)}</span>
        {(busy === 'connect' || client.status === 'connecting') && <span className="connection-spinner" aria-hidden="true" />}
      </div>

      <dl className="browser-client-facts">
        <div><dt>{t('browserClientWorkerId')}</dt><dd>{client.workerId ?? t('notAvailable')}</dd></div>
        <div><dt>{t('browserClientResourceId')}</dt><dd>{client.resource?.resourceId ?? t('notAvailable')}</dd></div>
        {client.resource && <div><dt>{t('browserClientApprovedPage')}</dt><dd title={client.resource.url}>{client.resource.url}</dd></div>}
      </dl>

      <div className="button-row">
        {!client.enrolled && (
          <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void act('enroll', 'COMIC_CRAWLER_BROWSER_ENROLL')}>
            {busy === 'enroll' ? t('browserClientEnrolling') : t('browserClientEnroll')}
          </button>
        )}
        {client.enrolled && !connected && (
          <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void act('connect', 'COMIC_CRAWLER_BROWSER_CONNECT')}>
            {busy === 'connect' ? t('browserClientConnecting') : t('browserClientConnect')}
          </button>
        )}
        {connected && (
          <button className="secondary-button" type="button" disabled={Boolean(busy) || !canCreateTask} onClick={() => void act('disconnect', 'COMIC_CRAWLER_BROWSER_DISCONNECT')}>
            {t('browserClientDisconnect')}
          </button>
        )}
        {client.enrolled && (
          <button className="secondary-button danger-button" type="button" disabled={Boolean(busy) || !canCreateTask} onClick={() => void act('logout', 'COMIC_CRAWLER_BROWSER_LOGOUT')}>
            {t('browserClientLogout')}
          </button>
        )}
      </div>

      <div className="browser-client-actions">
        <button className="secondary-button" type="button" disabled={!connected || !canCreateTask || Boolean(busy)} onClick={() => void act('register', 'COMIC_CRAWLER_BROWSER_REGISTER_TAB')}>
          {busy === 'register' ? t('browserClientRegisteringTab') : t('browserClientUseCurrentTab')}
        </button>
        <button className="primary-button" type="button" disabled={!connected || !client.resource || !canCreateTask || Boolean(busy)} onClick={() => void createTask()}>
          {busy === 'create' ? t('browserClientCreatingTask') : t('browserClientCreateTask')}
        </button>
      </div>

      {task && (
        <div className="browser-task-card">
          <div className="browser-task-heading">
            <strong>{t('browserClientTaskTitle')}</strong>
            <span className="status-pill">{t(`crawlerTaskState_${task.status}`)}</span>
          </div>
          <dl className="browser-client-facts">
            <div><dt>{t('browserClientTaskId')}</dt><dd>{task.taskId ?? task.discoveryId ?? task.challengeDiscoveryId ?? t('notAvailable')}</dd></div>
            <div><dt>{t('browserClientTaskUrl')}</dt><dd title={task.targetUrl}>{task.targetUrl}</dd></div>
            <div><dt>{t('browserClientTaskUpdated')}</dt><dd>{formatLocalDate(task.updatedAt)}</dd></div>
            {task.verificationStatus && <div><dt>{t('browserClientVerificationStatus')}</dt><dd>{task.verificationStatus}</dd></div>}
          </dl>
          {progress && (
            <div className="browser-task-progress">
              <div><span>{progress.stageDetail || progress.stage || t('browserClientTaskProgress')}</span><strong>{Math.round(progress.percentage)}%</strong></div>
              <progress max="100" value={Math.max(0, Math.min(100, progress.percentage))} />
            </div>
          )}
          {task.detail?.task.error && <div className="notice notice-error">{task.detail.task.error}</div>}
          {waitingVerification && <div className="notice notice-waiting">{t('browserClientVerificationHelp')}</div>}
          {workspace.recoveryIssue && (
            <div className="notice notice-error">{t(`browserClientRecovery_${workspace.recoveryIssue}`)}</div>
          )}
          {task.discoveryId && <div className="notice notice-neutral">{t('browserClientDiscoveryHelp')}</div>}
          <div className="button-row">
            {workspace.canRecover && (
              <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void act('recover', 'COMIC_CRAWLER_BROWSER_RECOVER_TASK')}>
                {busy === 'recover' ? t('browserClientRecoveringTask') : t('browserClientRecoverTask')}
              </button>
            )}
            {waitingVerification && (
              <>
                <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void act('open-verification', 'COMIC_CRAWLER_BROWSER_OPEN_VERIFICATION')}>
                  {t('browserClientOpenVerification')}
                </button>
                <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void act('continue', 'COMIC_CRAWLER_BROWSER_CONTINUE')}>
                  {busy === 'continue' ? t('browserClientContinuing') : t('browserClientContinue')}
                </button>
              </>
            )}
            {!taskTerminal && (task.taskId || task.challengeDiscoveryId) && (
              <button className="secondary-button danger-button" type="button" disabled={Boolean(busy)} onClick={() => void act('cancel', 'COMIC_CRAWLER_BROWSER_CANCEL')}>
                {t('browserClientCancelTask')}
              </button>
            )}
            <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void act('clear-task', 'COMIC_CRAWLER_BROWSER_CLEAR_TASK')}>
              {t('browserClientClearTask')}
            </button>
          </div>
        </div>
      )}

      {client.errorCode && <div className="notice notice-error">{t('browserClientErrorCode', client.errorCode)}</div>}
      <ErrorNotice error={error} />
    </section>
  );
}
