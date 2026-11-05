import type { TextRegionReviewRegion, TextRegionReviewResult } from '../lib/api/types';
import { t } from '../lib/i18n';

export interface PageReviewDraft extends TextRegionReviewResult {
  baseRegionSetRevisionId: string;
  regions: Array<TextRegionReviewRegion & {
    clientItemId: string;
    originalText: string;
    targetKind: 'existing' | 'created';
    status: 'succeeded' | 'failed';
    error?: string;
    code?: string | null;
  }>;
}

function reviewRegionIsValid(region: TextRegionReviewRegion): boolean {
  return Boolean(region.text.trim())
    && region.box.length === 4
    && region.box.every(Number.isFinite);
}

function reviewFailureMessage(code?: string | null): string {
  return code === 'lmstudio_output_token_limit'
    ? t('textRegionAiReviewFailureTokenLimit')
    : t('textRegionAiReviewFailureGeneric');
}

export function TextRegionAiReviewPanel({
  draft,
  onUpdateText,
  onDiscard,
  onAdopt,
}: {
  draft: PageReviewDraft;
  onUpdateText: (index: number, text: string) => void;
  onDiscard: () => void;
  onAdopt: () => void;
}) {
  return (
    <section className="text-region-ai-review" aria-labelledby="text-region-ai-review-title">
      <div className="text-region-ai-review-heading">
        <div>
          <strong id="text-region-ai-review-title">{t('textRegionAiReviewTitle')}</strong>
          <p>{t('textRegionAiReviewDescription', String(draft.regions.length))}</p>
        </div>
        <button className="secondary-button" type="button" onClick={onDiscard}>
          {t('textRegionAiReviewDiscard')}
        </button>
      </div>
      <div className="text-region-ai-review-list">
        {draft.regions.map((item, index) => (
          <article key={`review-editor-${index}`} className={item.status === 'failed' ? 'failed' : undefined}>
            <div className="text-region-ai-review-item-heading">
              <strong>{t('textRegionAiReviewRegion', String(index + 1))}</strong>
            </div>
            <p className="text-region-ai-original">
              <span>{t('textRegionAiReviewOriginal')}</span>
              {item.originalText || t('textRegionNoSourceText')}
            </p>
            <label>
              <span>{t('textRegionAiReviewSuggested')}</span>
              <textarea
                value={item.text}
                maxLength={10000}
                disabled={item.status === 'failed'}
                onChange={(event) => onUpdateText(index, event.target.value)}
              />
            </label>
            {item.status === 'failed' && (
              <p className="text-region-ai-review-failure" role="status">
                {reviewFailureMessage(item.code)}
              </p>
            )}
          </article>
        ))}
      </div>
      <button
        className="primary-button"
        type="button"
        disabled={!draft.regions.some((item) => item.status === 'succeeded' && reviewRegionIsValid(item))}
        onClick={onAdopt}
      >
        {t('textRegionAiReviewApply')}
      </button>
    </section>
  );
}
