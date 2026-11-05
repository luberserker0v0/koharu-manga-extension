import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageNumberOverlay } from '../lib/page-images/page-number-overlay';
import type { PageImageCandidate } from '../lib/page-images/types';

const candidate: PageImageCandidate = {
  id: 'page-1', order: 0, sourceUrl: 'https://cdn.example/1.jpg', fileName: '001.jpg',
  width: 800, height: 1200, origin: 'dom', loadStatus: 'loaded', selected: true,
};

beforeEach(() => {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 400 });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  document.body.replaceChildren();
  document.querySelector('[data-koharu-page-numbers]')?.remove();
  vi.unstubAllGlobals();
});

describe('PageNumberOverlay', () => {
  it('positions a non-interactive page badge over the mapped image without wrapping it', () => {
    const image = document.createElement('img');
    document.body.append(image);
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
      x: 20, y: 40, left: 20, top: 40, right: 320, bottom: 540,
      width: 300, height: 500, toJSON: () => ({}),
    });
    const overlay = new PageNumberOverlay(() => new Map([[candidate.id, image]]));

    overlay.set([{ candidate, pageNumber: 1, label: '第 1 頁' }]);

    const container = document.querySelector('[data-koharu-page-numbers]') as HTMLDivElement;
    const badge = container.firstElementChild as HTMLDivElement;
    expect(document.body.firstElementChild).toBe(image);
    expect(container.style.pointerEvents).toBe('none');
    expect(badge.textContent).toBe('第 1 頁');
    expect(badge.style.display).toBe('block');
    expect(badge.style.left).toBe('26px');
    expect(badge.style.top).toBe('46px');

    overlay.destroy();
    expect(document.querySelector('[data-koharu-page-numbers]')).toBeNull();
  });

  it('removes all badges immediately when the checkbox is disabled', () => {
    const image = document.createElement('img');
    document.body.append(image);
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 210,
      width: 100, height: 200, toJSON: () => ({}),
    });
    const overlay = new PageNumberOverlay(() => new Map([[candidate.id, image]]));
    overlay.set([{ candidate, pageNumber: 1, label: 'Page 1' }]);

    overlay.set([]);

    expect(document.querySelector('[data-koharu-page-numbers]')).toBeNull();
    overlay.destroy();
  });
});
