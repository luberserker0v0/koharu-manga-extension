import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationForm } from '../components/TranslationForm';
import type { BackendClient } from '../lib/api/backend-client';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TranslationForm source languages', () => {
  it('restores a legacy language and submits an ordered language combination', async () => {
    vi.stubGlobal('browser', { i18n: { getMessage: (key: string) => key } });
    const client = {
      getTranslationProviders: vi.fn().mockResolvedValue({ providers: [], defaultTarget: null }),
    } as unknown as BackendClient;
    const onSubmit = vi.fn();
    const { container } = render(createElement(TranslationForm, {
      client,
      initial: {
        mangaId: 'manga', translatorId: 'translator', chapterId: 'chapter',
        targetLanguage: 'zh-TW', sourceLanguage: 'en-US', exportFormat: 'rendered',
      },
      busy: false,
      disabled: false,
      onSubmit,
    }));

    await waitFor(() => expect(client.getTranslationProviders).toHaveBeenCalled());
    const sourceSelect = container.querySelector('.source-language-field select') as HTMLSelectElement;
    fireEvent.change(sourceSelect, { target: { value: 'ja-JP' } });
    const moveUpButtons = screen.getAllByRole('button', { name: 'sourceLanguageMoveUp' });
    fireEvent.click(moveUpButtons[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'startTranslation' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      sourceLanguage: ['ja-JP', 'en-US'],
    }));
  });
});
