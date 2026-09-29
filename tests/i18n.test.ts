import { afterEach, describe, expect, it, vi } from 'vitest';
import { optionalMessage, t } from '../lib/i18n';

afterEach(() => vi.unstubAllGlobals());

describe('extension i18n fallback', () => {
  it('does not crash when no extension i18n API is available', () => {
    expect(() => t('missingMessage')).not.toThrow();
    expect(t('missingMessage')).toBe('missingMessage');
    expect(optionalMessage('missingMessage')).toBe('');
  });

  it('uses the Chrome i18n fallback when available', () => {
    vi.stubGlobal('chrome', {
      i18n: {
        getMessage: vi.fn((key: string) => key === 'hello' ? 'Hello' : ''),
      },
    });
    expect(t('hello')).toBe('Hello');
    expect(optionalMessage('unknown')).toBe('');
  });
});
