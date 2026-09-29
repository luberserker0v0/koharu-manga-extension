import { useEffect, useState } from 'react';
import { t } from '../lib/i18n';
import { pageOriginPattern } from '../lib/page-images/site-access';

export function PageAccessPanel() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [pattern, setPattern] = useState<string | null>(null);
  const [granted, setGranted] = useState(false);
  const [pendingSourceOrigins, setPendingSourceOrigins] = useState<string[]>([]);
  const [error, setError] = useState(false);
  const [sourceError, setSourceError] = useState(false);

  useEffect(() => {
    void (async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const nextPattern = tab?.url ? pageOriginPattern(tab.url) : null;
      setTabId(tab?.id ?? null);
      setPattern(nextPattern);
      if (nextPattern) setGranted(await browser.permissions.contains({ origins: [nextPattern] }));
      const pending = await browser.runtime.sendMessage({ type: 'GET_PENDING_SOURCE_ORIGINS' }) as { origins?: string[] } | undefined;
      setPendingSourceOrigins(pending?.origins ?? []);
      if (nextPattern && tab?.id !== undefined) {
        try {
          await browser.tabs.sendMessage(tab.id, { type: 'KOHARU_PAGE_PING' });
        } catch {
          // Opening the extension grants activeTab access for this tab. Injecting
          // here makes the page action available immediately, while permanent
          // per-site access remains optional.
          try {
            await browser.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['/content-scripts/page-translator.js'],
            });
          } catch {
            // Restricted browser pages and discarded tabs cannot be scripted.
            // The access panel already reports those URLs as unavailable.
          }
        }
      }
    })();
  }, []);

  const enable = async () => {
    if (!pattern || tabId === null) return;
    setError(false);
    const accepted = await browser.permissions.request({ origins: [pattern] });
    if (!accepted) { setError(true); return; }
    setGranted(true);
    await browser.tabs.reload(tabId);
    window.close();
  };

  const enableSourceOrigins = async () => {
    if (!pendingSourceOrigins.length) return;
    setSourceError(false);
    const accepted = await browser.permissions.request({ origins: pendingSourceOrigins });
    if (!accepted) { setSourceError(true); return; }
    await browser.runtime.sendMessage({ type: 'CLEAR_PENDING_SOURCE_ORIGINS' });
    setPendingSourceOrigins([]);
    window.close();
  };

  return (
    <>
      <section className="page-access-strip">
        <span>{granted ? t('pageAccessEnabled') : pattern ? t('pageAccessDescription') : t('pageAccessUnavailable')}</span>
        {pattern && !granted && <button type="button" onClick={() => void enable()}>{t('enablePageTranslation')}</button>}
        {error && <small>{t('error_host_permission_denied')}</small>}
      </section>
      {pendingSourceOrigins.length > 0 && (
        <section className="page-access-strip source-access-strip">
          <span>{t('sourceAccessDescription', String(pendingSourceOrigins.length))}</span>
          <button type="button" onClick={() => void enableSourceOrigins()}>{t('enableSourceAccess')}</button>
          {sourceError && <small>{t('error_host_permission_denied')}</small>}
        </section>
      )}
    </>
  );
}
