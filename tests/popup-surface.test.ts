import { describe, expect, it } from 'vitest';
import { detectPopupSurface, markPopupSurface } from '../lib/ui/popup-surface';

describe('popup surface detection', () => {
  it('keeps a touch-capable desktop browser on the fixed desktop surface', () => {
    expect(detectPopupSurface({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/158.0.0.0 Safari/537.36',
      userAgentData: { mobile: false },
    })).toBe('desktop');
  });

  it('uses the mobile surface when User-Agent Client Hints reports mobile', () => {
    expect(detectPopupSurface({
      userAgent: 'Mozilla/5.0',
      userAgentData: { mobile: true },
    })).toBe('mobile');
  });

  it('recognizes Android when User-Agent Client Hints are unavailable', () => {
    expect(detectPopupSurface({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 4a 5G) AppleWebKit/537.36 EdgA/158.0.0.0',
    })).toBe('mobile');
  });

  it('marks the document root with the detected surface', () => {
    const root = document.createElement('html');
    expect(markPopupSurface(root, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe('desktop');
    expect(root.dataset.koharuPopupSurface).toBe('desktop');
  });
});
