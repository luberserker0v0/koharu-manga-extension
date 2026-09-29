export function t(key: string, substitutions?: string | string[]): string {
  const getMessage = browser.i18n.getMessage as (messageName: string, substitutions?: string | string[]) => string;
  return getMessage(key, substitutions) || key;
}

export function optionalMessage(key: string): string {
  const getMessage = browser.i18n.getMessage as (messageName: string) => string;
  return getMessage(key);
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
