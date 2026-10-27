import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiSettingsForUntrustedContext, loadApiSettings } from '../lib/storage/settings';

describe('API settings loading', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads settings directly in trusted extension contexts', async () => {
    const sendMessage = vi.fn();
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            backendSettings: {
              baseUrl: 'http://localhost:5000/api/v1',
              token: 'secret',
            },
          }),
        },
      },
      runtime: { sendMessage },
    });

    await expect(loadApiSettings()).resolves.toMatchObject({
      baseUrl: 'http://localhost:5000/api/v1',
      token: 'secret',
      comicCrawler: { autoApplyPreviousTranslation: false },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('uses the background bridge when protected storage rejects a content script', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      baseUrl: 'http://127.0.0.1:4001/api/v1',
      token: 'protected-token',
      comicCrawler: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:4100',
        username: 'crawler',
        password: 'password',
      },
    });
    vi.stubGlobal('browser', {
      storage: { local: { get: vi.fn().mockRejectedValue(new Error('Access denied')) } },
      runtime: { sendMessage },
    });

    await expect(loadApiSettings()).resolves.toMatchObject({
      token: 'protected-token',
      comicCrawler: { enabled: true, username: 'crawler', autoApplyPreviousTranslation: false },
    });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'GET_API_SETTINGS' });
  });

  it('redacts every credential before settings cross into a content script', () => {
    expect(apiSettingsForUntrustedContext({
      baseUrl: 'http://127.0.0.1:4001/api/v1',
      token: 'backend-secret',
      comicCrawler: {
        enabled: true,
        autoApplyPreviousTranslation: false,
        baseUrl: 'http://127.0.0.1:4100',
        username: 'basic-user',
        password: 'basic-secret',
        userId: 'alice',
        userToken: 'user-secret',
      },
    })).toMatchObject({
      token: '',
      comicCrawler: { username: '', password: '', userId: '', userToken: '' },
    });
  });
});
