import { useRef, useState } from 'react';
import type { UploadProgress } from '../lib/api/types';
import { formatBytes, t } from '../lib/i18n';
import { moveSourceFile, prepareSourceFiles } from '../lib/domain/source-files';

const ACCEPTED_IMAGES = '.jpg,.jpeg,.png,.webp,.avif,.bmp,.gif,.tif,.tiff,.heic,.heif';

export function UploadPanel({ busy, progress, onStart, onCancel }: {
  busy: boolean;
  progress: UploadProgress | null;
  onStart: (files: File[]) => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [rejected, setRejected] = useState<File[]>([]);

  const selectFiles = (selected: File[]) => {
    const prepared = prepareSourceFiles(selected);
    setFiles(prepared.accepted);
    setRejected(prepared.rejected);
  };

  return (
    <section className="panel hero-panel" aria-labelledby="upload-title">
      <p className="eyebrow">{t('quickModeEyebrow')}</p>
      <h2 id="upload-title">{t('uploadTitle')}</h2>
      <p className="muted">{t('uploadDescription')}</p>
      <button className="drop-zone" type="button" disabled={busy} onClick={() => input.current?.click()}>
        <span className="drop-icon" aria-hidden="true">＋</span>
        <strong>{files.length ? t('selectedImageCount', String(files.length)) : t('chooseImages')}</strong>
        <small>{files.length ? t('reviewSelectedOrder') : t('supportedFormats')}</small>
      </button>
      <input
        ref={input}
        className="visually-hidden"
        type="file"
        accept={ACCEPTED_IMAGES}
        multiple
        onChange={(event) => selectFiles(Array.from(event.target.files ?? []))}
      />
      {files.length > 0 && (
        <ol className="image-order-list upload-order-list">
          {files.map((file, index) => (
            <li key={`${file.name}-${file.lastModified}`}>
              <span className="order-number">{index + 1}</span>
              <span className="image-name"><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span>
              <span className="order-actions">
                <button type="button" disabled={busy || index === 0} onClick={() => setFiles((current) => moveSourceFile(current, index, -1))} aria-label={t('moveImageUp', file.name)}>↑</button>
                <button type="button" disabled={busy || index === files.length - 1} onClick={() => setFiles((current) => moveSourceFile(current, index, 1))} aria-label={t('moveImageDown', file.name)}>↓</button>
              </span>
            </li>
          ))}
        </ol>
      )}
      {rejected.length > 0 && <div className="notice notice-error">{t('unsupportedFilesRejected', rejected.map((file) => file.name).join(', '))}</div>}
      {progress && (
        <div className="progress-block" aria-live="polite">
          <div className="progress-copy">
            <span>{t('uploadingFile', [String(progress.fileIndex + 1), String(progress.fileCount), progress.fileName])}</span>
            <span>{t('uploadProgressValue', [String(progress.percent), formatBytes(progress.totalLoaded), formatBytes(progress.totalBytes)])}</span>
          </div>
          <progress max="100" value={progress.percent} />
        </div>
      )}
      <div className="button-row">
        <button className="primary-button" type="button" disabled={busy || !files.length} onClick={() => onStart(files)}>
          {busy ? t('preparingImages') : t('continueToPreflight')}
        </button>
        {busy && <button className="secondary-button" type="button" onClick={onCancel}>{t('cancelUpload')}</button>}
      </div>
    </section>
  );
}
