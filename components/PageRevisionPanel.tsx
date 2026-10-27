import { useEffect, useMemo, useRef, useState } from 'react';
import type { BackendClient } from '../lib/api/backend-client';
import type { JobResource, PageRevision, PageRevisionManifest } from '../lib/api/types';
import { formatLocalDate, t } from '../lib/i18n';
import { ErrorNotice } from './ErrorNotice';

export function PageRevisionPanel({
  client,
  rootJobId,
  parentJobId,
  currentJob,
  onJobCreated,
  onApplied,
}: {
  client: BackendClient;
  rootJobId: string;
  parentJobId: string;
  currentJob: JobResource;
  onJobCreated: (job: JobResource) => void;
  onApplied?: (manifest: PageRevisionManifest) => Promise<void>;
}) {
  const [manifest, setManifest] = useState<PageRevisionManifest | null>(null);
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [selectedRevisions, setSelectedRevisions] = useState<Record<string, string>>({});
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState<'loading' | 'retranslating' | 'activating' | null>('loading');
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<{ revisionId: string; url: string } | null>(null);
  const previewUrl = useRef<string | null>(null);
  const autoAppliedJob = useRef<string | null>(null);

  const load = async () => {
    setBusy('loading');
    setError(null);
    try {
      const next = await client.getPageRevisions(rootJobId);
      setManifest(next);
      setSelectedRevisions(Object.fromEntries(next.pages.flatMap((page) => page.activeRevisionId
        ? [[page.sourceImageId, page.activeRevisionId]]
        : [])));
      if (currentJob.revision && onApplied && autoAppliedJob.current !== currentJob.id) {
        await onApplied(next);
        autoAppliedJob.current = currentJob.id;
      }
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void load();
  }, [client, rootJobId, currentJob.id, currentJob.updatedAt, Boolean(onApplied)]);

  useEffect(() => () => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
  }, []);

  const changedSelections = useMemo(() => manifest?.pages.flatMap((page) => {
    const revisionId = selectedRevisions[page.sourceImageId];
    return revisionId && revisionId !== page.activeRevisionId
      ? [{ sourceImageId: page.sourceImageId, revisionId }]
      : [];
  }) ?? [], [manifest, selectedRevisions]);

  const retranslate = async () => {
    if (!selectedPages.size) return;
    setBusy('retranslating');
    setError(null);
    try {
      const text = instructions.trim();
      const job = await client.createRetranslation(parentJobId, {
        sourceImageIds: [...selectedPages],
        ...(text ? { instructions: text } : {}),
      });
      onJobCreated(job);
    } catch (nextError) {
      setError(nextError);
      setBusy(null);
    }
  };

  const activate = async () => {
    if (!changedSelections.length) return;
    setBusy('activating');
    setError(null);
    try {
      const next = await client.activatePageRevisions(rootJobId, changedSelections);
      setManifest(next);
      setSelectedRevisions(Object.fromEntries(next.pages.flatMap((page) => page.activeRevisionId
        ? [[page.sourceImageId, page.activeRevisionId]]
        : [])));
      await onApplied?.(next);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(null);
    }
  };

  const showPreview = async (revision: PageRevision) => {
    setError(null);
    try {
      const blob = await client.downloadPageRevisionImage(revision);
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      const url = URL.createObjectURL(blob);
      previewUrl.current = url;
      setPreview({ revisionId: revision.revisionId, url });
    } catch (nextError) {
      setError(nextError);
    }
  };

  return (
    <section className="panel page-revision-panel" aria-labelledby="page-revisions-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{t('pageRevisionEyebrow')}</p>
          <h2 id="page-revisions-title">{t('pageRevisionTitle')}</h2>
        </div>
        {manifest && <span className="count-badge">{manifest.pageCount}</span>}
      </div>
      <p className="muted">{t('pageRevisionDescription')}</p>
      <ErrorNotice error={error} />
      {busy === 'loading' && !manifest ? (
        <div className="scan-state"><div className="spinner" />{t('pageRevisionLoading')}</div>
      ) : manifest ? (
        <>
          <ol className="revision-page-list">
            {manifest.pages.map((page) => {
              const chosenId = selectedRevisions[page.sourceImageId] ?? page.activeRevisionId ?? '';
              const chosen = page.revisions.find((revision) => revision.revisionId === chosenId);
              return (
                <li key={page.sourceImageId}>
                  <div className="revision-page-heading">
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedPages.has(page.sourceImageId)}
                        onChange={(event) => setSelectedPages((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(page.sourceImageId); else next.delete(page.sourceImageId);
                          return next;
                        })}
                      />
                      <span>{t('pageRevisionPage', String(page.sourceOrderIndex + 1))}</span>
                    </label>
                    <small title={page.sourceFileName}>{page.sourceFileName || page.sourceImageId}</small>
                  </div>
                  <div className="revision-controls">
                    <select
                      aria-label={t('pageRevisionVersionLabel')}
                      value={chosenId}
                      onChange={(event) => setSelectedRevisions((current) => ({
                        ...current,
                        [page.sourceImageId]: event.target.value,
                      }))}
                    >
                      {page.revisions.map((revision) => (
                        <option key={revision.revisionId} value={revision.revisionId}>
                          {t('pageRevisionVersion', String(revision.revisionNumber))}{revision.active ? ` · ${t('pageRevisionActive')}` : ''}
                        </option>
                      ))}
                    </select>
                    {chosen && <button className="secondary-button" type="button" onClick={() => void showPreview(chosen)}>{t('pageRevisionPreview')}</button>}
                  </div>
                  {chosen && (
                    <small className="revision-meta">
                      {formatLocalDate(chosen.createdAt)} · {chosen.translationTarget
                        ? `${chosen.translationTarget.providerId} / ${chosen.translationTarget.modelId}`
                        : t('pageRevisionInheritedTarget')}
                    </small>
                  )}
                  {chosen?.instructions && <p className="revision-instructions">{chosen.instructions}</p>}
                  {preview?.revisionId === chosen?.revisionId && <img className="revision-preview" src={preview?.url} alt={t('pageRevisionPreviewAlt', String(page.sourceOrderIndex + 1))} />}
                </li>
              );
            })}
          </ol>
          <label className="revision-instruction-field">
            <span>{t('retranslationInstructionsLabel')}</span>
            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder={t('retranslationInstructionsPlaceholder')}
            />
          </label>
          <p className="field-help">{t('retranslationInstructionsHelp')}</p>
          <div className="button-row">
            <button className="primary-button" type="button" disabled={!selectedPages.size || busy !== null} onClick={() => void retranslate()}>
              {busy === 'retranslating' ? t('retranslationCreating') : t('retranslateSelectedPages', String(selectedPages.size))}
            </button>
            <button className="secondary-button" type="button" disabled={!changedSelections.length || busy !== null} onClick={() => void activate()}>
              {busy === 'activating' ? t('pageRevisionRestoring') : t('pageRevisionRestore', String(changedSelections.length))}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
