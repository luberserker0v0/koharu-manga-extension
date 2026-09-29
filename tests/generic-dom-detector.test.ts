import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenericDomImageDetector, type GenericDetectorLimits } from '../lib/page-images/generic-dom-detector';

const limits: GenericDetectorLimits = {
  maxViewportAdvances: 3,
  maxDurationMs: 1_000,
  maxCandidates: 10,
  settleMs: 0,
  imageLoadTimeoutMs: 10,
};

function mangaImage(src: string, width = 800, height = 1200): HTMLImageElement {
  const image = document.createElement('img');
  image.src = src;
  Object.defineProperties(image, {
    complete: { value: true, configurable: true },
    naturalWidth: { value: width, configurable: true },
    naturalHeight: { value: height, configurable: true },
  });
  image.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) });
  return image;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('GenericDomImageDetector', () => {
  it('filters small decorations and preserves document order', async () => {
    document.body.append(mangaImage('https://cdn.test/002.jpg'), mangaImage('https://cdn.test/001.jpg'));
    const icon = mangaImage('https://cdn.test/icon.png', 32, 32);
    document.body.append(icon);
    const result = await new GenericDomImageDetector(limits).detect(location.href);
    expect(result.images.map((image) => image.fileName)).toEqual(['002.jpg', '001.jpg']);
    expect(result.images.every((image) => image.loadStatus === 'loaded')).toBe(true);
  });

  it('deduplicates a URL and keeps the higher-resolution image', async () => {
    document.body.append(mangaImage('https://cdn.test/page.jpg', 400, 600), mangaImage('https://cdn.test/page.jpg', 1200, 1800));
    const result = await new GenericDomImageDetector(limits).detect(location.href);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.width).toBe(1200);
  });

  it('restores the original scroll position after a deep scan', async () => {
    document.body.append(mangaImage('https://cdn.test/page.jpg'));
    Object.defineProperty(window, 'scrollX', { value: 12, writable: true, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 34, writable: true, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 800, configurable: true });
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    await new GenericDomImageDetector(limits).detect(location.href, { deep: true });
    expect(scroll).toHaveBeenLastCalledWith({ left: 12, top: 34, behavior: 'auto' });
  });

  it('honors cancellation before scanning', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const controller = new AbortController();
    controller.abort();
    await expect(new GenericDomImageDetector(limits).detect(location.href, { deep: true, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
