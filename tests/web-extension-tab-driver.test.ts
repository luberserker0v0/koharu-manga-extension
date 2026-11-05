import { describe, expect, it, vi } from 'vitest';
import {
  WebExtensionTabDriver,
  type WebExtensionApi,
} from '../lib/comic-crawler/web-extension-tab-driver';

describe('WebExtensionTabDriver content preparation', () => {
  it('forwards reader boundaries and restores page state after cancellation', async () => {
    const controller = new AbortController();
    const calls: Array<{ name: string; argument: unknown }> = [];
    const api = {
      tabs: {
        get: vi.fn(async () => ({ id: 7, url: 'https://reader.test/chapter/1' })),
        update: vi.fn(),
      },
      scripting: {
        executeScript: vi.fn(async (details: { func: { name: string }; args?: unknown[] }) => {
          if (details.args?.some((argument) => argument === undefined)) {
            throw new Error('Value is unserializable.');
          }
          const name = details.func.name;
          calls.push({ name, argument: details.args?.[0] });
          if (name === 'countScrollPreparationCandidates') return [{ result: 2 }];
          if (name === 'scrollPreparationCandidate') controller.abort();
          return [{ result: undefined }];
        }),
      },
    };
    const driver = new WebExtensionTabDriver(api as unknown as WebExtensionApi);
    const reader = {
      containerSelector: '#reader',
      pageSelector: '[data-page]',
      endSelector: '#reader-end',
    };

    const preparation = await driver.prepareContent(7, 'scroll-through', reader, controller.signal);
    try {
      await expect(preparation.step(
        { maxActions: 4, maxDurationMs: 2_000 },
        controller.signal,
      )).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await preparation.finish();
    }

    expect(calls.find((call) => call.name === 'initializeScrollPreparation')?.argument).toEqual(reader);
    expect(calls.filter((call) => call.name === 'scrollPreparationCandidate')).toHaveLength(1);
    expect(calls.map((call) => call.name)).toEqual(expect.arrayContaining([
      'finishScrollPreparation',
      'clearScrollPreparation',
    ]));
    expect(calls.at(-1)?.name).toBe('clearScrollPreparation');
  });
});
