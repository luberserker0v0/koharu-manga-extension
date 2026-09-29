import { useCallback, useEffect, useState } from 'react';
import type { ApiSettings } from '../lib/api/types';
import { DEFAULT_API_SETTINGS, loadApiSettings, saveApiSettings } from '../lib/storage/settings';

export function useSettings() {
  const [settings, setSettings] = useState<ApiSettings | null>(null);

  useEffect(() => {
    void loadApiSettings()
      .then(setSettings)
      .catch(() => setSettings({
        ...DEFAULT_API_SETTINGS,
        comicCrawler: { ...DEFAULT_API_SETTINGS.comicCrawler },
      }));
  }, []);

  const save = useCallback(async (next: ApiSettings) => {
    const saved = await saveApiSettings(next);
    setSettings(saved);
  }, []);

  return { settings, save };
}
