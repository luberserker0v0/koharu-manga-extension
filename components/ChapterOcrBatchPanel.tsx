import type { BackendClient } from '../lib/api/backend-client';
import type { JobResource } from '../lib/api/types';
import { t } from '../lib/i18n';
import type { StoredChapterOcrBatch } from '../lib/text-regions/chapter-ocr-batch';
import type { StoredBackgroundTask, StoredTextRegionWorkspace } from '../lib/text-regions/workspace';
import { useChapterOcrBatch } from '../hooks/useChapterOcrBatch';
import { ErrorNotice } from './ErrorNotice';

function formatPageNumbers(pageNumbers: number[]): string {
  return pageNumbers.map((pageNumber) => t('pageRevisionPage', String(pageNumber))).join(', ');
}

export function ChapterOcrBatchPanel({
  client,
  jobId,
  batch,
  workspace,
  backgroundTasks,
  loadOriginalImage,
  onBatchChange,
  onBackgroundJob,
  onOpenOcr,
  onOpenBackground,
}: {
  client: BackendClient;
  jobId: string;
  batch?: StoredChapterOcrBatch;
  workspace?: StoredTextRegionWorkspace;
  backgroundTasks: StoredBackgroundTask[];
  loadOriginalImage?: (sourceImageId: string, signal?: AbortSignal) => Promise<Blob>;
  onBatchChange: (batch: StoredChapterOcrBatch | null) => void | Promise<void>;
  onBackgroundJob: (job: JobResource, kind: 'ocr_text_review' | 'text_region_correction', sourceImageIds: string[]) => void | Promise<void>;
  onOpenOcr?: () => void;
  onOpenBackground?: () => void;
}) {
  const automation = useChapterOcrBatch({
    client,
    jobId,
    batch,
    workspace,
    backgroundTasks,
    loadOriginalImage,
    onBatchChange,
    onBackgroundJob,
  });
  const regionCount = automation.snapshot?.pages.reduce((sum, page) => sum + page.regions.length, 0) ?? 0;
  const pageCount = automation.snapshot?.pages.filter((page) => page.regions.length > 0).length ?? 0;
  const unavailable = !loadOriginalImage || (!automation.loadingSnapshot && regionCount === 0);
  const progress = automation.progress;
  const summary = batch?.summary;

  return (
    <section className="panel chapter-ocr-batch" aria-labelledby="chapter-ocr-batch-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{t('chapterOcrBatchEyebrow')}</p>
          <h2 id="chapter-ocr-batch-title">{t('chapterOcrBatchTitle')}</h2>
        </div>
        {automation.loadingSnapshot ? <span className="connection-spinner" aria-hidden="true" /> : null}
      </div>
      <p className="muted">{t('chapterOcrBatchDescription')}</p>
      {!automation.loadingSnapshot && regionCount > 0 && (
        <p>{t('chapterOcrBatchDetected', [String(pageCount), String(automation.snapshot?.pages.length ?? 0), String(regionCount)])}</p>
      )}
      {!loadOriginalImage && <div className="notice notice-neutral">{t('chapterOcrBatchOriginalUnavailable')}</div>}
      {!automation.loadingSnapshot && automation.snapshot && regionCount === 0 && (
        <div className="notice notice-neutral">{t('chapterOcrBatchNoRegions')}</div>
      )}
      <ErrorNotice error={automation.availabilityError || automation.operationError || (batch?.error ? new Error(batch.error) : null)} />

      {batch && (
        <div className={`chapter-ocr-batch-status status-${batch.status}`}>
          <strong>{t(`chapterOcrBatchStatus_${batch.status}`)}</strong>
          {progress && (
            <>
              <div className="progress-track"><span style={{ width: `${progress.percent}%` }} /></div>
              <small>{t(`chapterOcrBatchPhase_${progress.phase}`, [String(progress.completed), String(progress.total), String(progress.percent)])}</small>
            </>
          )}
          {summary && (summary.reviewedRegions > 0 || ['succeeded', 'failed'].includes(batch.status)) && (
            <dl className="chapter-ocr-batch-summary">
              <div><dt>{t('chapterOcrBatchSucceeded')}</dt><dd>{summary.succeededRegions}</dd></div>
              <div><dt>{t('chapterOcrBatchChanged')}</dt><dd>{summary.changedRegions}</dd></div>
              <div><dt>{t('chapterOcrBatchFailed')}</dt><dd>{summary.failedRegions}</dd></div>
              <div><dt>{t('chapterOcrBatchCorrectionPages')}</dt><dd>{summary.correctionPages}</dd></div>
              <div><dt>{t('chapterOcrBatchUnchangedPages')}</dt><dd>{summary.unchangedPages}</dd></div>
              <div><dt>{t('chapterOcrBatchFailedPages')}</dt><dd>{summary.failedWithoutRetranslationPages}</dd></div>
            </dl>
          )}
          {summary && summary.unchangedPageNumbers.length > 0 ? (
            <p className="chapter-ocr-batch-page-detail">
              <strong>{t('chapterOcrBatchUnchangedPageList')}</strong>
              <span>{formatPageNumbers(summary.unchangedPageNumbers)}</span>
            </p>
          ) : null}
          {summary && summary.failedPageNumbers.length > 0 ? (
            <p className="chapter-ocr-batch-page-detail">
              <strong>{t('chapterOcrBatchFailedPageList')}</strong>
              <span>{formatPageNumbers(summary.failedPageNumbers)}</span>
            </p>
          ) : null}
          {summary && summary.partialFailurePageNumbers.length > 0 ? (
            <p className="chapter-ocr-batch-page-detail">
              <strong>{t('chapterOcrBatchPartialFailurePageList')}</strong>
              <span>{formatPageNumbers(summary.partialFailurePageNumbers)}</span>
            </p>
          ) : null}
        </div>
      )}

      <div className="button-row">
        {!automation.active && (
          <button
            className="primary-button"
            type="button"
            disabled={automation.loadingSnapshot || unavailable}
            onClick={() => void automation.start()}
          >
            {batch ? t('chapterOcrBatchRunAgain') : t('chapterOcrBatchStart')}
          </button>
        )}
        {automation.active && (
          <button className="secondary-button danger-button" type="button" onClick={() => void automation.cancel()}>
            {t('chapterOcrBatchCancel')}
          </button>
        )}
        {onOpenOcr && <button className="secondary-button" type="button" onClick={onOpenOcr}>{t('chapterOcrBatchOpenOcr')}</button>}
        {automation.active && onOpenBackground && (
          <button className="secondary-button" type="button" onClick={onOpenBackground}>{t('chapterOcrBatchOpenBackground')}</button>
        )}
      </div>
    </section>
  );
}
