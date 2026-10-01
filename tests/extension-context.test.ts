import { describe, expect, it } from 'vitest';
import { isExtensionContextInvalidated } from '../lib/extension-context';

describe('extension context errors', () => {
  it('recognizes Chrome invalidated-context errors', () => {
    expect(isExtensionContextInvalidated(new Error('Extension context invalidated.'))).toBe(true);
    expect(isExtensionContextInvalidated('Uncaught Error: Extension context invalidated.')).toBe(true);
  });

  it('does not hide unrelated failures', () => {
    expect(isExtensionContextInvalidated(new Error('Backend unavailable'))).toBe(false);
  });
});
