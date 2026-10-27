import {
  BrowserClient,
  BrowserClientError,
  ExistingTabExecutor,
  WebExtensionTabDriver,
  type BrowserClientConnection,
  type BrowserClientOptions,
  type BrowserResourceDescriptor,
  type WebExtensionApi,
} from '@comiccrawler/browser-client-sdk';
import type { ComicCrawlerSettings } from '../api/types';
import { normalizeServiceBaseUrl } from '../api/url';
import { ChromeClientStateStore, type ExtensionStorageArea } from './browser-state-store';

export const BROWSER_RESOURCE_KEY = 'comiccrawler.approvedTabResource';
export const BROWSER_CONNECTION_ENABLED_KEY = 'comiccrawler.connectionEnabled';

export interface ApprovedTabResource extends BrowserResourceDescriptor {
  tabId: number;
}

export interface BrowserClientSnapshot {
  status: 'not_enrolled' | 'disconnected' | 'connecting' | 'connected' | 'error';
  enrolled: boolean;
  workerId?: string;
  clientId?: string;
  processInstanceId?: string;
  resource?: ApprovedTabResource;
  errorCode?: string;
}

interface BrowserClientLike {
  enroll(options?: { name?: string; credentials?: { userId: string; userToken: string } }): Promise<unknown>;
  connect(): Promise<BrowserClientConnection>;
  disconnect(): Promise<void>;
  getConnection(): BrowserClientConnection | undefined;
  registerResource(input: { kind: 'tab'; url: string; title?: string; resourceId?: string; localHandle?: unknown }): Promise<BrowserResourceDescriptor>;
  revokeResource(resourceId: string): Promise<void>;
}

type ClientFactory = (options: BrowserClientOptions) => BrowserClientLike;

function clientErrorCode(error: unknown): string {
  return error instanceof BrowserClientError ? error.code : 'BROWSER_CLIENT_UNAVAILABLE';
}

function accessiblePageUrl(value: string | undefined): string {
  if (!value) throw new Error('current_tab_inaccessible');
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('current_tab_inaccessible');
  return parsed.toString();
}

export class ComicCrawlerBrowserClientManager {
  private client?: BrowserClientLike;
  private serverUrl?: string;
  private connecting = false;
  private connectionPromise?: Promise<BrowserClientSnapshot>;
  private tabPreparationPromise?: Promise<BrowserClientSnapshot>;
  private errorCode?: string;

  constructor(
    private readonly storage: ExtensionStorageArea = browser.storage.local,
    private readonly stateStore = new ChromeClientStateStore(storage),
    private readonly createClient: ClientFactory = (options) => new BrowserClient(options),
  ) {}

  private async readResource(): Promise<ApprovedTabResource | undefined> {
    const result = await this.storage.get(BROWSER_RESOURCE_KEY);
    return result[BROWSER_RESOURCE_KEY] as ApprovedTabResource | undefined;
  }

  private async writeResource(resource?: ApprovedTabResource): Promise<void> {
    if (resource) await this.storage.set({ [BROWSER_RESOURCE_KEY]: resource });
    else await this.storage.remove(BROWSER_RESOURCE_KEY);
  }

  private async ensureClient(settings: ComicCrawlerSettings): Promise<BrowserClientLike> {
    const serverUrl = normalizeServiceBaseUrl(settings.baseUrl);
    if (this.client && this.serverUrl === serverUrl) return this.client;
    if (this.client) await this.client.disconnect().catch(() => undefined);
    const executor = new ExistingTabExecutor(
      new WebExtensionTabDriver(browser as unknown as WebExtensionApi),
    );
    this.client = this.createClient({
      serverUrl,
      executor,
      stateStore: this.stateStore,
    });
    this.serverUrl = serverUrl;
    this.errorCode = undefined;
    return this.client;
  }

  async snapshot(): Promise<BrowserClientSnapshot> {
    const state = await this.stateStore.get();
    const connection = this.client?.getConnection();
    return {
      status: connection ? 'connected' : this.connecting ? 'connecting' : this.errorCode ? 'error' : state ? 'disconnected' : 'not_enrolled',
      enrolled: Boolean(state),
      workerId: connection?.workerId,
      clientId: connection?.clientId ?? state?.clientId,
      processInstanceId: connection?.processInstanceId,
      resource: await this.readResource(),
      errorCode: this.errorCode,
    };
  }

  async enroll(settings: ComicCrawlerSettings): Promise<BrowserClientSnapshot> {
    const hasUserId = Boolean(settings.userId);
    const hasUserToken = Boolean(settings.userToken);
    if (hasUserId !== hasUserToken) throw new Error('comicCrawler_browser_credentials_incomplete');
    const client = await this.ensureClient(settings);
    try {
      await client.enroll({
        name: 'Koharu Manga Companion',
        credentials: hasUserId ? { userId: settings.userId, userToken: settings.userToken } : undefined,
      });
      await this.storage.set({ [BROWSER_CONNECTION_ENABLED_KEY]: false });
      this.errorCode = undefined;
      return await this.snapshot();
    } catch (error) {
      this.errorCode = clientErrorCode(error);
      throw error;
    }
  }

  async connect(settings: ComicCrawlerSettings): Promise<BrowserClientSnapshot> {
    if (this.connectionPromise) return this.connectionPromise;
    await this.storage.set({ [BROWSER_CONNECTION_ENABLED_KEY]: true });
    this.connectionPromise = this.connectOnce(settings);
    try {
      return await this.connectionPromise;
    } finally {
      this.connectionPromise = undefined;
    }
  }

  private async connectOnce(settings: ComicCrawlerSettings): Promise<BrowserClientSnapshot> {
    const client = await this.ensureClient(settings);
    if (client.getConnection()) return await this.snapshot();
    this.connecting = true;
    this.errorCode = undefined;
    try {
      await client.connect();
      await this.restoreApprovedResource(client);
      return await this.snapshot();
    } catch (error) {
      this.errorCode = clientErrorCode(error);
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  async autoReconnect(settings: ComicCrawlerSettings): Promise<void> {
    if (!settings.enabled || !await this.stateStore.get()) return;
    const stored = await this.storage.get(BROWSER_CONNECTION_ENABLED_KEY);
    if (stored[BROWSER_CONNECTION_ENABLED_KEY] === false) return;
    await this.connect(settings).catch(() => undefined);
  }

  async disconnect(): Promise<BrowserClientSnapshot> {
    if (this.connectionPromise) await this.connectionPromise.catch(() => undefined);
    await this.client?.disconnect();
    await this.storage.set({ [BROWSER_CONNECTION_ENABLED_KEY]: false });
    this.errorCode = undefined;
    return await this.snapshot();
  }

  async clear(): Promise<BrowserClientSnapshot> {
    if (this.connectionPromise) await this.connectionPromise.catch(() => undefined);
    await this.client?.disconnect().catch(() => undefined);
    this.client = undefined;
    this.serverUrl = undefined;
    this.errorCode = undefined;
    await Promise.all([
      this.stateStore.clear(),
      this.writeResource(),
      this.storage.remove(BROWSER_CONNECTION_ENABLED_KEY),
    ]);
    return await this.snapshot();
  }

  async registerTab(tab: { id?: number; url?: string; title?: string }): Promise<BrowserClientSnapshot> {
    const connection = this.client?.getConnection();
    if (!this.client || !connection) throw new Error('comicCrawler_browser_not_connected');
    if (typeof tab.id !== 'number') throw new Error('current_tab_inaccessible');
    const url = accessiblePageUrl(tab.url);
    const previous = await this.readResource();
    if (previous) {
      await this.client.revokeResource(previous.resourceId).catch(() => undefined);
      await this.writeResource();
    }
    const descriptor = await this.client.registerResource({
      kind: 'tab',
      url,
      title: tab.title,
      localHandle: tab.id,
    });
    await this.writeResource({ ...descriptor, tabId: tab.id });
    return await this.snapshot();
  }

  async prepareTab(
    settings: ComicCrawlerSettings,
    tab: { id?: number; url?: string; title?: string },
  ): Promise<BrowserClientSnapshot> {
    if (this.tabPreparationPromise) return this.tabPreparationPromise;
    this.tabPreparationPromise = this.prepareTabOnce(settings, tab);
    try {
      return await this.tabPreparationPromise;
    } finally {
      this.tabPreparationPromise = undefined;
    }
  }

  private async prepareTabOnce(
    settings: ComicCrawlerSettings,
    tab: { id?: number; url?: string; title?: string },
  ): Promise<BrowserClientSnapshot> {
    if (typeof tab.id !== 'number') throw new Error('current_tab_inaccessible');
    const url = accessiblePageUrl(tab.url);
    if (!await this.stateStore.get()) await this.enroll(settings);
    await this.connect(settings);
    const current = await this.readResource();
    if (current?.tabId === tab.id && current.url === url) return await this.snapshot();
    return await this.registerTab({ ...tab, url });
  }

  async requireApprovedTab(tab: { id?: number; url?: string }): Promise<ApprovedTabResource> {
    const resource = await this.readResource();
    const url = accessiblePageUrl(tab.url);
    if (!resource || tab.id !== resource.tabId || url !== resource.url) {
      throw new Error('comicCrawler_browser_tab_not_registered');
    }
    if (!this.client?.getConnection()) throw new Error('comicCrawler_browser_not_connected');
    return resource;
  }

  async handleTabClosed(tabId: number): Promise<void> {
    const resource = await this.readResource();
    if (!resource || resource.tabId !== tabId) return;
    await this.client?.revokeResource(resource.resourceId).catch(() => undefined);
    await this.writeResource();
  }

  async handleTabUrlChanged(tabId: number, url: string, preserveSameOrigin = false): Promise<void> {
    const resource = await this.readResource();
    if (!resource || resource.tabId !== tabId) return;
    let normalized: string;
    try { normalized = accessiblePageUrl(url); }
    catch { normalized = ''; }
    if (normalized === resource.url) return;
    if (preserveSameOrigin && normalized && new URL(normalized).origin === new URL(resource.url).origin) return;
    await this.client?.revokeResource(resource.resourceId).catch(() => undefined);
    await this.writeResource();
  }

  private async restoreApprovedResource(client: BrowserClientLike): Promise<void> {
    const resource = await this.readResource();
    if (!resource) return;
    try {
      const tab = await browser.tabs.get(resource.tabId);
      if (accessiblePageUrl(tab.url) !== resource.url) throw new Error('stale_resource');
      await client.registerResource({
        kind: 'tab',
        url: resource.url,
        title: resource.title,
        resourceId: resource.resourceId,
        localHandle: resource.tabId,
      });
    } catch {
      await this.writeResource();
    }
  }
}
