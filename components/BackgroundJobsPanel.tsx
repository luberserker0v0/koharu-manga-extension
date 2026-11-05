import { useState } from 'react';
import type { BackendClient } from '../lib/api/backend-client';
import { isTerminalJobStatus, normalizeJobState } from '../lib/domain/job-state';
import { formatLocalDate, t } from '../lib/i18n';
import type { StoredSourcePageReference } from '../lib/page-images/workflow-mapping';
import type { StoredBackgroundTask } from '../lib/text-regions/workspace';
import { ErrorNotice } from './ErrorNotice';
import { StatusPill } from './StatusPill';

export function BackgroundJobsPanel({ client, tasks, sourceImagePages, onRemove }: {
  client: BackendClient;
  tasks: StoredBackgroundTask[];
  sourceImagePages: StoredSourcePageReference[];
  onRemove: (jobId: string) => void | Promise<void>;
}) {
  const [busyJobId, setBusyJobId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const pageById = new Map(sourceImagePages.map((page) => [page.sourceImageId, page]));
  const cancel = async (jobId: string) => {
    setBusyJobId(jobId);
    setError(null);
    try { await client.cancelJob(jobId); } catch (nextError) { setError(nextError); }
    finally { setBusyJobId(''); }
  };

  return (
    <section className="panel background-jobs-panel" aria-labelledby="background-jobs-title">
      <div className="panel-heading">
        <div><p className="eyebrow">{t('backgroundJobsEyebrow')}</p><h2 id="background-jobs-title">{t('backgroundJobsTitle')}</h2></div>
        <span className="count-badge">{tasks.length}</span>
      </div>
      <p className="muted">{t('backgroundJobsDescription')}</p>
      <ErrorNotice error={error} />
      {tasks.length === 0 ? <div className="empty-state">{t('backgroundJobsEmpty')}</div> : (
        <ol className="background-job-list">
          {[...tasks].reverse().map((task) => {
            const pages = task.sourceImageIds.flatMap((sourceImageId) => {
              const page = pageById.get(sourceImageId);
              return page ? [page.sourceOrderIndex + 1] : [];
            }).sort((left, right) => left - right);
            const terminal = isTerminalJobStatus(task.status);
            return (
              <li key={task.jobId}>
                <header>
                  <strong>{t(`backgroundJobKind_${task.kind}`)}</strong>
                  <StatusPill view={normalizeJobState({
                    status: task.status, stage: task.stage, error: task.error ?? null,
                  })} />
                </header>
                {pages.length > 0 && <p>{t('backgroundJobPages', pages.map((page) => t('pageRevisionPage', String(page))).join(', '))}</p>}
                <small title={task.jobId}>{task.jobId}</small>
                <small>{formatLocalDate(task.updatedAt)}</small>
                {task.error && <p className="background-job-error">{task.error}</p>}
                <div className="button-row">
                  {!terminal && (
                    <button className="secondary-button danger-button" type="button" disabled={busyJobId === task.jobId} onClick={() => void cancel(task.jobId)}>
                      {busyJobId === task.jobId ? t('requestingCancellation') : t('cancelJob')}
                    </button>
                  )}
                  {terminal && <button className="secondary-button" type="button" onClick={() => void onRemove(task.jobId)}>{t('backgroundJobRemove')}</button>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
