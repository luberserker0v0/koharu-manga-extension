import type { BrowserClientState, ClientStateStore } from '@comiccrawler/browser-client-sdk';

export const BROWSER_CLIENT_STATE_KEY = 'comiccrawler.browserClientState';

export interface ExtensionStorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export class ChromeClientStateStore implements ClientStateStore {
  constructor(private readonly storage: ExtensionStorageArea = browser.storage.local) {}

  async get(): Promise<BrowserClientState | undefined> {
    const result = await this.storage.get(BROWSER_CLIENT_STATE_KEY);
    return result[BROWSER_CLIENT_STATE_KEY] as BrowserClientState | undefined;
  }

  async set(state: BrowserClientState): Promise<void> {
    await this.storage.set({ [BROWSER_CLIENT_STATE_KEY]: state });
  }

  async clear(): Promise<void> {
    await this.storage.remove(BROWSER_CLIENT_STATE_KEY);
  }
}
