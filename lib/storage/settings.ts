import type { ApiSettings } from '../api/types';
import { normalizeApiBaseUrl, normalizeServiceBaseUrl, originPermissionPattern, serviceOriginPermissionPattern } from '../api/url';

const SETTINGS_KEY = 'backendSettings';

export const DEFAULT_API_SETTINGS: ApiSettings = {
  baseUrl: 'http://127.0.0.1:4001/api/v1',
  token: '',
  comicCrawler: {
    enabled: false,
    autoApplyPreviousTranslation: false,
    baseUrl: 'http://127.0.0.1:4100',
    username: '',
    password: '',
    userId: '',
    userToken: '',
  },
};

function apiSettingsFromStored(value: Partial<ApiSettings> | undefined): ApiSettings {
  return {
    baseUrl: value?.baseUrl || DEFAULT_API_SETTINGS.baseUrl,
    token: value?.token || '',
    comicCrawler: {
      ...DEFAULT_API_SETTINGS.comicCrawler,
      ...(value?.comicCrawler ?? {}),
    },
  };
}

export async function readApiSettingsFromStorage(): Promise<ApiSettings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY] as Partial<ApiSettings> | undefined;
  return apiSettingsFromStored(value);
}

export function apiSettingsForUntrustedContext(settings: ApiSettings): ApiSettings {
  return {
    ...settings,
    token: '',
    comicCrawler: {
      ...settings.comicCrawler,
      username: '',
      password: '',
      userId: '',
      userToken: '',
    },
  };
}

export async function loadApiSettings(): Promise<ApiSettings> {
  try {
    return await readApiSettingsFromStorage();
  } catch {
    // Chrome can restrict storage.local to trusted extension contexts. Content
    // scripts then retrieve settings through the background service worker,
    // while credentials remain persisted only in protected extension storage.
    const settings = await browser.runtime.sendMessage({ type: 'GET_API_SETTINGS' }) as ApiSettings | undefined;
    if (!settings) throw new Error('settings_unavailable');
    return apiSettingsFromStored(settings);
  }
}

export async function saveApiSettings(settings: ApiSettings): Promise<ApiSettings> {
  const normalized: ApiSettings = {
    baseUrl: normalizeApiBaseUrl(settings.baseUrl),
    token: settings.token.trim(),
    comicCrawler: {
      enabled: settings.comicCrawler.enabled,
      autoApplyPreviousTranslation: settings.comicCrawler.autoApplyPreviousTranslation,
      baseUrl: normalizeServiceBaseUrl(settings.comicCrawler.baseUrl),
      username: settings.comicCrawler.username.trim(),
      password: settings.comicCrawler.password,
      userId: settings.comicCrawler.userId.trim(),
      userToken: settings.comicCrawler.userToken.trim(),
    },
  };
  const origins = [originPermissionPattern(normalized.baseUrl)];
  if (normalized.comicCrawler.enabled) origins.push(serviceOriginPermissionPattern(normalized.comicCrawler.baseUrl));
  const hasPermission = await browser.permissions.contains({ origins });
  if (!hasPermission) {
    const granted = await browser.permissions.request({ origins });
    if (!granted) throw new Error('host_permission_denied');
  }
  await browser.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}
