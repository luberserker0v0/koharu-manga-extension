import { useCallback, useEffect, useState } from 'react';
import type { ApiSettings } from '../lib/api/types';
import { DEFAULT_API_SETTINGS, loadApiSettings, saveApiSettings, savePageNumberPreference } from '../lib/storage/settings';

export function useSettings() {
  const [settings, setSettings] = useState<ApiSettings | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void loadApiSettings()
        .then((next) => { if (active) setSettings(next); })
        .catch(() => {
          if (active) {
            setSettings({
              ...DEFAULT_API_SETTINGS,
              comicCrawler: { ...DEFAULT_API_SETTINGS.comicCrawler },
            });
          }
        });
    };
    const listener = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)
        || message.type !== 'API_SETTINGS_CHANGED') return;
      refresh();
    };
    browser.runtime.onMessage.addListener(listener);
    refresh();
    return () => {
      active = false;
      browser.runtime.onMessage.removeListener(listener);
    };
  }, []);

  const save = useCallback(async (next: ApiSettings) => {
    const saved = await saveApiSettings(next);
    setSettings(saved);
  }, []);

  const setShowPageNumbers = useCallback(async (showPageNumbers: boolean) => {
    const saved = await savePageNumberPreference(showPageNumbers);
    setSettings(saved);
  }, []);

  return { settings, save, setShowPageNumbers };
}
