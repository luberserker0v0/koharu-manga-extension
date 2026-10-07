import { describe, expect, it } from 'vitest';
import { isDocumentFullscreen } from '../lib/page-images/fullscreen';

describe('page translator fullscreen visibility', () => {
  it('detects standards-based fullscreen mode', () => {
    expect(isDocumentFullscreen({ fullscreenElement: document.createElement('video') })).toBe(true);
  });

  it('detects prefixed fullscreen mode', () => {
    expect(isDocumentFullscreen({ webkitFullscreenElement: document.createElement('video') })).toBe(true);
  });

  it('keeps the translator visible outside fullscreen mode', () => {
    expect(isDocumentFullscreen({ fullscreenElement: null, webkitFullscreenElement: null })).toBe(false);
  });
});
