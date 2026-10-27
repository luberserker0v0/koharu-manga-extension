import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataUrlToBlob } from '../lib/data-url';

afterEach(() => vi.unstubAllGlobals());

describe('dataUrlToBlob', () => {
  it('decodes base64 image data without making a network request', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const blob = dataUrlToBlob('data:image/webp;base64,AQIDBA==');

    expect(blob.type).toBe('image/webp');
    expect(blob.size).toBe(4);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed data URLs with the page-image error code', () => {
    expect(() => dataUrlToBlob('https://example.com/page.webp')).toThrow('page_image_fetch_failed');
    expect(() => dataUrlToBlob('data:image/webp;base64,%%%')).toThrow('page_image_fetch_failed');
  });
});
