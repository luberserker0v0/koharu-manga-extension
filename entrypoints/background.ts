import { apiSettingsForUntrustedContext, readApiSettingsFromStorage, UI_PREFERENCES_KEY, writePageNumberPreference } from '../lib/storage/settings';
import { ComicCrawlerClient } from '../lib/comic-crawler/client';
import { ChapterImagesVerificationRequiredError, ComicCrawlerError } from '../lib/comic-crawler/errors';
import { ComicCrawlerBrowserClientManager } from '../lib/comic-crawler/browser-client-manager';
import { ComicCrawlerBrowserTaskCoordinator } from '../lib/comic-crawler/browser-task-coordinator';
import {
  clearBrowserTask,
  readBrowserTask,
  storedTaskFromCreated,
  writeBrowserTask,
} from '../lib/comic-crawler/browser-task-store';
import type {
  AdapterDiscoveryFeature,
  ChapterImageManifestResolvePagesResponse,
  ChapterImagesProxyResponse,
  ChapterImagesVerificationData,
  ChapterRenderContext,
} from '../lib/comic-crawler/types';
import { healthUrlFromApiBase, normalizeApiBaseUrl } from '../lib/api/url';
import {
  deleteWorkflowFromStorage,
  readWorkflowFromStorage,
  readWorkflowHistoryFromStorage,
  removeWorkflowHistoryItemFromStorage,
  type StoredWorkflow,
  writeWorkflowToStorage,
} from '../lib/storage/workflow';

const PENDING_SOURCE_ORIGINS_KEY = 'pendingSourceOrigins';
const SOURCE_ACCESS_REQUEST_TTL_MS = 10 * 60 * 1000;
const COMIC_CRAWLER_MAINTENANCE_ALARM = 'comicCrawler.browserMaintenance';
const COMIC_CRAWLER_MAINTENANCE_PERIOD_MINUTES = 0.5;
const TERMINAL_CRAWLER_TASK_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function validBackendPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('://') || value.includes('\\') || value.includes('..')) return null;
  return /^\/(?:ready|runtime|uploads|source-preflight|jobs)(?:[/?]|$)/.test(value) ? value : null;
}

async function backendFetch(path: string, init: RequestInit = {}, health = false): Promise<Response> {
  const settings = await readApiSettingsFromStorage();
  const baseUrl = normalizeApiBaseUrl(settings.baseUrl);
  const url = health ? healthUrlFromApiBase(baseUrl) : `${baseUrl}${path}`;
  const headers = new Headers(init.headers);
  if (!health && settings.token) headers.set('Authorization', `Bearer ${settings.token}`);
  return fetch(url, { ...init, headers });
}

async function responseMessage(response: Response) {
  const headers = Object.fromEntries(response.headers.entries());
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('json') || contentType.startsWith('text/')) {
    return { status: response.status, statusText: response.statusText, headers, encoding: 'text' as const, body: await response.text() };
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    encoding: 'base64' as const,
    body: bytesToBase64(new Uint8Array(await response.arrayBuffer())),
  };
}

function validOriginPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const patterns = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    try {
      const url = new URL(item.replace(/\*$/, ''));
      if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/') continue;
      patterns.add(`${url.protocol}//${url.host}/*`);
    } catch { /* Ignore malformed patterns from untrusted page contexts. */ }
  }
  return [...patterns].slice(0, 100);
}

interface PendingSourceAccessRequest {
  requestId: string;
  tabId: number;
  pageUrl: string;
  origins: string[];
  createdAt: number;
}

function validPendingSourceAccess(value: unknown): PendingSourceAccessRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<PendingSourceAccessRequest>;
  const origins = validOriginPatterns(raw.origins);
  if (typeof raw.requestId !== 'string' || !raw.requestId
    || typeof raw.tabId !== 'number' || !Number.isInteger(raw.tabId)
    || typeof raw.pageUrl !== 'string' || !raw.pageUrl
    || typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)
    || Date.now() - raw.createdAt > SOURCE_ACCESS_REQUEST_TTL_MS
    || !origins.length) return undefined;
  return { requestId: raw.requestId, tabId: raw.tabId, pageUrl: raw.pageUrl, origins, createdAt: raw.createdAt };
}

function equivalentPageUrl(left: string, right: string): boolean {
  try {
    const normalizedLeft = new URL(left);
    const normalizedRight = new URL(right);
    normalizedLeft.hash = '';
    normalizedRight.hash = '';
    return normalizedLeft.href === normalizedRight.href;
  } catch {
    return false;
  }
}

function validCrawlerRenderContext(value: unknown): ChapterRenderContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { viewport?: unknown; deviceScaleFactor?: unknown };
  if (!raw.viewport || typeof raw.viewport !== 'object') return undefined;
  const viewport = raw.viewport as { width?: unknown; height?: unknown };
  if (typeof viewport.width !== 'number' || typeof viewport.height !== 'number'
    || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
    || viewport.width < 1 || viewport.width > 10_000
    || viewport.height < 1 || viewport.height > 10_000) return undefined;
  const deviceScaleFactor = raw.deviceScaleFactor;
  if (deviceScaleFactor !== undefined && (typeof deviceScaleFactor !== 'number'
    || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor < 0.1 || deviceScaleFactor > 10)) return undefined;
  return {
    viewport: { width: Math.round(viewport.width), height: Math.round(viewport.height) },
    ...(typeof deviceScaleFactor === 'number' ? { deviceScaleFactor } : {}),
  };
}

async function crawlerProxyResult<T>(operation: () => Promise<T>): Promise<
  | { ok: true; data: T }
  | { ok: false; error: { message: string; kind: ComicCrawlerError['kind']; status?: number; code?: string } }
> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    if (error instanceof ComicCrawlerError) {
      return {
        ok: false,
        error: {
          message: error.message,
          kind: error.kind,
          ...(error.status !== undefined ? { status: error.status } : {}),
          ...(error.code ? { code: error.code } : {}),
        },
      };
    }
    return {
      ok: false,
      error: {
        message: error instanceof Error ? error.message : 'ComicCrawler request failed.',
        kind: 'unavailable',
      },
    };
  }
}

export default defineBackground(() => {
  const browserClientManager = new ComicCrawlerBrowserClientManager();
  const activeChapterImageRequests = new Map<number, AbortController>();
  const browserTaskCoordinator = new ComicCrawlerBrowserTaskCoordinator(
    browserClientManager,
    readApiSettingsFromStorage,
  );

  const runBrowserMaintenance = async () => {
    const workspace = await browserTaskCoordinator.run();
    const task = workspace.task;
    if (task?.challengeDiscoveryId && !task.taskId
      && task.status === 'verification_completed'
      && task.retryNotificationSentForChallengeId !== task.challengeDiscoveryId) {
      const tabId = workspace.client.resource?.tabId;
      if (typeof tabId === 'number') {
        const marked = await writeBrowserTask({
          ...task,
          retryNotificationSentForChallengeId: task.challengeDiscoveryId,
          updatedAt: new Date().toISOString(),
        });
        try {
          await browser.tabs.sendMessage(tabId, {
            type: 'COMIC_CRAWLER_VERIFICATION_READY',
            url: task.targetUrl,
            challengeDiscoveryId: task.challengeDiscoveryId,
          });
        } catch (error) {
          const current = await readBrowserTask();
          if (current && current.challengeDiscoveryId === marked.challengeDiscoveryId
            && current.retryNotificationSentForChallengeId === marked.challengeDiscoveryId) {
            const { retryNotificationSentForChallengeId: _notification, ...retryable } = current;
            await writeBrowserTask(retryable);
          }
          throw error;
        }
      }
    }
    return workspace;
  };

  const browserClientStartup = runBrowserMaintenance().catch(() => undefined);

  const ensureBrowserMaintenanceAlarm = async () => {
    const alarm = await browser.alarms.get(COMIC_CRAWLER_MAINTENANCE_ALARM);
    if (!alarm) {
      await browser.alarms.create(COMIC_CRAWLER_MAINTENANCE_ALARM, {
        periodInMinutes: COMIC_CRAWLER_MAINTENANCE_PERIOD_MINUTES,
      });
    }
  };

  void ensureBrowserMaintenanceAlarm();
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === COMIC_CRAWLER_MAINTENANCE_ALARM) {
      void runBrowserMaintenance().catch(() => undefined);
    }
  });
  browser.runtime.onStartup.addListener(() => {
    void ensureBrowserMaintenanceAlarm();
    void runBrowserMaintenance().catch(() => undefined);
  });

  browser.runtime.onInstalled.addListener(() => {
    const local = browser.storage.local as typeof browser.storage.local & {
      setAccessLevel?: (options: { accessLevel: 'TRUSTED_CONTEXTS' }) => Promise<void>;
    };
    void local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
    void ensureBrowserMaintenanceAlarm();
  });

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && 'backendSettings' in changes) {
      void runBrowserMaintenance().catch(() => undefined);
      void browser.tabs.query({}).then(async (tabs) => {
        await Promise.allSettled(tabs.flatMap((tab) => typeof tab.id === 'number'
          ? [browser.tabs.sendMessage(tab.id, { type: 'API_SETTINGS_CHANGED' })]
          : []));
      }).catch(() => undefined);
    }
    if (areaName === 'local' && UI_PREFERENCES_KEY in changes) {
      void browser.tabs.query({}).then(async (tabs) => {
        await Promise.allSettled(tabs.flatMap((tab) => typeof tab.id === 'number'
          ? [browser.tabs.sendMessage(tab.id, { type: 'API_SETTINGS_CHANGED' })]
          : []));
      }).catch(() => undefined);
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void browserClientManager.handleTabClosed(tabId);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) {
      void readBrowserTask().then((task) => browserClientManager.handleTabUrlChanged(
        tabId,
        changeInfo.url!,
        Boolean((task?.taskId || task?.challengeDiscoveryId)
          && !TERMINAL_CRAWLER_TASK_STATES.has(task.status)),
      ));
    }
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name === 'KOHARU_BACKEND_UPLOAD') {
      const controller = new AbortController();
      let metadata: { uploadId: string; fileName: string; contentType: string; size: number } | null = null;
      const chunks: Uint8Array[] = [];
      let received = 0;
      port.onMessage.addListener((message: unknown) => {
        void (async () => {
          if (!message || typeof message !== 'object' || !('type' in message)) return;
          if (message.type === 'init') {
            const value = message as Record<string, unknown>;
            if (typeof value.uploadId !== 'string' || !value.uploadId || typeof value.fileName !== 'string' || !value.fileName
              || typeof value.size !== 'number' || value.size < 0 || !Number.isSafeInteger(value.size)) {
              port.postMessage({ type: 'error', message: 'Invalid upload request.' });
              return;
            }
            metadata = {
              uploadId: value.uploadId,
              fileName: value.fileName,
              contentType: typeof value.contentType === 'string' ? value.contentType : 'application/octet-stream',
              size: value.size,
            };
            port.postMessage({ type: 'ready' });
            return;
          }
          if (message.type === 'chunk') {
            if (!metadata || !('data' in message) || typeof message.data !== 'string') throw new Error('Invalid upload chunk.');
            const chunk = base64ToBytes(message.data);
            received += chunk.byteLength;
            if (received > metadata.size) throw new Error('Upload exceeds declared size.');
            chunks.push(chunk);
            port.postMessage({ type: 'chunk-accepted' });
            return;
          }
          if (message.type !== 'finish' || !metadata || received !== metadata.size) throw new Error('Incomplete upload request.');
          const body = new Blob(chunks.map((chunk) => Uint8Array.from(chunk).buffer), { type: metadata.contentType });
          const path = `/uploads/${encodeURIComponent(metadata.uploadId)}/files/${encodeURIComponent(metadata.fileName)}`;
          const response = await backendFetch(path, { method: 'PUT', headers: { 'Content-Type': metadata.contentType }, body, signal: controller.signal });
          if (!response.ok) {
            const detail = await response.text();
            port.postMessage({ type: 'error', status: response.status, message: detail || `Upload failed with HTTP ${response.status}.`, requestId: response.headers.get('x-request-id'), detail });
            return;
          }
          port.postMessage({ type: 'done' });
        })().catch((error: unknown) => {
          try { port.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Backend upload failed.' }); } catch { /* disconnected */ }
        });
      });
      port.onDisconnect.addListener(() => controller.abort());
      return;
    }

    if (port.name === 'KOHARU_BACKEND_SSE') {
      const controller = new AbortController();
      port.onMessage.addListener((message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'init') return;
        void (async () => {
          const jobId = 'jobId' in message && typeof message.jobId === 'string' ? message.jobId : '';
          if (!jobId) throw new Error('Invalid job ID.');
          const path = `/jobs/${encodeURIComponent(jobId)}/stream?eventMode=message`;
          const response = await backendFetch(path, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
          if (!response.ok || !response.body) throw new Error(`Event stream failed with HTTP ${response.status}.`);
          port.postMessage({ type: 'open', status: response.status, headers: Object.fromEntries(response.headers.entries()) });
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            port.postMessage({ type: 'chunk', data: bytesToBase64(value) });
          }
          port.postMessage({ type: 'done' });
        })().catch((error: unknown) => {
          if (controller.signal.aborted) return;
          try { port.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Backend event stream failed.' }); } catch { /* disconnected */ }
        });
      });
      port.onDisconnect.addListener(() => controller.abort());
    }
  });

  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return undefined;
    const requireExtensionPage = () => {
      if (sender.tab) throw new Error('comicCrawler_browser_user_gesture_required');
    };
    if (message.type === 'GET_API_SETTINGS') return readApiSettingsFromStorage().then(apiSettingsForUntrustedContext);
    if (message.type === 'SET_SHOW_PAGE_NUMBERS') {
      const showPageNumbers = 'showPageNumbers' in message && message.showPageNumbers === true;
      return writePageNumberPreference(showPageNumbers).then(apiSettingsForUntrustedContext);
    }
    if (message.type === 'CHECK_SOURCE_ORIGINS') {
      const origins = validOriginPatterns('origins' in message ? message.origins : undefined);
      return (async () => {
        if (!origins.length || await browser.permissions.contains({ origins })) return { granted: true, missing: [] };
        const missing: string[] = [];
        for (const origin of origins) {
          if (!await browser.permissions.contains({ origins: [origin] })) missing.push(origin);
        }
        const tabId = sender.tab?.id;
        const pageUrl = 'pageUrl' in message && typeof message.pageUrl === 'string'
          ? message.pageUrl
          : sender.tab?.url;
        if (typeof tabId !== 'number' || !pageUrl || !sender.tab?.url || !equivalentPageUrl(sender.tab.url, pageUrl)) {
          throw new Error('source_access_page_mismatch');
        }
        const pending: PendingSourceAccessRequest = {
          requestId: crypto.randomUUID(),
          tabId,
          pageUrl,
          origins: missing,
          createdAt: Date.now(),
        };
        await browser.storage.session.set({ [PENDING_SOURCE_ORIGINS_KEY]: pending });
        return { granted: false, missing, requestId: pending.requestId };
      })();
    }
    if (message.type === 'GET_PENDING_SOURCE_ORIGINS') {
      return (async () => {
        const stored = await browser.storage.session.get(PENDING_SOURCE_ORIGINS_KEY);
        const pending = validPendingSourceAccess(stored[PENDING_SOURCE_ORIGINS_KEY]);
        if (!pending) {
          await browser.storage.session.remove(PENDING_SOURCE_ORIGINS_KEY);
          return { origins: [] };
        }
        const requestedId = 'requestId' in message && typeof message.requestId === 'string'
          ? message.requestId
          : undefined;
        if (requestedId) {
          return requestedId === pending.requestId
            ? { origins: pending.origins, requestId: pending.requestId, pageUrl: pending.pageUrl }
            : { origins: [] };
        }
        const [active] = await browser.tabs.query({ active: true, currentWindow: true });
        if (active?.id !== pending.tabId || !active.url || !equivalentPageUrl(active.url, pending.pageUrl)) {
          return { origins: [] };
        }
        return { origins: pending.origins, requestId: pending.requestId, pageUrl: pending.pageUrl };
      })();
    }
    if (message.type === 'OPEN_SOURCE_ORIGIN_ACCESS') {
      return (async () => {
        const requestId = 'requestId' in message && typeof message.requestId === 'string' ? message.requestId : '';
        const stored = await browser.storage.session.get(PENDING_SOURCE_ORIGINS_KEY);
        const pending = validPendingSourceAccess(stored[PENDING_SOURCE_ORIGINS_KEY]);
        if (!pending || pending.requestId !== requestId || sender.tab?.id !== pending.tabId
          || !sender.tab.url || !equivalentPageUrl(sender.tab.url, pending.pageUrl)) {
          throw new Error('source_access_request_expired');
        }
        const action = browser.action as typeof browser.action & { openPopup?: () => Promise<void> };
        try {
          if (typeof action.openPopup !== 'function') throw new Error('open_popup_unavailable');
          await action.openPopup();
          return { opened: 'popup' as const };
        } catch {
          await browser.tabs.create({
            url: browser.runtime.getURL(`/popup.html?sourceAccess=${encodeURIComponent(pending.requestId)}`),
          });
          return { opened: 'tab' as const };
        }
      })();
    }
    if (message.type === 'COMPLETE_SOURCE_ORIGIN_ACCESS') {
      return (async () => {
        const requestId = 'requestId' in message && typeof message.requestId === 'string' ? message.requestId : '';
        const stored = await browser.storage.session.get(PENDING_SOURCE_ORIGINS_KEY);
        const pending = validPendingSourceAccess(stored[PENDING_SOURCE_ORIGINS_KEY]);
        if (!pending || pending.requestId !== requestId) throw new Error('source_access_request_expired');
        if (!await browser.permissions.contains({ origins: pending.origins })) {
          throw new Error('source_host_permission_required');
        }
        const tab = await browser.tabs.get(pending.tabId);
        if (!tab.url || !equivalentPageUrl(tab.url, pending.pageUrl)) throw new Error('source_access_page_mismatch');
        await browser.tabs.sendMessage(pending.tabId, {
          type: 'SOURCE_ORIGINS_GRANTED',
          requestId: pending.requestId,
          pageUrl: pending.pageUrl,
        });
        await browser.storage.session.remove(PENDING_SOURCE_ORIGINS_KEY);
        return { notified: true };
      })();
    }
    if (message.type === 'CLEAR_PENDING_SOURCE_ORIGINS') {
      return (async () => {
        const requestId = 'requestId' in message && typeof message.requestId === 'string' ? message.requestId : undefined;
        if (requestId) {
          const stored = await browser.storage.session.get(PENDING_SOURCE_ORIGINS_KEY);
          const pending = validPendingSourceAccess(stored[PENDING_SOURCE_ORIGINS_KEY]);
          if (pending && pending.requestId !== requestId) return;
        }
        await browser.storage.session.remove(PENDING_SOURCE_ORIGINS_KEY);
      })();
    }
    if (message.type === 'BACKEND_REQUEST') {
      const health = 'health' in message && message.health === true;
      const path = health ? '/health' : validBackendPath('path' in message ? message.path : undefined);
      if (!path) return Promise.reject(new Error('Invalid backend path.'));
      const method = 'method' in message && typeof message.method === 'string' ? message.method.toUpperCase() : 'GET';
      if (!['GET', 'POST', 'DELETE'].includes(method)) return Promise.reject(new Error('Invalid backend method.'));
      const rawHeaders = 'headers' in message && message.headers && typeof message.headers === 'object'
        ? message.headers as Record<string, unknown>
        : {};
      const headers = new Headers();
      for (const name of ['accept', 'content-type']) {
        const value = rawHeaders[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      const body = 'body' in message && typeof message.body === 'string' ? message.body : null;
      return backendFetch(path, { method, headers, body: ['GET', 'DELETE'].includes(method) ? null : body }).then(responseMessage);
    }
    const crawlerClient = async () => {
      const settings = await readApiSettingsFromStorage();
      if (!settings.comicCrawler.enabled) throw new Error('comicCrawler_disabled');
      return new ComicCrawlerClient(settings.comicCrawler);
    };
    const pageUrl = () => {
      const value = 'url' in message && typeof message.url === 'string' ? message.url : '';
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported_protocol');
      return parsed.toString();
    };
    const prepareCurrentCrawlerTab = async () => {
      const settings = await readApiSettingsFromStorage();
      if (!settings.comicCrawler.enabled) throw new Error('comicCrawler_disabled');
      const tab = sender.tab ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0];
      return browserClientManager.prepareTab(settings.comicCrawler, tab ?? {});
    };
    if (message.type === 'COMIC_CRAWLER_STATUS') return crawlerClient().then((client) => client.status());
    if (message.type === 'COMIC_CRAWLER_RESOLVE_ADAPTER') return crawlerClient().then((client) => client.resolveAdapter(pageUrl()));
    if (message.type === 'COMIC_CRAWLER_MANIFEST_RESOLVE') {
      const adapterId = 'adapterId' in message && typeof message.adapterId === 'string'
        ? message.adapterId.trim()
        : undefined;
      return crawlerProxyResult(async () => (
        await crawlerClient()
      ).resolveChapterImageManifest(pageUrl(), adapterId || undefined));
    }
    if (message.type === 'COMIC_CRAWLER_MANIFEST_GET') {
      const chapterId = 'chapterId' in message && typeof message.chapterId === 'string'
        ? message.chapterId.trim()
        : '';
      if (!chapterId || chapterId.length > 512) return Promise.reject(new Error('Invalid chapter ID.'));
      return crawlerProxyResult(async () => (await crawlerClient()).getChapterImageManifest(chapterId));
    }
    if (message.type === 'COMIC_CRAWLER_MANIFEST_RESOLVE_PAGES') {
      const chapterId = 'chapterId' in message && typeof message.chapterId === 'string'
        ? message.chapterId.trim()
        : '';
      const revision = 'revision' in message && typeof message.revision === 'string'
        ? message.revision
        : undefined;
      const rawUrls = 'urls' in message && Array.isArray(message.urls) ? message.urls : [];
      const urls = rawUrls.filter((url): url is string => typeof url === 'string');
      if (!chapterId || chapterId.length > 512 || urls.length !== rawUrls.length
        || urls.length < 1 || urls.length > 500) {
        return Promise.reject(new Error('Invalid chapter page resolution request.'));
      }
      return crawlerProxyResult(async () => (await crawlerClient()).resolveChapterImagePages(
        chapterId, urls, revision,
      )) as Promise<
        | { ok: true; data: ChapterImageManifestResolvePagesResponse }
        | { ok: false; error: { message: string; kind: ComicCrawlerError['kind']; status?: number; code?: string } }
      >;
    }
    if (message.type === 'COMIC_CRAWLER_CHAPTER_IMAGES') {
      return (async () => {
        const url = pageUrl();
        const tabId = sender.tab?.id;
        const requestController = new AbortController();
        if (typeof tabId === 'number') {
          activeChapterImageRequests.get(tabId)?.abort();
          activeChapterImageRequests.set(tabId, requestController);
        }
        try {
          await browserClientStartup;
          const prepared = await prepareCurrentCrawlerTab();
          if (!prepared.resource || !equivalentPageUrl(prepared.resource.url, url)) {
            throw new Error('comicCrawler_browser_target_required');
          }
          const workspace = await browserTaskCoordinator.run();
          const resource = workspace.client.resource;
          if (workspace.client.status !== 'connected' || !workspace.client.workerId || !resource
            || !equivalentPageUrl(resource.url, url)) {
            throw new Error('comicCrawler_browser_target_required');
          }
          const standaloneChallenge = workspace.task
            && !workspace.task.taskId
            && equivalentPageUrl(workspace.task.targetUrl, url)
            && workspace.task.challengeDiscoveryId
            ? workspace.task
            : undefined;
          if (standaloneChallenge && standaloneChallenge.status !== 'verification_completed'
            && !TERMINAL_CRAWLER_TASK_STATES.has(standaloneChallenge.status)) {
            const stored = standaloneChallenge.chapterImagesVerification;
            if (stored) {
              const status = standaloneChallenge.verificationStatus || stored.challengeStatus;
              return {
                kind: 'verification_required',
                data: {
                  ...stored,
                  challengeStatus: status,
                  challenge: { ...stored.challenge, status },
                },
              } satisfies ChapterImagesProxyResponse;
            }
          }
          const renderContext = validCrawlerRenderContext('renderContext' in message ? message.renderContext : undefined);
          const challengeDiscoveryId = standaloneChallenge?.status === 'verification_completed'
            ? standaloneChallenge.challengeDiscoveryId
            : undefined;
          try {
            const result = await (await crawlerClient()).extractChapterImages(url, {
              signal: requestController.signal,
              browserTarget: {
                mode: 'existing-tab',
                workerId: workspace.client.workerId,
                resourceId: resource.resourceId,
              },
              ...(renderContext ? { renderContext } : {}),
              ...(challengeDiscoveryId ? { challengeDiscoveryId } : {}),
            });
            if (challengeDiscoveryId) await clearBrowserTask();
            return result;
          } catch (error) {
            if (!(error instanceof ChapterImagesVerificationRequiredError)) throw error;
            const verification: ChapterImagesVerificationData = error.verification;
            await writeBrowserTask({
              targetUrl: url,
              challengeDiscoveryId: verification.challengeDiscoveryId,
              status: 'waiting_verification',
              verificationStatus: verification.challengeStatus,
              chapterImagesVerification: verification,
              updatedAt: new Date().toISOString(),
            });
            void runBrowserMaintenance().catch(() => undefined);
            return {
              kind: 'verification_required',
              data: verification,
              message: error.message,
            } satisfies ChapterImagesProxyResponse;
          }
        } finally {
          if (typeof tabId === 'number' && activeChapterImageRequests.get(tabId) === requestController) {
            activeChapterImageRequests.delete(tabId);
          }
        }
      })();
    }
    if (message.type === 'COMIC_CRAWLER_CHAPTER_IMAGES_CANCEL') {
      return (async () => {
        const url = pageUrl();
        const tabId = sender.tab?.id;
        if (typeof tabId === 'number') {
          activeChapterImageRequests.get(tabId)?.abort();
          activeChapterImageRequests.delete(tabId);
        }
        const task = await readBrowserTask();
        if (!task?.challengeDiscoveryId || task.taskId || !equivalentPageUrl(task.targetUrl, url)) return;
        const resource = (await browserClientManager.snapshot()).resource;
        if (!sender.tab || sender.tab.id !== resource?.tabId) throw new Error('comicCrawler_browser_target_required');
        try {
          await (await crawlerClient()).cancelVerification(task.challengeDiscoveryId);
        } finally {
          await clearBrowserTask();
        }
      })();
    }
    if (message.type === 'COMIC_CRAWLER_QUEUE_DISCOVERY') {
      const feature = 'feature' in message ? message.feature : undefined;
      if (feature !== 'specific_chapters') return Promise.reject(new Error('unsupported_adapter_feature'));
      return crawlerClient().then((client) => client.queueDiscovery(pageUrl(), feature as AdapterDiscoveryFeature));
    }
    if (message.type === 'COMIC_CRAWLER_BROWSER_STATUS') {
      return browserClientStartup
        .then(() => browserTaskCoordinator.run());
    }
    if (message.type === 'COMIC_CRAWLER_BROWSER_PREPARE_TAB') {
      return browserClientStartup.then(() => prepareCurrentCrawlerTab());
    }
    if (message.type === 'COMIC_CRAWLER_BROWSER_ENROLL') {
      requireExtensionPage();
      return readApiSettingsFromStorage().then(async (settings) => {
        if (!settings.comicCrawler.enabled) throw new Error('comicCrawler_disabled');
        return browserClientManager.enroll(settings.comicCrawler);
      });
    }
    if (message.type === 'COMIC_CRAWLER_BROWSER_CONNECT') {
      requireExtensionPage();
      return readApiSettingsFromStorage().then(async (settings) => {
        if (!settings.comicCrawler.enabled) throw new Error('comicCrawler_disabled');
        return browserClientManager.connect(settings.comicCrawler);
      });
    }
    if (message.type === 'COMIC_CRAWLER_BROWSER_DISCONNECT') {
      requireExtensionPage();
      return browserClientManager.disconnect();
    }
    if (message.type === 'COMIC_CRAWLER_BROWSER_LOGOUT') {
      requireExtensionPage();
      return Promise.all([browserClientManager.clear(), clearBrowserTask()]).then(([client]) => ({ client }));
    }
    if (message.type === 'COMIC_CRAWLER_BROWSER_REGISTER_TAB') {
      requireExtensionPage();
      return browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => browserClientManager.registerTab(tab ?? {}));
    }
    if (message.type === 'COMIC_CRAWLER_BROWSER_CREATE_TASK') {
      requireExtensionPage();
      return (async () => {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        const resource = await browserClientManager.requireApprovedTab(tab ?? {});
        const snapshot = await browserClientManager.snapshot();
        if (!snapshot.workerId) throw new Error('comicCrawler_browser_not_connected');
        const client = await crawlerClient();
        const resolution = await client.resolveAdapter(resource.url);
        const allowDiscovery = 'allowDiscovery' in message && message.allowDiscovery === true;
        if (resolution.status !== 'matched' && !allowDiscovery) {
          throw new Error('comicCrawler_browser_discovery_confirmation_required');
        }
        const result = await client.createExistingTabTask(resource.url, {
          mode: 'existing-tab',
          workerId: snapshot.workerId,
          resourceId: resource.resourceId,
        });
        const task = await writeBrowserTask(storedTaskFromCreated(resource.url, result));
        return { result, task };
      })();
    }
    if (message.type === 'COMIC_CRAWLER_BROWSER_RECOVER_TASK') {
      requireExtensionPage();
      return browser.tabs.query({ active: true, currentWindow: true })
        .then(([tab]) => browserTaskCoordinator.recoverWithCurrentTab(tab ?? {}));
    }
    if (message.type === 'COMIC_CRAWLER_BROWSER_REFRESH_TASK') {
      return browserTaskCoordinator.run().then((workspace) => workspace.task);
    }
    if (message.type === 'COMIC_CRAWLER_BROWSER_OPEN_VERIFICATION') {
      requireExtensionPage();
      return (async () => {
        const task = await readBrowserTask();
        if (!task?.challengeDiscoveryId) throw new Error('comicCrawler_browser_no_verification');
        await (await crawlerClient()).openVerification(task.challengeDiscoveryId);
        return task;
      })();
    }
    if (message.type === 'COMIC_CRAWLER_BROWSER_CONTINUE') {
      requireExtensionPage();
      return browserTaskCoordinator.continueAfterVerification();
    }
    if (message.type === 'COMIC_CRAWLER_BROWSER_CANCEL') {
      requireExtensionPage();
      return (async () => {
        const task = await readBrowserTask();
        if (!task) throw new Error('comicCrawler_browser_no_task');
        const client = await crawlerClient();
        if (task.taskId) await client.cancelTask(task.taskId);
        else if (task.challengeDiscoveryId) await client.cancelVerification(task.challengeDiscoveryId);
        else throw new Error('comicCrawler_browser_task_not_cancelable');
        return writeBrowserTask({ ...task, status: 'cancelled', updatedAt: new Date().toISOString() });
      })();
    }
    if (message.type === 'COMIC_CRAWLER_BROWSER_CLEAR_TASK') {
      requireExtensionPage();
      return clearBrowserTask();
    }
    if (message.type === 'WORKFLOW_LOAD') {
      const sourcePageUrl = 'sourcePageUrl' in message && typeof message.sourcePageUrl === 'string' ? message.sourcePageUrl : undefined;
      return readWorkflowFromStorage(sourcePageUrl);
    }
    if (message.type === 'WORKFLOW_SAVE') {
      if (!('workflow' in message) || !message.workflow || typeof message.workflow !== 'object') return Promise.reject(new Error('invalid_workflow'));
      return writeWorkflowToStorage(message.workflow as StoredWorkflow);
    }
    if (message.type === 'WORKFLOW_CLEAR') {
      const sourcePageUrl = 'sourcePageUrl' in message && typeof message.sourcePageUrl === 'string' ? message.sourcePageUrl : undefined;
      return deleteWorkflowFromStorage(sourcePageUrl);
    }
    if (message.type === 'WORKFLOW_HISTORY_LOAD') return readWorkflowHistoryFromStorage();
    if (message.type === 'WORKFLOW_HISTORY_REMOVE') {
      if (!('jobId' in message) || typeof message.jobId !== 'string' || !message.jobId) {
        return Promise.reject(new Error('invalid_job_id'));
      }
      return removeWorkflowHistoryItemFromStorage(message.jobId);
    }
    if (message.type !== 'FETCH_PAGE_IMAGE') return undefined;
    const source = 'url' in message && typeof message.url === 'string' ? message.url : '';
    return (async () => {
      try {
        const url = new URL(source);
        if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, error: 'unsupported_image_protocol' };
        const response = await fetch(url, { credentials: 'omit', redirect: 'follow' });
        if (!response.ok) return { ok: false, error: 'page_image_fetch_failed' };
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        return { ok: true, data: btoa(binary), contentType: response.headers.get('content-type') || 'application/octet-stream' };
      } catch {
        return { ok: false, error: 'page_image_fetch_failed' };
      }
    })();
  });
});
