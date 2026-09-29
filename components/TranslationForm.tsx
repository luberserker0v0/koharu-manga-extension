import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BackendClient } from '../lib/api/backend-client';
import type { TranslationProviderCatalog, TranslationProviderModel } from '../lib/api/types';
import type { StoredBindings } from '../lib/storage/workflow';
import { createQuickIdentifiers, type TranslationFormValues } from '../lib/domain/translation-request';
import { languageLabel, languageOptions } from '../lib/domain/languages';
import { t } from '../lib/i18n';
import { ErrorNotice } from './ErrorNotice';

export function TranslationForm({ client, initial, busy, disabled, onSubmit }: {
  client: BackendClient;
  initial?: StoredBindings;
  busy: boolean;
  disabled: boolean;
  onSubmit: (values: TranslationFormValues) => void;
}) {
  const [quickIdentifiers] = useState(() => createQuickIdentifiers(initial));
  const [values, setValues] = useState<TranslationFormValues>({
    ...quickIdentifiers,
    targetLanguage: initial?.targetLanguage ?? 'zh-TW',
    sourceLanguage: initial?.sourceLanguage ?? '',
    exportFormat: (initial?.exportFormat as TranslationFormValues['exportFormat'] | undefined) ?? 'rendered',
    translationMode: 'quick',
    translationProviderId: initial?.translationProviderId ?? '',
    translationModelId: initial?.translationModelId ?? '',
  });
  const [catalog, setCatalog] = useState<TranslationProviderCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<unknown>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    setCatalogLoading(true);
    setCatalogError(null);
    void client.getTranslationProviders(controller.signal)
      .then((result) => { if (!disposed) setCatalog(result); })
      .catch((error: unknown) => {
        if (!disposed && !(error instanceof DOMException && error.name === 'AbortError')) setCatalogError(error);
      })
      .finally(() => { if (!disposed) setCatalogLoading(false); });
    return () => { disposed = true; controller.abort(); };
  }, [client]);

  const selectedTarget = values.translationProviderId && values.translationModelId
    ? JSON.stringify([values.translationProviderId, values.translationModelId])
    : '';
  const modelsByProvider = useMemo(() => catalog?.providers.map((provider) => ({
    provider,
    models: provider.models.map((model): TranslationProviderModel & { supported: boolean } => ({
      ...model,
      supported: model.languages.length === 0 || model.languages.includes(values.targetLanguage.trim()),
    })),
  })) ?? [], [catalog, values.targetLanguage]);
  const providerLanguages = useMemo(() => catalog?.providers.flatMap((provider) =>
    provider.models.flatMap((model) => model.languages)) ?? [], [catalog]);
  const targetLanguages = useMemo(
    () => languageOptions(providerLanguages, [values.targetLanguage]),
    [providerLanguages, values.targetLanguage],
  );
  const sourceLanguages = useMemo(
    () => languageOptions(providerLanguages, [values.sourceLanguage]),
    [providerLanguages, values.sourceLanguage],
  );
  const selectedChoice = modelsByProvider
    .flatMap(({ provider, models }) => models.map((model) => ({ provider, model })))
    .find(({ provider, model }) => provider.providerId === values.translationProviderId && model.modelId === values.translationModelId);
  const selectedTargetInvalid = Boolean(selectedTarget) && (
    !selectedChoice || selectedChoice.provider.status !== 'ready' || !selectedChoice.model.supported
  );

  const updateTarget = (encoded: string) => {
    if (!encoded) {
      setValues((current) => ({ ...current, translationProviderId: '', translationModelId: '' }));
      return;
    }
    const [translationProviderId, translationModelId] = JSON.parse(encoded) as [string, string];
    setValues((current) => ({ ...current, translationProviderId, translationModelId }));
  };

  const update = (key: keyof TranslationFormValues, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(values);
  };

  return (
    <section className="panel" aria-labelledby="translation-title">
      <p className="eyebrow">{t('translationEyebrow')}</p>
      <h2 id="translation-title">{t('translationTitle')}</h2>
      <p className="muted">{t('translationDescription')}</p>
      <form className="translation-form" onSubmit={submit}>
        <div className="form-grid">
          <label>
            <span>{t('targetLanguageLabel')}</span>
            <select required value={values.targetLanguage} onChange={(event) => update('targetLanguage', event.target.value)}>
              {targetLanguages.map((language) => <option key={language} value={language}>{languageLabel(language)}</option>)}
            </select>
          </label>
          <label>
            <span>{t('sourceLanguageLabel')}</span>
            <select value={values.sourceLanguage} onChange={(event) => update('sourceLanguage', event.target.value)}>
              <option value="">{t('sourceLanguageAutomatic')}</option>
              {sourceLanguages.map((language) => <option key={language} value={language}>{languageLabel(language)}</option>)}
            </select>
          </label>
          <label>
            <span>{t('exportFormatLabel')}</span>
            <select value={values.exportFormat} onChange={(event) => update('exportFormat', event.target.value)}>
              <option value="rendered">{t('exportRendered')}</option>
              <option value="psd">{t('exportPsd')}</option>
              <option value="khr">{t('exportKhr')}</option>
              <option value="inpainted">{t('exportInpainted')}</option>
            </select>
          </label>
          <label>
            <span>{t('translationTargetLabel')}</span>
            <span className="select-with-spinner">
              <select value={selectedTarget} disabled={catalogLoading} onChange={(event) => updateTarget(event.target.value)}>
                <option value="">{catalogLoading ? t('translationProvidersLoading') : t('translationTargetDefault', catalog?.defaultTarget ? `${catalog.defaultTarget.providerId}/${catalog.defaultTarget.modelId}` : t('notAvailable'))}</option>
                {modelsByProvider.map(({ provider, models }) => (
                  <optgroup key={provider.providerId} label={`${provider.name} · ${t(`translationProviderKind_${provider.kind}`)}`}>
                    {models.map((model) => (
                      <option
                        key={`${provider.providerId}/${model.modelId}`}
                        value={JSON.stringify([provider.providerId, model.modelId])}
                        disabled={provider.status !== 'ready' || !model.supported}
                      >
                        {model.name}{provider.status !== 'ready' ? ` · ${t('translationProviderUnavailable')}` : !model.supported ? ` · ${t('translationLanguageUnsupported')}` : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {catalogLoading && <span className="inline-spinner" role="status" aria-label={t('translationProvidersLoading')} />}
            </span>
          </label>
        </div>
        <p className="field-help">{t('translationTargetHelp')}</p>
        <ErrorNotice error={catalogError} />
        {selectedTargetInvalid && <div className="notice notice-error" role="alert">{t('translationTargetInvalid')}</div>}
        <div className="mode-note"><span aria-hidden="true">✦</span><span><strong>{t('quickModeName')}</strong>{t('quickModeDetail')} {t('quickIdentifiersAutomatic')}</span></div>
        <button className="primary-button" type="submit" disabled={busy || disabled || catalogLoading || selectedTargetInvalid}>
          {busy ? t('queueingTranslation') : t('startTranslation')}
        </button>
      </form>
    </section>
  );
}
