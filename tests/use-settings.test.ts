import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSettings } from '../hooks/useSettings';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useSettings synchronization', () => {
  it('reloads protected settings after the background notifies an open page', async () => {
    let listener: ((message: unknown) => void) | undefined;
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({
        baseUrl: 'http://192.168.31.15:4001/api/v1',
        token: '',
        comicCrawler: {
          enabled: false,
          baseUrl: 'http://192.168.31.15:4100',
          username: '',
          password: '',
          userId: '',
          userToken: '',
        },
      })
      .mockResolvedValueOnce({
        baseUrl: 'http://192.168.31.15:4001/api/v1',
        token: '',
        comicCrawler: {
          enabled: true,
          baseUrl: 'http://192.168.31.15:4100',
          username: '',
          password: '',
          userId: '',
          userToken: '',
        },
      });
    const removeListener = vi.fn();
    vi.stubGlobal('browser', {
      storage: { local: { get: vi.fn().mockRejectedValue(new Error('Access denied')) } },
      runtime: {
        sendMessage,
        onMessage: {
          addListener: vi.fn((next) => { listener = next; }),
          removeListener,
        },
      },
    });

    const { result, unmount } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings?.comicCrawler.enabled).toBe(false));

    act(() => listener?.({ type: 'API_SETTINGS_CHANGED' }));
    await waitFor(() => expect(result.current.settings?.comicCrawler.enabled).toBe(true));
    expect(sendMessage).toHaveBeenCalledTimes(2);

    unmount();
    expect(removeListener).toHaveBeenCalledWith(listener);
  });
});
