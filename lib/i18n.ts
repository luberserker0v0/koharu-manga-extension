import { browser as extensionBrowser } from 'wxt/browser';

interface ExtensionI18n {
  getMessage(messageName: string, substitutions?: string | string[]): string;
}

function i18nApi(): ExtensionI18n | null {
  const wxtI18n = extensionBrowser?.i18n as ExtensionI18n | undefined;
  if (typeof wxtI18n?.getMessage === 'function') return wxtI18n;
  const chromeI18n = (globalThis as typeof globalThis & {
    chrome?: { i18n?: ExtensionI18n };
  }).chrome?.i18n;
  return typeof chromeI18n?.getMessage === 'function' ? chromeI18n : null;
}

export function t(key: string, substitutions?: string | string[]): string {
  const api = i18nApi();
  if (!api) return key;
  try { return api.getMessage(key, substitutions) || key; }
  catch { return key; }
}

export function optionalMessage(key: string): string {
  const api = i18nApi();
  if (!api) return '';
  try { return api.getMessage(key); }
  catch { return ''; }
}

export function formatLocalDate(value: string | null | undefined): string {
  if (!value) return t('notAvailable');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('notAvailable');
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return t('notAvailable');
  if (value < 1024) return t('bytesValue', String(value));
  if (value < 1024 ** 2) return t('kilobytesValue', (value / 1024).toFixed(1));
  return t('megabytesValue', (value / (1024 ** 2)).toFixed(1));
}
