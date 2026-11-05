import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextRegionAiReviewPanel } from '../components/TextRegionAiReviewPanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TextRegionAiReviewPanel', () => {
  it('marks failed fields as original OCR and still allows adopting successful suggestions', () => {
    vi.stubGlobal('browser', { i18n: { getMessage: (key: string) => key } });
    const onAdopt = vi.fn();
    const { container } = render(createElement(TextRegionAiReviewPanel, {
      draft: {
        count: 2,
        baseRegionSetRevisionId: 'set-1',
        regions: [
          { clientItemId: 'region-1', originalText: 'bad one', targetKind: 'existing', box: [10, 20, 100, 80], text: 'correct one', status: 'succeeded' },
          { clientItemId: 'region-2', originalText: 'bad two', targetKind: 'existing', box: [20, 120, 120, 90], text: 'bad two', status: 'failed', code: 'lmstudio_output_token_limit' },
        ],
      },
      onUpdateText: vi.fn(),
      onDiscard: vi.fn(),
      onAdopt,
    }));

    const editors = container.querySelectorAll('textarea');
    expect(editors[0]?.disabled).toBe(false);
    expect(editors[1]?.disabled).toBe(true);
    expect(screen.getByText('textRegionAiReviewFailureTokenLimit').isConnected).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'textRegionAiReviewApply' }));
    expect(onAdopt).toHaveBeenCalledOnce();
  });
});
