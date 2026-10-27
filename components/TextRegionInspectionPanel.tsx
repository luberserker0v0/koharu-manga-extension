import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { BackendClient } from '../lib/api/backend-client';
import { BackendApiError, isAbortError } from '../lib/api/errors';
import type { JobResource, TextRegion, TextRegionGeometry, TextRegionPage, TextRegionSnapshot } from '../lib/api/types';
import { t } from '../lib/i18n';
import {
  buildTextRegionPageCorrections,
  correctionFromDraft,
  draftFromRegion,
  textRegionDraftKey,
  type TextRegionDraft,
} from '../lib/text-regions/corrections';
import { ErrorNotice } from './ErrorNotice';

function backendErrorCode(error: unknown): string | null {
  if (!(error instanceof BackendApiError) || !error.detail || typeof error.detail !== 'object') return null;
  const code = (error.detail as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function percent(value: number, total: number): string {
  return `${Math.max(0, Math.min(100, value / total * 100))}%`;
}

function numericValue(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.round(Math.min(maximum, Math.max(minimum, value)) * 100) / 100;
}

const MIN_PREVIEW_ZOOM = 50;
const MAX_PREVIEW_ZOOM = 300;
const PREVIEW_ZOOM_STEP = 25;

export function TextRegionInspectionPanel({
  client,
  jobId,
  onJobCreated,
  loadOriginalImage,
}: {
  client: BackendClient;
  jobId: string;
  onJobCreated: (job: JobResource) => void;
  loadOriginalImage?: (sourceImageId: string, signal?: AbortSignal) => Promise<Blob>;
}) {
  const [snapshot, setSnapshot] = useState<TextRegionSnapshot | null>(null);
  const [selectedSourceImageId, setSelectedSourceImageId] = useState('');
  const [selectedRegionId, setSelectedRegionId] = useState('');
  const [showBoxes, setShowBoxes] = useState(true);
  const [showText, setShowText] = useState(false);
  const [previewMode, setPreviewMode] = useState<'original' | 'translated'>(() => loadOriginalImage ? 'original' : 'translated');
  const [previewZoom, setPreviewZoom] = useState(100);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Map<string, TextRegionDraft>>(new Map());
  const [instructions, setInstructions] = useState('');
  const [loading, setLoading] = useState(true);
  const [imageLoading, setImageLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const imageUrlRef = useRef<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pointerEdit = useRef<{
    pointerId: number;
    sourceImageId: string;
    regionId: string;
    mode: 'move' | 'resize';
    clientX: number;
    clientY: number;
    geometry: TextRegionDraft['geometry'];
  } | null>(null);

  const loadSnapshot = useCallback(async (signal?: AbortSignal) => {
    setSnapshot(null);
    setSelectedSourceImageId('');
    setSelectedRegionId('');
    setDrafts(new Map());
    setInstructions('');
    setError(null);
    setLoading(true);
    try {
      const next = await client.getTextRegions(jobId, undefined, signal);
      setSnapshot(next);
      setSelectedSourceImageId(next.pages[0]?.sourceImageId ?? '');
      setSelectedRegionId(next.pages[0]?.regions[0]?.id ?? '');
    } catch (nextError) {
      if (!isAbortError(nextError)) setError(nextError);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [client, jobId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadSnapshot(controller.signal);
    return () => controller.abort();
  }, [loadSnapshot]);

  const page = useMemo(() => snapshot?.pages.find((item) => item.sourceImageId === selectedSourceImageId)
    ?? snapshot?.pages[0]
    ?? null, [selectedSourceImageId, snapshot]);
  const region = page?.regions.find((item) => item.id === selectedRegionId) ?? page?.regions[0] ?? null;
  const regionKey = page && region ? textRegionDraftKey(page.sourceImageId, region.id) : '';
  const regionDraft = region ? drafts.get(regionKey) ?? draftFromRegion(region) : null;

  const correctionState = useMemo(() => {
    if (!snapshot) return { pages: [], regionCount: 0, error: null as unknown };
    try {
      const pages = buildTextRegionPageCorrections(snapshot.pages, drafts);
      return {
        pages,
        regionCount: pages.reduce((sum, item) => sum + item.regions.length, 0),
        error: null as unknown,
      };
    } catch (validationError) {
      return { pages: [], regionCount: 0, error: validationError };
    }
  }, [drafts, snapshot]);

  useEffect(() => {
    if (!snapshot || !page) return;
    const controller = new AbortController();
    setImageLoading(true);
    setError(null);
    void (async () => {
      let blob: Blob;
      if (previewMode === 'original' && loadOriginalImage) {
        blob = await loadOriginalImage(page.sourceImageId, controller.signal);
      } else {
        const manifest = await client.getPageRevisions(snapshot.rootJobId, controller.signal);
        const revisionPage = manifest.pages.find((item) => item.sourceImageId === page.sourceImageId);
        const revision = revisionPage?.revisions.find((item) => item.revisionId === page.pageRevisionId);
        if (!revision) throw new Error('source_page_mapping_incomplete');
        blob = await client.downloadPageRevisionImage(revision, controller.signal);
      }
      const nextUrl = URL.createObjectURL(blob);
      if (controller.signal.aborted) {
        URL.revokeObjectURL(nextUrl);
        return;
      }
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = nextUrl;
      setImageUrl(nextUrl);
    })().catch((nextError: unknown) => {
      if (!isAbortError(nextError)) setError(nextError);
    }).finally(() => {
      if (!controller.signal.aborted) setImageLoading(false);
    });
    return () => controller.abort();
  }, [client, loadOriginalImage, page, previewMode, snapshot]);

  useEffect(() => () => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
  }, []);

  const updateSpecificDraft = (
    targetPage: TextRegionPage,
    targetRegion: TextRegion,
    update: (draft: TextRegionDraft) => TextRegionDraft,
  ) => {
    setDrafts((current) => {
      const next = new Map(current);
      const key = textRegionDraftKey(targetPage.sourceImageId, targetRegion.id);
      const value = update(next.get(key) ?? draftFromRegion(targetRegion));
      try {
        if (correctionFromDraft(targetRegion, value)) next.set(key, value); else next.delete(key);
      } catch {
        next.set(key, value);
      }
      return next;
    });
  };

  const updateDraft = (update: (draft: TextRegionDraft) => TextRegionDraft) => {
    if (page && region) updateSpecificDraft(page, region, update);
  };

  const updateGeometry = (field: keyof TextRegionGeometry, value: string) => {
    updateDraft((current) => ({
      ...current,
      geometry: { ...current.geometry, [field]: numericValue(value) },
    }));
  };

  const resetRegion = () => {
    if (!page || !region) return;
    setDrafts((current) => {
      const next = new Map(current);
      next.delete(textRegionDraftKey(page.sourceImageId, region.id));
      return next;
    });
  };

  const startPointerEdit = (
    event: ReactPointerEvent<HTMLButtonElement>,
    targetPage: TextRegionPage,
    targetRegion: TextRegion,
    geometry: TextRegionDraft['geometry'],
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setSelectedRegionId(targetRegion.id);
    const mode = (event.target as HTMLElement).closest('.text-region-resize-handle') ? 'resize' : 'move';
    pointerEdit.current = {
      pointerId: event.pointerId,
      sourceImageId: targetPage.sourceImageId,
      regionId: targetRegion.id,
      mode,
      clientX: event.clientX,
      clientY: event.clientY,
      geometry: { ...geometry },
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const continuePointerEdit = (
    event: ReactPointerEvent<HTMLButtonElement>,
    targetPage: TextRegionPage,
    targetRegion: TextRegion,
  ) => {
    const active = pointerEdit.current;
    const stage = stageRef.current;
    if (!active || active.pointerId !== event.pointerId || !stage
      || active.sourceImageId !== targetPage.sourceImageId || active.regionId !== targetRegion.id) return;
    const bounds = stage.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const deltaX = (event.clientX - active.clientX) * targetPage.coordinateSpace.width / bounds.width;
    const deltaY = (event.clientY - active.clientY) * targetPage.coordinateSpace.height / bounds.height;
    const geometry = active.mode === 'move'
      ? {
          ...active.geometry,
          x: clamp(active.geometry.x + deltaX, 0, targetPage.coordinateSpace.width - active.geometry.width),
          y: clamp(active.geometry.y + deltaY, 0, targetPage.coordinateSpace.height - active.geometry.height),
        }
      : {
          ...active.geometry,
          width: clamp(active.geometry.width + deltaX, 1, targetPage.coordinateSpace.width - active.geometry.x),
          height: clamp(active.geometry.height + deltaY, 1, targetPage.coordinateSpace.height - active.geometry.y),
        };
    updateSpecificDraft(targetPage, targetRegion, (current) => ({ ...current, geometry }));
  };

  const endPointerEdit = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pointerEdit.current?.pointerId !== event.pointerId) return;
    pointerEdit.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const submitCorrections = async () => {
    if (!correctionState.pages.length || correctionState.error) return;
    setSubmitting(true);
    setError(null);
    try {
      const instructionText = instructions.trim();
      const job = await client.createTextRegionCorrection(jobId, {
        pages: correctionState.pages,
        ...(instructionText ? { instructions: instructionText } : {}),
      });
      onJobCreated(job);
    } catch (nextError) {
      setError(nextError);
      setSubmitting(false);
    }
  };

  const unavailableCode = backendErrorCode(error);
  const unavailable = unavailableCode === 'text_region_snapshot_unavailable'
    || unavailableCode === 'text_region_coordinate_space_unavailable';
  const stale = unavailableCode === 'stale_region_set_revision';

  return (
    <section className="panel text-region-panel" aria-labelledby="text-region-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{t('textRegionEyebrow')}</p>
          <h2 id="text-region-title">{t('textRegionTitle')}</h2>
        </div>
        {snapshot && <span className="count-badge">{snapshot.pages.reduce((sum, item) => sum + item.regions.length, 0)}</span>}
      </div>
      <p className="muted">{t('textRegionDescription')}</p>
      {loading ? <div className="scan-state"><div className="spinner" />{t('textRegionLoading')}</div> : null}
      {unavailable ? <div className="notice notice-neutral">{t(`error_${unavailableCode}`)}</div> : null}
      {stale ? (
        <div className="notice notice-error" role="alert">
          <p>{t('error_stale_region_set_revision')}</p>
          <button className="secondary-button" type="button" onClick={() => void loadSnapshot()}>{t('textRegionReload')}</button>
        </div>
      ) : null}
      {!unavailable && !stale ? <ErrorNotice error={error} /> : null}
      {correctionState.error ? <ErrorNotice error={correctionState.error} /> : null}
      {!loading && !error && snapshot?.pages.length === 0 && <div className="empty-state">{t('textRegionEmpty')}</div>}
      {snapshot && page && (
        <>
          <div className="text-region-toolbar">
            <div className="text-region-image-switch" role="group" aria-label={t('textRegionImageMode')}>
              <button
                type="button"
                className={previewMode === 'original' ? 'active' : ''}
                disabled={!loadOriginalImage}
                aria-pressed={previewMode === 'original'}
                onClick={() => setPreviewMode('original')}
              >
                {t('textRegionOriginalImage')}
              </button>
              <button
                type="button"
                className={previewMode === 'translated' ? 'active' : ''}
                aria-pressed={previewMode === 'translated'}
                onClick={() => setPreviewMode('translated')}
              >
                {t('textRegionTranslatedImage')}
              </button>
            </div>
            <div className="text-region-zoom" role="group" aria-label={t('textRegionZoomControls')}>
              <button
                type="button"
                disabled={previewZoom <= MIN_PREVIEW_ZOOM}
                aria-label={t('textRegionZoomOut')}
                onClick={() => setPreviewZoom((current) => Math.max(MIN_PREVIEW_ZOOM, current - PREVIEW_ZOOM_STEP))}
              >
                −
              </button>
              <button
                type="button"
                className="zoom-value"
                title={t('textRegionZoomReset')}
                aria-label={t('textRegionZoomReset')}
                onClick={() => setPreviewZoom(100)}
              >
                {previewZoom}%
              </button>
              <button
                type="button"
                disabled={previewZoom >= MAX_PREVIEW_ZOOM}
                aria-label={t('textRegionZoomIn')}
                onClick={() => setPreviewZoom((current) => Math.min(MAX_PREVIEW_ZOOM, current + PREVIEW_ZOOM_STEP))}
              >
                +
              </button>
            </div>
            <label>
              <span>{t('textRegionPageLabel')}</span>
              <select
                value={page.sourceImageId}
                onChange={(event) => {
                  const nextPage = snapshot.pages.find((item) => item.sourceImageId === event.target.value);
                  setSelectedSourceImageId(event.target.value);
                  setSelectedRegionId(nextPage?.regions[0]?.id ?? '');
                }}
              >
                {snapshot.pages.map((item) => {
                  const changed = item.regions.filter((candidate) => drafts.has(textRegionDraftKey(item.sourceImageId, candidate.id))).length;
                  return (
                    <option key={item.sourceImageId} value={item.sourceImageId}>
                      {t('textRegionPageOption', String(item.sourceOrderIndex + 1))} · {item.sourceFileName}{changed ? ` · ${t('textRegionChangedCount', String(changed))}` : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            <div className="text-region-toggles">
              <label><input type="checkbox" checked={showBoxes} onChange={(event) => setShowBoxes(event.target.checked)} />{t('textRegionShowBoxes')}</label>
              <label><input type="checkbox" checked={showText} onChange={(event) => setShowText(event.target.checked)} />{t('textRegionShowText')}</label>
            </div>
          </div>
          <div className="text-region-preview">
            {imageLoading && <div className="scan-state"><div className="spinner" />{t(previewMode === 'original' ? 'textRegionOriginalImageLoading' : 'textRegionImageLoading')}</div>}
            {imageUrl && !imageLoading && (
              <div className="text-region-stage" ref={stageRef} style={{ width: `${previewZoom}%` }}>
                <img src={imageUrl} alt={t(previewMode === 'original' ? 'textRegionOriginalPreviewAlt' : 'textRegionPreviewAlt', String(page.sourceOrderIndex + 1))} />
                <div className={`text-region-overlay${showBoxes ? ' show-boxes' : ''}${showText ? ' show-text' : ''}`}>
                  {page.regions.map((item) => {
                    const itemDraft = drafts.get(textRegionDraftKey(page.sourceImageId, item.id));
                    const geometry = itemDraft?.geometry ?? item.geometry;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`${item.id === region?.id ? 'selected' : ''}${itemDraft ? ' changed' : ''}`.trim()}
                        style={{
                          left: percent(geometry.x, page.coordinateSpace.width),
                          top: percent(geometry.y, page.coordinateSpace.height),
                          width: percent(geometry.width, page.coordinateSpace.width),
                          height: percent(geometry.height, page.coordinateSpace.height),
                          transform: `rotate(${geometry.rotation ?? 0}deg)`,
                        }}
                        onClick={() => setSelectedRegionId(item.id)}
                        onPointerDown={(event) => startPointerEdit(event, page, item, geometry)}
                        onPointerMove={(event) => continuePointerEdit(event, page, item)}
                        onPointerUp={endPointerEdit}
                        onPointerCancel={endPointerEdit}
                        aria-label={t('textRegionSelect', String(item.readingOrder + 1))}
                      >
                        <span className="text-region-number">{item.readingOrder + 1}</span>
                        <span className="text-region-overlay-text">{itemDraft?.sourceText ?? item.sourceText}</span>
                        {item.id === region?.id && showBoxes && (
                          <span className="text-region-resize-handle" aria-label={t('textRegionResizeHandle')} />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <div className="text-region-list" role="list" aria-label={t('textRegionListLabel')}>
            {page.regions.map((item) => {
              const itemKey = textRegionDraftKey(page.sourceImageId, item.id);
              const changed = drafts.has(itemKey);
              return (
                <button
                  key={item.id}
                  type="button"
                  role="listitem"
                  className={`${item.id === region?.id ? 'selected' : ''}${changed ? ' changed' : ''}`.trim()}
                  onClick={() => setSelectedRegionId(item.id)}
                >
                  <span>{item.readingOrder + 1}</span>
                  <strong>{drafts.get(itemKey)?.sourceText || item.sourceText || t('textRegionNoSourceText')}</strong>
                  {changed && <i aria-label={t('textRegionChanged')}>{t('textRegionChangedMark')}</i>}
                </button>
              );
            })}
          </div>
          {region && regionDraft && (
            <div className="text-region-editor">
              <label className="text-region-source-editor">
                <span>{t('textRegionSourceText')}</span>
                <textarea
                  value={regionDraft.sourceText}
                  maxLength={10000}
                  onChange={(event) => updateDraft((current) => ({ ...current, sourceText: event.target.value }))}
                />
              </label>
              <div className="text-region-geometry" role="group" aria-label={t('textRegionGeometry')}>
                {(['x', 'y', 'width', 'height', 'rotation'] as const).map((field) => (
                  <label key={field}>
                    <span>{t(`textRegionGeometry_${field}`)}</span>
                    <input
                      type="number"
                      step={field === 'rotation' ? '0.1' : '1'}
                      min={field === 'width' || field === 'height' ? '0.01' : field === 'rotation' ? undefined : '0'}
                      value={Number.isFinite(regionDraft.geometry[field] ?? 0) ? regionDraft.geometry[field] : ''}
                      onChange={(event) => updateGeometry(field, event.target.value)}
                    />
                  </label>
                ))}
              </div>
              <p className="field-help">{t('textRegionGeometryHelp', [String(page.coordinateSpace.width), String(page.coordinateSpace.height)])}</p>
              <dl className="text-region-detail">
                <div><dt>{t('textRegionTranslatedText')}</dt><dd>{region.translatedText || t('textRegionNoTranslatedText')}</dd></div>
                {typeof region.ocrConfidence === 'number' && (
                  <div><dt>{t('textRegionConfidence')}</dt><dd>{Math.round(region.ocrConfidence * 1000) / 10}%</dd></div>
                )}
              </dl>
              <button className="secondary-button" type="button" disabled={!drafts.has(regionKey)} onClick={resetRegion}>{t('textRegionResetRegion')}</button>
            </div>
          )}
          <label className="revision-instruction-field">
            <span>{t('textRegionInstructionsLabel')}</span>
            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder={t('textRegionInstructionsPlaceholder')}
            />
          </label>
          <p className="field-help">{t('textRegionCorrectionHelp')}</p>
          <div className="text-region-submit-summary">
            <span>{t('textRegionBatchSummary', [String(correctionState.regionCount), String(correctionState.pages.length)])}</span>
            <button className="secondary-button" type="button" disabled={!drafts.size || submitting} onClick={() => setDrafts(new Map())}>{t('textRegionResetAll')}</button>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={!correctionState.regionCount || Boolean(correctionState.error) || submitting}
            onClick={() => void submitCorrections()}
          >
            {submitting ? t('textRegionCorrectionCreating') : t('textRegionSubmitCorrections', String(correctionState.regionCount))}
          </button>
        </>
      )}
    </section>
  );
}
