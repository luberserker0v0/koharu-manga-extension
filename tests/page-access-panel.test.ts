import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageAccessPanel } from '../components/PageAccessPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PageAccessPanel source access continuation', () => {
  it('notifies the original page after granting the pending image origins', async () => {
    window.history.replaceState({}, '', '/?sourceAccess=source-request-1');
    const sendMessage = vi.fn(async (message: { type: string; requestId?: string }) => {
      if (message.type === 'GET_PENDING_SOURCE_ORIGINS') {
        return { origins: ['https://cdn.example/*'], requestId: 'source-request-1' };
      }
      if (message.type === 'COMPLETE_SOURCE_ORIGIN_ACCESS') return { notified: true };
      throw new Error(`Unexpected message ${message.type}`);
    });
    const request = vi.fn(async () => true);
    vi.stubGlobal('browser', {
      tabs: {
        query: vi.fn(async () => [{ id: 7, url: 'https://reader.example/chapter/1' }]),
        sendMessage: vi.fn(async () => ({ ok: true })),
        reload: vi.fn(),
      },
      permissions: {
        contains: vi.fn(async () => true),
        request,
      },
      runtime: { sendMessage },
      scripting: { executeScript: vi.fn() },
    });
    vi.spyOn(window, 'close').mockImplementation(() => undefined);

    render(createElement(PageAccessPanel));
    fireEvent.click(await screen.findByRole('button', { name: 'enableSourceAccess' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
      type: 'COMPLETE_SOURCE_ORIGIN_ACCESS',
      requestId: 'source-request-1',
    }));
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'GET_PENDING_SOURCE_ORIGINS',
      requestId: 'source-request-1',
    });
    expect(request).toHaveBeenCalledWith({ origins: ['https://cdn.example/*'] });
    expect(window.close).toHaveBeenCalledOnce();
  });
});
