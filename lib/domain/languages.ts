export const COMMON_LANGUAGE_TAGS = [
  'ja-JP', 'zh-TW', 'zh-CN', 'en-US', 'ko-KR',
  'es-ES', 'fr-FR', 'de-DE', 'it-IT', 'pt-BR', 'pt-PT',
  'ru-RU', 'uk-UA', 'pl-PL', 'nl-NL', 'tr-TR',
  'th-TH', 'vi-VN', 'id-ID', 'ms-MY', 'ar-SA', 'hi-IN',
] as const;

export function languageOptions(extra: string[] = [], current: string[] = []): string[] {
  const values = [...COMMON_LANGUAGE_TAGS, ...extra, ...current]
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

export function languageLabel(tag: string): string {
  try {
    return `${new Intl.DisplayNames(undefined, { type: 'language' }).of(tag) ?? tag} (${tag})`;
  } catch {
    return tag;
  }
}
