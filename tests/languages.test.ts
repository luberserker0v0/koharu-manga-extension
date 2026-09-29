import { describe, expect, it } from 'vitest';
import { languageOptions } from '../lib/domain/languages';

describe('language options', () => {
  it('combines common, provider, and restored languages without duplicates', () => {
    const options = languageOptions(['zh-TW', 'yue-HK'], ['ja']);
    expect(options.filter((value) => value === 'zh-TW')).toHaveLength(1);
    expect(options).toContain('yue-HK');
    expect(options).toContain('ja');
  });
});
