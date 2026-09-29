import type { SourcePreflight } from '../lib/api/types';
import { t } from '../lib/i18n';

export function PreflightReview({ preflight, onMove }: {
  preflight: SourcePreflight;
  onMove: (index: number, direction: -1 | 1) => void;
}) {
  return (
    <section className="panel" aria-labelledby="preflight-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{t('preflightEyebrow')}</p>
          <h2 id="preflight-title">{t('preflightTitle')}</h2>
        </div>
        <span className="count-badge">{t('acceptedCount', String(preflight.summary.acceptedCount))}</span>
      </div>
      <p className="muted">{t('preflightDescription')}</p>
      <div className="preflight-summary">
        <span>{t('discoveredCount', String(preflight.summary.discoveredCount))}</span>
        <span>{t('acceptedCount', String(preflight.summary.acceptedCount))}</span>
        <span>{t('convertedCount', String(preflight.summary.convertedCount))}</span>
        <span>{t('rejectedCount', String(preflight.summary.rejectedCount))}</span>
      </div>
      {preflight.images.length === 0 ? (
        <div className="empty-state">{t('noAcceptedImages')}</div>
      ) : (
        <ol className="image-order-list">
          {preflight.images.map((image, index) => (
            <li key={image.id}>
              <span className="order-number">{index + 1}</span>
              <span className="image-name">
                <strong>{image.fileName}</strong>
                <small>{image.converted ? t('imageConverted', image.actualFormat) : image.actualFormat.toUpperCase()}</small>
              </span>
              <span className="order-actions">
                <button type="button" disabled={index === 0} onClick={() => onMove(index, -1)} aria-label={t('moveImageUp', image.fileName)}>↑</button>
                <button type="button" disabled={index === preflight.images.length - 1} onClick={() => onMove(index, 1)} aria-label={t('moveImageDown', image.fileName)}>↓</button>
              </span>
            </li>
          ))}
        </ol>
      )}
      {preflight.rejectedFiles.length > 0 && (
        <details className="rejected-files">
          <summary>{t('rejectedCount', String(preflight.rejectedFiles.length))}</summary>
          <ul>
            {preflight.rejectedFiles.map((file) => <li key={file.fileName}><strong>{file.fileName}</strong>: {file.reason}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
