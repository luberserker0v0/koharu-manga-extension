import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScrollControls } from '../components/ScrollControls';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ScrollControls', () => {
  it('scrolls its popup container to both document edges', () => {
    vi.stubGlobal('browser', { i18n: { getMessage: (key: string) => key } });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('MutationObserver', class {
      observe() { /* Test double. */ }
      disconnect() { /* Test double. */ }
    });
    const scrollTo = vi.fn();
    const container = {
      scrollTop: 200,
      scrollHeight: 1200,
      clientHeight: 600,
      children: [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      scrollTo,
    } as unknown as HTMLElement;
    const containerRef = { current: container };

    render(createElement(ScrollControls, {
      containerRef,
      className: 'test-scroll-controls',
      label: 'popupScrollControls',
    }));

    fireEvent.click(screen.getByRole('button', { name: 'scrollToTop' }));
    fireEvent.click(screen.getByRole('button', { name: 'scrollToBottom' }));

    expect(scrollTo).toHaveBeenNthCalledWith(1, { top: 0, behavior: 'smooth' });
    expect(scrollTo).toHaveBeenNthCalledWith(2, { top: 1200, behavior: 'smooth' });
  });
});
