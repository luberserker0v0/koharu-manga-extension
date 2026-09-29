import { describe, expect, it } from 'vitest';
import { buildQuickTranslationRequest, createQuickIdentifiers } from '../lib/domain/translation-request';

describe('browser-safe translation request', () => {
  it('uses source preflight and never sends outputDir', () => {
    const request = buildQuickTranslationRequest({
      translationMode: 'quick',
      targetLanguage: 'zh-TW',
      sourceLanguage: 'ja',
      exportFormat: 'rendered',
      mangaId: 'my_manga',
      translatorId: 'quick_output',
      chapterId: 'ch_001',
      translationProviderId: 'deepl',
      translationModelId: 'mt',
    }, 'preflight-123');

    expect(request).toMatchObject({
      translationMode: 'quick',
      sourcePreflightId: 'preflight-123',
      mangaId: 'my_manga',
      translatorId: 'quick_output',
      chapterId: 'ch_001',
      translationTarget: { providerId: 'deepl', modelId: 'mt' },
    });
    expect(request).not.toHaveProperty('outputDir');
  });

  it('omits translationTarget when using the backend default', () => {
    const request = buildQuickTranslationRequest({
      translationMode: 'quick', targetLanguage: 'zh-TW', sourceLanguage: '', exportFormat: 'rendered',
      mangaId: 'manga', translatorId: 'quick_output', chapterId: 'chapter',
      translationProviderId: '', translationModelId: '',
    }, 'preflight-1');
    expect(request).not.toHaveProperty('translationTarget');
  });

  it('generates hidden Quick-mode publication identifiers', () => {
    const identifiers = createQuickIdentifiers();
    expect(identifiers.mangaId).toMatch(/^quick_manga_[0-9a-f]+$/);
    expect(identifiers.chapterId).toMatch(/^chapter_[0-9a-f]+$/);
    expect(identifiers.translatorId).toBe('quick_output');
  });

  it('repairs identifiers restored from an older Quick-mode workflow', () => {
    const identifiers = createQuickIdentifiers({
      mangaId: 'quick-manga-24aba762-914f-466a-b2db-84f8fa0f4648',
      translatorId: 'Quick Output',
      chapterId: 'Chapter-01',
    });
    expect(identifiers).toEqual({
      mangaId: 'quick_manga_24aba762_914f_466a_b2db_84f8fa0f4648',
      translatorId: 'quick_output',
      chapterId: 'chapter_01',
    });
  });

  it('normalizes identifiers again when creating the backend request', () => {
    const request = buildQuickTranslationRequest({
      translationMode: 'quick', targetLanguage: 'zh-TW', sourceLanguage: '', exportFormat: 'rendered',
      mangaId: 'Quick-Manga-01', translatorId: 'Quick Output', chapterId: 'Chapter-01',
      translationProviderId: '', translationModelId: '',
    }, 'preflight-1');
    expect(request).toMatchObject({
      mangaId: 'quick_manga_01',
      translatorId: 'quick_output',
      chapterId: 'chapter_01',
    });
  });
});
