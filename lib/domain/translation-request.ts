import type { ExportFormat, TranslationJobRequest, TranslationMode } from '../api/types';

export interface TranslationFormValues {
  mangaId: string;
  translatorId: string;
  chapterId: string;
  targetLanguage: string;
  sourceLanguage: string;
  exportFormat: ExportFormat;
  translationMode: TranslationMode;
  translationProviderId: string;
  translationModelId: string;
}

const API_IDENTIFIER_PATTERN = /^[a-z0-9_]+$/;

export function normalizeApiIdentifier(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function quickIdentifier(value: string | undefined, fallback: string): string {
  const normalized = normalizeApiIdentifier(value ?? '');
  return normalized && API_IDENTIFIER_PATTERN.test(normalized) ? normalized : fallback;
}

export function createQuickIdentifiers(initial?: Partial<Pick<TranslationFormValues, 'mangaId' | 'translatorId' | 'chapterId'>>): Pick<TranslationFormValues, 'mangaId' | 'translatorId' | 'chapterId'> {
  const id = crypto.randomUUID().replace(/-/g, '');
  return {
    mangaId: quickIdentifier(initial?.mangaId, `quick_manga_${id}`),
    translatorId: quickIdentifier(initial?.translatorId, 'quick_output'),
    chapterId: quickIdentifier(initial?.chapterId, `chapter_${id}`),
  };
}

export function buildQuickTranslationRequest(
  values: TranslationFormValues,
  sourcePreflightId: string,
): TranslationJobRequest {
  const providerId = values.translationProviderId.trim();
  const modelId = values.translationModelId.trim();
  if (Boolean(providerId) !== Boolean(modelId)) throw new Error('translation_target_incomplete');
  return {
    translationMode: 'quick',
    ...(providerId && modelId ? { translationTarget: { providerId, modelId } } : {}),
    targetLanguage: values.targetLanguage.trim(),
    qualityCheck: false,
    exportFormat: values.exportFormat,
    mangaId: normalizeApiIdentifier(values.mangaId),
    translatorId: normalizeApiIdentifier(values.translatorId),
    chapterId: normalizeApiIdentifier(values.chapterId),
    sourcePreflightId,
    ...(values.sourceLanguage.trim() ? { sourceLanguage: values.sourceLanguage.trim() } : {}),
  };
}
