import { useEffect, useRef, useState } from 'react';
import type { BackendClient, DownloadedArtifact } from '../lib/api/backend-client';
import type { MonitorTransport } from '../lib/api/job-monitor';
import type { JobArtifact, JobEvent, JobResource } from '../lib/api/types';
import { orderedTranslatedImages } from '../lib/artifacts/translated-images';
import { firstFailedChild, normalizeJobState } from '../lib/domain/job-state';
import { presentJobEvent } from '../lib/domain/job-event';
import { durationParts, jobDurationMilliseconds } from '../lib/domain/job-duration';
import { formatLocalDate, optionalMessage, t } from '../lib/i18n';
import { ErrorNotice } from './ErrorNotice';
import { StatusPill } from './StatusPill';

function Diagnostics({ value }: { value: Record<string, unknown> | null | undefined }) {
  if (!value) return null;
  return (
    <details className="diagnostics">
      <summary>{t('diagnosticsTitle')}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function formatJobDuration(milliseconds: number | null): string {
  if (milliseconds === null) return t('notAvailable');
  const duration = durationParts(milliseconds);
  if (duration.hours > 0) return t('durationHoursMinutes', [String(duration.hours), String(duration.minutes)]);
  if (duration.minutes > 0) return t('durationMinutesSeconds', [String(duration.minutes), String(duration.seconds)]);
  return t('durationSeconds', String(duration.seconds));
}

export function JobPanel({ client, jobId, job, events, artifacts, transport, monitorError, uploadId, uploadDeleted, sourcePageUrl, selectedImageCount, autoApplyInline = true, canRequeue = false, requeueBusy = false, onReset, onJobReplaced, onRequeue, onUploadDeleted, onApplyInline, onApplyJob, onRestoreInline }: {
  client: BackendClient;
  jobId: string;
  job: JobResource | null;
  events: JobEvent[];
  artifacts: JobArtifact[];
  transport: MonitorTransport;
  monitorError: unknown;
  uploadId?: string;
  uploadDeleted?: boolean;
  sourcePageUrl?: string;
  selectedImageCount?: number;
  autoApplyInline?: boolean;
  canRequeue?: boolean;
  requeueBusy?: boolean;
  onReset: () => void;
  onJobReplaced?: (jobId: string) => void;
  onRequeue?: () => void;
  onUploadDeleted?: () => void;
  onApplyInline?: (urls: string[]) => Promise<boolean>;
  onApplyJob?: (jobId: string) => Promise<boolean>;
  onRestoreInline?: () => void;
}) {
  const [actionError, setActionError] = useState<unknown>(null);
  const [canceling, setCanceling] = useState(false);
  const [downloading, setDownloading] = useState<number | null>(null);
  const [inlineArtifact, setInlineArtifact] = useState<number | null>(null);
  const [jobAction, setJobAction] = useState<'retry' | 'resume' | 'cleanup' | null>(null);
  const [uploadRemoved, setUploadRemoved] = useState(Boolean(uploadDeleted));
  const [clock, setClock] = useState(() => Date.now());
  const automaticInlineAttempt = useRef<string | null>(null);
  const artifactCache = useRef(new Map<number, DownloadedArtifact>());
  useEffect(() => setUploadRemoved(Boolean(uploadDeleted)), [jobId, uploadDeleted]);
  useEffect(() => { artifactCache.current.clear(); }, [jobId]);
  useEffect(() => {
    if (!job || normalizeJobState(job).terminal) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status]);

  const getArtifact = async (artifact: JobArtifact): Promise<DownloadedArtifact> => {
    const cached = artifactCache.current.get(artifact.id);
    if (cached) return cached;
    const downloaded = await client.downloadArtifact(jobId, artifact);
    artifactCache.current.set(artifact.id, downloaded);
    return downloaded;
  };

  const applyInline = async (artifact: JobArtifact) => {
    if (!onApplyInline && !onApplyJob) return;
    setDownloading(artifact.id);
    setActionError(null);
    try {
      if (onApplyJob) {
        if (await onApplyJob(jobId)) setInlineArtifact(artifact.id);
      } else if (onApplyInline) {
        const manifest = await client.getTranslatedImages(jobId);
        const images = orderedTranslatedImages(manifest, selectedImageCount ?? 0);
        const blobs = await Promise.all(images.map((image) => client.downloadTranslatedImage(jobId, image)));
        const urls = await Promise.all(blobs.map((blob) => new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.addEventListener('load', () => resolve(String(reader.result)));
          reader.addEventListener('error', () => reject(reader.error ?? new Error('artifact_read_failed')));
          reader.readAsDataURL(blob);
        })));
        if (await onApplyInline(urls)) setInlineArtifact(artifact.id);
      }
    } catch (error) { setActionError(error); }
    finally { setDownloading(null); }
  };

  useEffect(() => {
    if (job?.status !== 'succeeded' || (!onApplyInline && !onApplyJob) || !autoApplyInline) return;
    const exportArtifacts = artifacts.filter((artifact) => artifact.kind === 'export');
    if (exportArtifacts.length !== 1) return;
    const artifact = exportArtifacts[0]!;
    const attemptKey = `${jobId}:${artifact.id}`;
    if (automaticInlineAttempt.current === attemptKey) return;
    automaticInlineAttempt.current = attemptKey;
    void applyInline(artifact);
  }, [job?.status, jobId, artifacts, onApplyInline, onApplyJob, autoApplyInline]);

  if (!job) {
    return (
      <section className="panel centered-panel">
        <div className="spinner" />
        <h2>{t('loadingJobTitle')}</h2>
        <p className="muted">{t('loadingJobDescription', jobId)}</p>
        <ErrorNotice error={monitorError} />
      </section>
    );
  }

  const view = normalizeJobState(job);
  const duration = jobDurationMilliseconds(job.createdAt, job.updatedAt, view.terminal, clock);
  const failedChild = firstFailedChild(job);
  const cancel = async () => {
    setCanceling(true);
    setActionError(null);
    try { await client.cancelJob(jobId); } catch (error) { setActionError(error); } finally { setCanceling(false); }
  };
  const download = async (artifact: JobArtifact) => {
    setDownloading(artifact.id);
    setActionError(null);
    try {
      const result = await getArtifact(artifact);
      const url = URL.createObjectURL(result.blob);
      try { await browser.downloads.download({ url, filename: result.fileName, saveAs: true }); }
      finally { setTimeout(() => URL.revokeObjectURL(url), 10_000); }
    } catch (error) {
      setActionError(error);
    } finally {
      setDownloading(null);
    }
  };
  const createAttempt = async (kind: 'retry' | 'resume') => {
    setJobAction(kind);
    setActionError(null);
    try {
      const next = kind === 'resume' ? await client.resumeJob(jobId) : await client.retryJob(jobId);
      onJobReplaced?.(next.id);
    } catch (error) { setActionError(error); }
    finally { setJobAction(null); }
  };
  const cleanupUpload = async () => {
    if (!uploadId || !confirm(t('confirmDeleteUpload'))) return;
    setJobAction('cleanup');
    setActionError(null);
    try {
      await client.deleteUpload(uploadId);
      setUploadRemoved(true);
      onUploadDeleted?.();
    } catch (error) { setActionError(error); }
    finally { setJobAction(null); }
  };
  return (
    <div className="job-stack">
      <section className="panel job-summary" aria-labelledby="job-title">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">{t('jobEyebrow')}</p>
            <h2 id="job-title">{t('jobTitle')}</h2>
          </div>
          <StatusPill view={view} />
        </div>
        <dl className="job-facts">
          <div><dt>{t('jobTypeLabel')}</dt><dd>{job.type || t('notAvailable')}</dd></div>
          <div><dt>{t('jobIdLabel')}</dt><dd title={job.id}>{job.id}</dd></div>
          {sourcePageUrl && <div><dt>{t('jobTargetUrlLabel')}</dt><dd title={sourcePageUrl}><a href={sourcePageUrl} target="_blank" rel="noreferrer">{sourcePageUrl}</a></dd></div>}
          <div><dt>{t('jobStageLabel')}</dt><dd>{job.stage || t('notAvailable')}</dd></div>
          <div><dt>{t('jobUpdatedLabel')}</dt><dd>{formatLocalDate(job.updatedAt)}</dd></div>
          <div><dt>{t(view.terminal ? 'jobTotalDurationLabel' : 'jobElapsedDurationLabel')}</dt><dd>{formatJobDuration(duration)}</dd></div>
          <div><dt>{t('liveUpdatesLabel')}</dt><dd>{t(`transport_${transport}`)}</dd></div>
        </dl>
        {view.waiting && <div className="notice notice-waiting">{t('jobWaitingDetail')}</div>}
        {job.outcome && <div className="notice notice-neutral">{t('jobOutcomeDetail', job.outcome)}</div>}
        {view.actionableError && <div className="notice notice-error" role="alert">{view.actionableError}</div>}
        {typeof job.diagnostics?.recommendedAction === 'string' && <div className="notice notice-neutral"><strong>{t('recommendedActionLabel')}</strong><span>{job.diagnostics.recommendedAction}</span></div>}
        {job.resumeMetadata?.resourceFailureType && <div className="notice notice-neutral">{t('resourceFailureType', job.resumeMetadata.resourceFailureType)}</div>}
        {failedChild && (
          <div className="notice notice-error">
            <strong>{t('failedChildTitle', failedChild.id)}</strong>
            <span>{failedChild.error || failedChild.blockedReason || t('errorUnknown')}</span>
          </div>
        )}
        <Diagnostics value={job.diagnostics} />
        <ErrorNotice error={actionError || monitorError} />
        <div className="button-row">
          {!view.terminal && (
            <button className="secondary-button danger-button" type="button" disabled={canceling} onClick={() => void cancel()}>
              {canceling ? t('requestingCancellation') : t('cancelJob')}
            </button>
          )}
          {view.terminal && <button className="secondary-button" type="button" onClick={onReset}>{t('newTranslation')}</button>}
          {view.terminal && canRequeue && onRequeue && (
            <button className="primary-button" type="button" disabled={requeueBusy} onClick={onRequeue}>
              {requeueBusy ? t('requeueingTranslation') : t('requeueTranslation')}
            </button>
          )}
          {job.status === 'failed' && job.resumeMetadata?.resumeAvailable === true && (
            <button className="primary-button" type="button" disabled={jobAction !== null} onClick={() => void createAttempt('resume')}>{jobAction === 'resume' ? t('resumingJob') : t('resumeJob')}</button>
          )}
          {(job.status === 'failed' || job.status === 'blocked') && (
            <button className="secondary-button" type="button" disabled={jobAction !== null} onClick={() => void createAttempt('retry')}>{jobAction === 'retry' ? t('retryingJob') : t('retryJob')}</button>
          )}
          {view.terminal && uploadId && !uploadRemoved && (
            <button className="secondary-button danger-button" type="button" disabled={jobAction !== null} onClick={() => void cleanupUpload()}>{jobAction === 'cleanup' ? t('deletingUpload') : t('deleteSourceUpload')}</button>
          )}
          {uploadRemoved && <span className="cleanup-status">{t('sourceUploadDeleted')}</span>}
        </div>
      </section>

      <section className="panel" aria-labelledby="artifacts-title">
        <div className="panel-heading"><h2 id="artifacts-title">{t('artifactsTitle')}</h2><span className="count-badge">{artifacts.length}</span></div>
        {view.terminal && artifacts.length === 0 ? (
          <div className="empty-state">{t('artifactsEmpty')}</div>
        ) : artifacts.length === 0 ? (
          <div className="empty-state">{t('artifactsWaiting')}</div>
        ) : (
          <ul className="artifact-list">
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <span><strong>{artifact.kind}</strong><small>{t('artifactIdDetail', String(artifact.id))}</small></span>
                <button type="button" onClick={() => void download(artifact)} disabled={downloading === artifact.id}>
                  {downloading === artifact.id ? t('downloadingArtifact') : t('downloadArtifact')}
                </button>
                {(onApplyInline || onApplyJob) && artifact.kind === 'export' && inlineArtifact !== artifact.id && (
                  <button type="button" onClick={() => void applyInline(artifact)} disabled={downloading === artifact.id}>{t('applyInline')}</button>
                )}
                {onRestoreInline && inlineArtifact === artifact.id && (
                  <button type="button" onClick={() => { onRestoreInline(); setInlineArtifact(null); }}>{t('restoreOriginal')}</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="events-title">
        <div className="panel-heading"><h2 id="events-title">{t('eventsTitle')}</h2><span className="count-badge">{events.length}</span></div>
        {events.length > 0 && <p className="event-order-note">{t('eventsNewestFirst')}</p>}
        {events.length === 0 ? <div className="empty-state">{t('eventsEmpty')}</div> : (
          <ol className="event-list">
            {[...events].reverse().map((event, index) => {
              const eventView = presentJobEvent(event);
              const hasDetails = event.id !== undefined || Boolean(event.payload) || Boolean(event.job);
              return (
                <li className={`event-${eventView.tone}`} key={`${event.createdAt}-${event.type}-${index}`}>
                  <span className="event-dot" />
                  <article className="event-card">
                    <header>
                      <strong>{optionalMessage(eventView.titleKey) || t('jobEventType_unknown', event.type)}</strong>
                      <time dateTime={event.createdAt}>{formatLocalDate(event.createdAt)}</time>
                    </header>
                    {eventView.message && <p>{eventView.message}</p>}
                    {eventView.metadata.length > 0 && (
                      <dl className="event-metadata">
                        {eventView.metadata.map((item) => (
                          <div key={`${item.kind}:${item.value}`}>
                            <dt>{t(`jobEventMeta_${item.kind}`)}</dt><dd>{item.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    {hasDetails && (
                      <details className="event-details">
                        <summary>{t('eventTechnicalDetails')}</summary>
                        <dl>
                          <div><dt>{t('eventRawType')}</dt><dd>{event.type}</dd></div>
                          {event.id !== undefined && <div><dt>{t('eventId')}</dt><dd>{event.id}</dd></div>}
                        </dl>
                        {(event.payload || event.job) && <pre>{JSON.stringify({ payload: event.payload, job: event.job }, null, 2)}</pre>}
                      </details>
                    )}
                  </article>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
