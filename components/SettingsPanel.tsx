import { useEffect, useState, type FormEvent } from 'react';
import type { ApiSettings } from '../lib/api/types';
import { serviceOriginPermissionPattern } from '../lib/api/url';
import { ComicCrawlerClient } from '../lib/comic-crawler/client';
import { t } from '../lib/i18n';
import { ErrorNotice } from './ErrorNotice';

export function SettingsPanel({ settings, onSave, onClose }: {
  settings: ApiSettings;
  onSave: (settings: ApiSettings) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [crawlerError, setCrawlerError] = useState<unknown>(null);
  const [crawlerCheck, setCrawlerCheck] = useState<'idle' | 'checking' | 'ready' | 'unavailable'>('idle');

  useEffect(() => setDraft(settings), [settings]);
  useEffect(() => {
    setCrawlerCheck('idle');
    setCrawlerError(null);
  }, [draft.comicCrawler.enabled, draft.comicCrawler.baseUrl, draft.comicCrawler.username, draft.comicCrawler.password]);

  const checkCrawler = async () => {
    if (!draft.comicCrawler.enabled) return;
    setCrawlerCheck('checking');
    setCrawlerError(null);
    try {
      const origins = [serviceOriginPermissionPattern(draft.comicCrawler.baseUrl)];
      if (!await browser.permissions.contains({ origins }) && !await browser.permissions.request({ origins })) {
        throw new Error('host_permission_denied');
      }
      const ready = await new ComicCrawlerClient(draft.comicCrawler).status();
      setCrawlerCheck(ready ? 'ready' : 'unavailable');
    } catch (nextError) {
      setCrawlerError(nextError);
      setCrawlerCheck('unavailable');
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await onSave(draft);
      setSaved(true);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel settings-panel" aria-labelledby="settings-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{t('settingsEyebrow')}</p>
          <h2 id="settings-title">{t('settingsTitle')}</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label={t('closeSettings')}>×</button>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          <span>{t('apiBaseUrlLabel')}</span>
          <input
            type="url"
            required
            value={draft.baseUrl}
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            placeholder={t('apiBaseUrlPlaceholder')}
          />
        </label>
        <p className="field-help">{t('apiBaseUrlHelp')}</p>
        <label>
          <span>{t('bearerTokenLabel')}</span>
          <input
            type="password"
            autoComplete="off"
            value={draft.token}
            onChange={(event) => setDraft({ ...draft, token: event.target.value })}
            placeholder={t('bearerTokenPlaceholder')}
          />
        </label>
        <p className="field-help">{t('bearerTokenHelp')}</p>
        <div className="settings-divider" />
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.comicCrawler.enabled}
            onChange={(event) => setDraft({ ...draft, comicCrawler: { ...draft.comicCrawler, enabled: event.target.checked } })}
          />
          <span>{t('comicCrawlerEnabledLabel')}</span>
        </label>
        <p className="field-help">{t('comicCrawlerEnabledHelp')}</p>
        {draft.comicCrawler.enabled && (
          <>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={draft.comicCrawler.autoApplyPreviousTranslation}
                onChange={(event) => setDraft({
                  ...draft,
                  comicCrawler: { ...draft.comicCrawler, autoApplyPreviousTranslation: event.target.checked },
                })}
              />
              <span>{t('comicCrawlerAutoApplyPreviousLabel')}</span>
            </label>
            <p className="field-help">{t('comicCrawlerAutoApplyPreviousHelp')}</p>
          </>
        )}
        <label>
          <span>{t('comicCrawlerUrlLabel')}</span>
          <input
            type="url"
            required={draft.comicCrawler.enabled}
            value={draft.comicCrawler.baseUrl}
            onChange={(event) => setDraft({ ...draft, comicCrawler: { ...draft.comicCrawler, baseUrl: event.target.value } })}
            placeholder="http://127.0.0.1:4100"
          />
        </label>
        <div className="form-grid crawler-credentials">
          <label>
            <span>{t('comicCrawlerUsernameLabel')}</span>
            <input value={draft.comicCrawler.username} autoComplete="off" onChange={(event) => setDraft({ ...draft, comicCrawler: { ...draft.comicCrawler, username: event.target.value } })} />
          </label>
          <label>
            <span>{t('comicCrawlerPasswordLabel')}</span>
            <input type="password" value={draft.comicCrawler.password} autoComplete="off" onChange={(event) => setDraft({ ...draft, comicCrawler: { ...draft.comicCrawler, password: event.target.value } })} />
          </label>
        </div>
        <p className="field-help">{t('comicCrawlerAuthHelp')}</p>
        {draft.comicCrawler.enabled && (
          <div className="connection-strip settings-connection-strip" role="status">
            <span className={`connection-dot ${crawlerCheck === 'ready' ? 'online' : ''}`} />
            <span>{crawlerCheck === 'ready' ? t('comicCrawlerReady') : crawlerCheck === 'checking' ? t('checkingComicCrawler') : crawlerCheck === 'unavailable' ? t('comicCrawlerUnavailable') : t('comicCrawlerNotChecked')}</span>
            {crawlerCheck === 'checking' && <span className="connection-spinner" aria-hidden="true" />}
            <button type="button" onClick={() => void checkCrawler()} disabled={crawlerCheck === 'checking'}>{t('checkConnection')}</button>
          </div>
        )}
        <ErrorNotice error={crawlerError} />
        <ErrorNotice error={error} />
        {saved && <div className="notice notice-success" role="status">{t('settingsSaved')}</div>}
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? t('savingSettings') : t('saveSettings')}
        </button>
      </form>
    </section>
  );
}
