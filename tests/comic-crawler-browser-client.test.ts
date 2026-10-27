import {
  BrowserClientError,
  ExistingTabExecutor,
  WebExtensionTabDriver,
  runBrowserExecutorContract,
  type BrowserClientConnection,
  type BrowserClientOptions,
  type BrowserClientState,
  type BrowserResourceDescriptor,
  type WebExtensionApi,
} from '@comiccrawler/browser-client-sdk';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComicCrawlerBrowserPanel } from '../components/ComicCrawlerBrowserPanel';
import { ComicCrawlerBrowserClientManager } from '../lib/comic-crawler/browser-client-manager';
import { ComicCrawlerBrowserTaskCoordinator } from '../lib/comic-crawler/browser-task-coordinator';
import { ChromeClientStateStore, type ExtensionStorageArea } from '../lib/comic-crawler/browser-state-store';
import type { ChallengeDiscoveryJob, CrawlerTaskDetail, StoredBrowserTask } from '../lib/comic-crawler/types';

class MemoryStorage implements ExtensionStorageArea {
  readonly values: Record<string, unknown> = {};

  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    if (!keys) return { ...this.values };
    const selected = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(selected.filter((key) => key in this.values).map((key) => [key, this.values[key]]));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, items);
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.values[key];
  }
}

const settings = {
  enabled: true,
  autoApplyPreviousTranslation: false,
  baseUrl: 'http://127.0.0.1:4100',
  username: '',
  password: '',
  userId: 'alice',
  userToken: 'top-secret-user-token',
};

const state: BrowserClientState = {
  schemaVersion: 1,
  serverUrl: settings.baseUrl,
  clientId: 'client-1',
  credentialId: 'credential-1',
  credential: 'browser-client-secret',
  registeredAt: '2026-10-18T00:00:00.000Z',
};

function fakeBrowser() {
  const tab = { id: 7, url: 'https://reader.test/chapter/1', title: 'Chapter 1', windowId: 2 };
  return {
    tab,
    api: {
      tabs: {
        get: vi.fn(async () => tab),
        update: vi.fn(async (_tabId: number, update: { active?: boolean; url?: string }) => {
          if (update.url) tab.url = update.url;
          return tab;
        }),
      },
      scripting: { executeScript: vi.fn() },
      windows: { update: vi.fn(async () => ({})) },
    },
  };
}

function fakeClientFactory(store: ChromeClientStateStore) {
  let connection: BrowserClientConnection | undefined;
  const resources = new Map<string, BrowserResourceDescriptor>();
  const client = {
    enroll: vi.fn(async (options?: { credentials?: { userId: string; userToken: string } }) => {
      expect(options?.credentials).toEqual({ userId: 'alice', userToken: 'top-secret-user-token' });
      await store.set(state);
      return state;
    }),
    connect: vi.fn(async () => {
      if (!await store.get()) throw new BrowserClientError('revoked', 'INVALID_STATE');
      connection = { clientId: 'client-1', workerId: 'worker-1', processInstanceId: 'process-1' };
      return connection;
    }),
    disconnect: vi.fn(async () => { connection = undefined; }),
    getConnection: vi.fn(() => connection),
    registerResource: vi.fn(async (input: { url: string; title?: string; resourceId?: string }) => {
      const descriptor = { resourceId: input.resourceId ?? 'resource-1', kind: 'tab' as const, url: input.url, title: input.title };
      resources.set(descriptor.resourceId, descriptor);
      return descriptor;
    }),
    revokeResource: vi.fn(async (resourceId: string) => { resources.delete(resourceId); }),
  };
  return { client, factory: vi.fn((_options: BrowserClientOptions) => client) };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ChromeClientStateStore', () => {
  it('stores the SDK state as one opaque value and clears it', async () => {
    const storage = new MemoryStorage();
    const store = new ChromeClientStateStore(storage);
    await store.set(state);
    await expect(store.get()).resolves.toEqual(state);
    await store.clear();
    await expect(store.get()).resolves.toBeUndefined();
  });
});

describe('ComicCrawlerBrowserClientManager', () => {
  it('automatically enrolls, connects, and registers the current tab idempotently', async () => {
    const storage = new MemoryStorage();
    const store = new ChromeClientStateStore(storage);
    const fake = fakeClientFactory(store);
    const extension = fakeBrowser();
    vi.stubGlobal('browser', extension.api);
    const manager = new ComicCrawlerBrowserClientManager(storage, store, fake.factory);

    const prepared = await manager.prepareTab(settings, extension.tab);
    expect(prepared).toMatchObject({
      status: 'connected',
      workerId: 'worker-1',
      resource: { resourceId: 'resource-1', tabId: 7, url: extension.tab.url },
    });
    expect(fake.client.enroll).toHaveBeenCalledOnce();
    expect(fake.client.connect).toHaveBeenCalledOnce();
    expect(fake.client.registerResource).toHaveBeenCalledOnce();

    await manager.prepareTab(settings, extension.tab);
    expect(fake.client.enroll).toHaveBeenCalledOnce();
    expect(fake.client.connect).toHaveBeenCalledOnce();
    expect(fake.client.registerResource).toHaveBeenCalledOnce();
    expect(fake.client.revokeResource).not.toHaveBeenCalled();
  });

  it('enrolls, reconnects, obtains a worker, and registers only the approved tab', async () => {
    const storage = new MemoryStorage();
    const store = new ChromeClientStateStore(storage);
    const fake = fakeClientFactory(store);
    const extension = fakeBrowser();
    vi.stubGlobal('browser', extension.api);
    const manager = new ComicCrawlerBrowserClientManager(storage, store, fake.factory);

    await manager.enroll(settings);
    await expect(store.get()).resolves.toEqual(state);
    const connected = await manager.connect(settings);
    expect(connected.workerId).toBe('worker-1');

    await expect(manager.requireApprovedTab(extension.tab)).rejects.toThrow('comicCrawler_browser_tab_not_registered');
    const registered = await manager.registerTab(extension.tab);
    expect(registered.resource).toMatchObject({ resourceId: 'resource-1', tabId: 7 });
    await expect(manager.requireApprovedTab(extension.tab)).resolves.toMatchObject({ resourceId: 'resource-1' });
    expect(fake.client.registerResource).toHaveBeenCalledWith(expect.objectContaining({ localHandle: 7 }));

    await manager.disconnect();
    const restarted = fakeClientFactory(store);
    const restartedManager = new ComicCrawlerBrowserClientManager(storage, store, restarted.factory);
    await expect(restartedManager.connect(settings)).resolves.toMatchObject({ workerId: 'worker-1' });
    expect(restarted.client.registerResource).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'resource-1',
      localHandle: 7,
    }));
  });

  it('requires enrollment again after the SDK credential is revoked', async () => {
    const storage = new MemoryStorage();
    const store = new ChromeClientStateStore(storage);
    const fake = fakeClientFactory(store);
    vi.stubGlobal('browser', fakeBrowser().api);
    const manager = new ComicCrawlerBrowserClientManager(storage, store, fake.factory);
    await manager.enroll(settings);
    await store.clear();
    await expect(manager.connect(settings)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(manager.snapshot()).resolves.toMatchObject({ enrolled: false, status: 'error' });
  });

  it('rejects inaccessible tabs and revokes a resource when its tab closes or navigates', async () => {
    const storage = new MemoryStorage();
    const store = new ChromeClientStateStore(storage);
    const fake = fakeClientFactory(store);
    vi.stubGlobal('browser', fakeBrowser().api);
    const manager = new ComicCrawlerBrowserClientManager(storage, store, fake.factory);
    await manager.enroll(settings);
    await manager.connect(settings);

    await expect(manager.registerTab({ url: 'https://reader.test' })).rejects.toThrow('current_tab_inaccessible');
    await expect(manager.registerTab({ id: 1 })).rejects.toThrow('current_tab_inaccessible');
    await manager.registerTab({ id: 7, url: 'https://reader.test/chapter/1' });
    await manager.handleTabUrlChanged(7, 'https://reader.test/chapter/2');
    expect((await manager.snapshot()).resource).toBeUndefined();

    await manager.registerTab({ id: 7, url: 'https://reader.test/chapter/1' });
    await manager.handleTabClosed(7);
    expect((await manager.snapshot()).resource).toBeUndefined();
    expect(fake.client.revokeResource).toHaveBeenCalledTimes(2);
  });

  it('keeps a same-origin tab resource during an active task challenge redirect', async () => {
    const storage = new MemoryStorage();
    const store = new ChromeClientStateStore(storage);
    const fake = fakeClientFactory(store);
    vi.stubGlobal('browser', fakeBrowser().api);
    const manager = new ComicCrawlerBrowserClientManager(storage, store, fake.factory);
    await manager.enroll(settings);
    await manager.connect(settings);
    await manager.registerTab({ id: 7, url: 'https://reader.test/chapter/1' });

    await manager.handleTabUrlChanged(7, 'https://reader.test/challenge', true);

    expect((await manager.snapshot()).resource).toMatchObject({ resourceId: 'resource-1' });
    expect(fake.client.revokeResource).not.toHaveBeenCalled();
  });

  it('does not undo an explicit disconnect during background maintenance', async () => {
    const storage = new MemoryStorage();
    const store = new ChromeClientStateStore(storage);
    const fake = fakeClientFactory(store);
    vi.stubGlobal('browser', fakeBrowser().api);
    const manager = new ComicCrawlerBrowserClientManager(storage, store, fake.factory);
    await manager.enroll(settings);
    await manager.connect(settings);
    await manager.disconnect();
    fake.client.connect.mockClear();

    await manager.autoReconnect(settings);

    expect(fake.client.connect).not.toHaveBeenCalled();
    await expect(manager.snapshot()).resolves.toMatchObject({ status: 'disconnected' });
  });

  it('never logs enrollment credentials', async () => {
    const storage = new MemoryStorage();
    const store = new ChromeClientStateStore(storage);
    const fake = fakeClientFactory(store);
    vi.stubGlobal('browser', fakeBrowser().api);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await new ComicCrawlerBrowserClientManager(storage, store, fake.factory).enroll(settings);
    const output = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
    expect(output).not.toContain(settings.userToken);
    expect(output).not.toContain(state.credential);
  });
});

describe('ComicCrawlerBrowserTaskCoordinator', () => {
  const targetUrl = 'https://reader.test/chapter/1';
  const challengeDiscoveryId = 'challenge-1';

  function detail(status: string, workerId = 'worker-1'): CrawlerTaskDetail {
    return {
      task: {
        id: 'task-1',
        url: targetUrl,
        status,
        createdAt: '2026-10-18T00:00:00.000Z',
        browserTarget: { mode: 'existing-tab', workerId, resourceId: 'resource-1' },
      },
      progress: null,
      result: {
        taskId: 'task-1',
        status,
        downloadedImages: 0,
        failedImages: 0,
        totalImages: 0,
        challengeDiscoveryId,
      },
    };
  }

  function setup(options: {
    browserWorkerId?: string;
    taskStatus?: string;
    taskWorkerId?: string;
    challengeStatus?: string;
    completedStatus?: string;
    resumeRequestedForChallengeId?: string;
  } = {}) {
    const waitingDetail = detail(options.taskStatus ?? 'waiting_verification', options.taskWorkerId ?? 'worker-1');
    const completedDetail = detail(options.completedStatus ?? 'running', options.taskWorkerId ?? 'worker-1');
    let stored: StoredBrowserTask = {
      targetUrl,
      taskId: 'task-1',
      challengeDiscoveryId,
      status: options.taskStatus ?? 'waiting_verification',
      updatedAt: '2026-10-18T00:00:00.000Z',
      resumeRequestedForChallengeId: options.resumeRequestedForChallengeId,
      detail: waitingDetail,
    };
    const manager = {
      autoReconnect: vi.fn(async () => undefined),
      connect: vi.fn(async () => undefined),
      registerTab: vi.fn(async () => ({
        status: 'connected' as const,
        enrolled: true,
        workerId: 'worker-2',
        resource: {
          resourceId: 'resource-2',
          kind: 'tab' as const,
          url: targetUrl,
          tabId: 7,
        },
      })),
      snapshot: vi.fn(async () => ({
        status: 'connected' as const,
        enrolled: true,
        workerId: options.browserWorkerId ?? 'worker-1',
        resource: {
          resourceId: 'resource-1',
          kind: 'tab' as const,
          url: targetUrl,
          tabId: 7,
        },
      })),
    };
    const client = {
      getTask: vi.fn()
        .mockResolvedValueOnce(waitingDetail)
        .mockResolvedValue(completedDetail),
      getVerification: vi.fn(async (): Promise<ChallengeDiscoveryJob> => ({
        id: challengeDiscoveryId,
        status: options.challengeStatus ?? 'browser_open',
      })),
      completeVerification: vi.fn(async (): Promise<ChallengeDiscoveryJob> => ({
        id: challengeDiscoveryId,
        status: options.challengeStatus === 'challenge_required' ? 'challenge_required' : 'ready',
      })),
      resumeTask: vi.fn(async () => undefined),
      rebindBrowserTarget: vi.fn(async () => ({
        task: {
          id: 'task-1',
          status: 'pending',
          browserTarget: { mode: 'existing-tab' as const, workerId: 'worker-2', resourceId: 'resource-2' },
        },
        previousBrowserTarget: waitingDetail.task.browserTarget!,
        recovery: {
          reason: 'browser_client_process_restarted' as const,
          reboundAt: '2026-10-19T00:00:00.000Z',
          idempotent: false,
        },
      })),
    };
    const coordinator = new ComicCrawlerBrowserTaskCoordinator(
      manager as unknown as ComicCrawlerBrowserClientManager,
      async () => ({ comicCrawler: settings }),
      {
        readTask: async () => stored,
        writeTask: async (task) => { stored = task; return task; },
        createClient: () => client,
      },
    );
    return { coordinator, client, manager, readStored: () => stored };
  }

  it('checks an open verification page and resumes the same task when it becomes ready', async () => {
    const fixture = setup();
    const workspace = await fixture.coordinator.run();

    expect(fixture.manager.autoReconnect).toHaveBeenCalledOnce();
    expect(fixture.client.completeVerification).toHaveBeenCalledWith(challengeDiscoveryId);
    expect(fixture.client.resumeTask).toHaveBeenCalledWith('task-1');
    expect(workspace.task).toMatchObject({ status: 'running', verificationStatus: 'ready' });
  });

  it('keeps waiting without resuming while the challenge is still present', async () => {
    const fixture = setup({ challengeStatus: 'challenge_required' });
    const workspace = await fixture.coordinator.run();

    expect(fixture.client.completeVerification).toHaveBeenCalledOnce();
    expect(fixture.client.resumeTask).not.toHaveBeenCalled();
    expect(workspace.task).toMatchObject({
      status: 'waiting_verification',
      verificationStatus: 'challenge_required',
    });
  });

  it('does not retry or resume against a different process-scoped Worker', async () => {
    const fixture = setup({
      browserWorkerId: 'worker-2',
      taskStatus: 'waiting_for_browser_worker',
      taskWorkerId: 'worker-1',
    });
    const workspace = await fixture.coordinator.run();

    expect(workspace.recoveryIssue).toBe('worker_changed');
    expect(fixture.client.getVerification).not.toHaveBeenCalled();
    expect(fixture.client.resumeTask).not.toHaveBeenCalled();
  });

  it('rebinds only after an explicit recovery action using the current tab', async () => {
    const fixture = setup({
      browserWorkerId: 'worker-2',
      taskStatus: 'interrupted',
      taskWorkerId: 'worker-1',
      completedStatus: 'pending',
    });

    const before = await fixture.coordinator.run();
    expect(before).toMatchObject({ recoveryIssue: 'worker_changed', canRecover: true });
    expect(fixture.client.rebindBrowserTarget).not.toHaveBeenCalled();

    const recovered = await fixture.coordinator.recoverWithCurrentTab({
      id: 7,
      url: targetUrl,
      title: 'Chapter 1',
    });

    expect(fixture.manager.registerTab).toHaveBeenCalledWith({ id: 7, url: targetUrl, title: 'Chapter 1' });
    expect(fixture.client.rebindBrowserTarget).toHaveBeenCalledWith(
      'task-1',
      { mode: 'existing-tab', workerId: 'worker-1', resourceId: 'resource-1' },
      { mode: 'existing-tab', workerId: 'worker-2', resourceId: 'resource-2' },
    );
    expect(recovered.task).toMatchObject({ status: 'pending' });
  });

  it('does not replace the approved resource when recovery is requested from another URL', async () => {
    const fixture = setup({ taskStatus: 'interrupted' });

    await expect(fixture.coordinator.recoverWithCurrentTab({
      id: 7,
      url: 'https://reader.test/chapter/2',
    })).rejects.toThrow('comicCrawler_browser_recovery_wrong_tab');

    expect(fixture.manager.registerTab).not.toHaveBeenCalled();
    expect(fixture.client.rebindBrowserTarget).not.toHaveBeenCalled();
  });

  it('does not submit the same successful resume more than once while task state catches up', async () => {
    const fixture = setup({ resumeRequestedForChallengeId: challengeDiscoveryId });
    const workspace = await fixture.coordinator.run();

    expect(workspace.task).toMatchObject({ verificationStatus: 'ready' });
    expect(fixture.client.resumeTask).not.toHaveBeenCalled();
  });

  it('marks a standalone chapter-image handoff ready without trying to resume a crawler task', async () => {
    let stored: StoredBrowserTask = {
      targetUrl,
      challengeDiscoveryId,
      status: 'waiting_verification',
      updatedAt: '2026-10-19T00:00:00.000Z',
    };
    const manager = {
      autoReconnect: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => ({
        status: 'connected' as const,
        enrolled: true,
        workerId: 'worker-1',
        resource: { resourceId: 'resource-1', kind: 'tab' as const, url: targetUrl, tabId: 7 },
      })),
    };
    const client = {
      getTask: vi.fn(),
      getVerification: vi.fn(async (): Promise<ChallengeDiscoveryJob> => ({
        id: challengeDiscoveryId,
        status: 'ready',
      })),
      completeVerification: vi.fn(),
      resumeTask: vi.fn(),
      rebindBrowserTarget: vi.fn(),
    };
    const coordinator = new ComicCrawlerBrowserTaskCoordinator(
      manager as unknown as ComicCrawlerBrowserClientManager,
      async () => ({ comicCrawler: settings }),
      {
        readTask: async () => stored,
        writeTask: async (task) => { stored = task; return task; },
        createClient: () => client,
      },
    );

    const workspace = await coordinator.run();

    expect(workspace.task).toMatchObject({
      status: 'verification_completed',
      verificationStatus: 'ready',
      challengeDiscoveryId,
    });
    expect(client.resumeTask).not.toHaveBeenCalled();
  });

  it('makes a failed standalone verification terminal so a later request can start over', async () => {
    let stored: StoredBrowserTask = {
      targetUrl,
      challengeDiscoveryId,
      status: 'waiting_verification',
      updatedAt: '2026-10-19T00:00:00.000Z',
    };
    const manager = {
      autoReconnect: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => ({
        status: 'connected' as const,
        enrolled: true,
        workerId: 'worker-1',
        resource: { resourceId: 'resource-1', kind: 'tab' as const, url: targetUrl, tabId: 7 },
      })),
    };
    const client = {
      getTask: vi.fn(),
      getVerification: vi.fn(async (): Promise<ChallengeDiscoveryJob> => ({
        id: challengeDiscoveryId,
        status: 'failed',
        error: 'Verification failed.',
      })),
      completeVerification: vi.fn(),
      resumeTask: vi.fn(),
      rebindBrowserTarget: vi.fn(),
    };
    const coordinator = new ComicCrawlerBrowserTaskCoordinator(
      manager as unknown as ComicCrawlerBrowserClientManager,
      async () => ({ comicCrawler: settings }),
      {
        readTask: async () => stored,
        writeTask: async (task) => { stored = task; return task; },
        createClient: () => client,
      },
    );

    const workspace = await coordinator.run();

    expect(workspace.task).toMatchObject({ status: 'failed', verificationStatus: 'failed' });
    expect(client.completeVerification).not.toHaveBeenCalled();
  });
});

describe('WebExtension existing-tab executor contract', () => {
  it('passes the SDK-provided browser executor contract', async () => {
    const initialUrl = 'https://reader.test/chapter/1';
    const navigationUrl = 'https://reader.test/chapter/2';
    const html = '<html><body><img src="page.jpg"></body></html>';
    const extension = fakeBrowser();
    extension.tab.url = initialUrl;
    extension.api.scripting.executeScript.mockImplementation(async (details: { func: (...args: unknown[]) => unknown }) => {
      const source = details.func.toString();
      if (source.includes('document.documentElement.outerHTML')) return [{ result: html }];
      if (source.includes('document.readyState')) return [{ result: true }];
      return [{ result: undefined }];
    });

    const result = await runBrowserExecutorContract({
      createExecutor: () => new ExistingTabExecutor(new WebExtensionTabDriver(extension.api as unknown as WebExtensionApi)),
      request: {
        sessionId: 'session-1',
        leaseId: 'lease-1',
        source: {
          type: 'existing-resource',
          resourceId: 'resource-1',
          expectedUrl: initialUrl,
          navigationPolicy: 'adopt-current-page',
        },
      },
      resource: {
        descriptor: { resourceId: 'resource-1', kind: 'tab', url: initialUrl },
        localHandle: 7,
      },
      expectedInitialUrl: initialUrl,
      expectedInitialHtml: html,
      navigationUrl,
    });

    expect(result.capabilities.executionMode).toBe('existing-tab');
    expect(result.checks).toContain('rendered-dom');
    expect(result.checks).toContain('focus');
  });
});

describe('ComicCrawlerBrowserPanel discovery confirmation', () => {
  const workspace = {
    client: {
      status: 'connected' as const,
      enrolled: true,
      workerId: 'worker-1',
      resource: {
        resourceId: 'resource-1',
        kind: 'tab' as const,
        url: 'https://unsupported.test/chapter',
        tabId: 7,
      },
    },
  };

  it('does not create a task when the user rejects unmatched-adapter discovery', async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'COMIC_CRAWLER_BROWSER_STATUS') return workspace;
      if (message.type === 'COMIC_CRAWLER_RESOLVE_ADAPTER') return { status: 'not_found' };
      throw new Error(`Unexpected message: ${message.type}`);
    });
    vi.stubGlobal('browser', { runtime: { sendMessage } });
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(createElement(ComicCrawlerBrowserPanel));
    fireEvent.click(await screen.findByRole('button', { name: 'browserClientCreateTask' }));

    await waitFor(() => expect(window.confirm).toHaveBeenCalledOnce());
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'COMIC_CRAWLER_BROWSER_CREATE_TASK',
    }));
  });

  it('passes an explicit discovery flag after the user confirms', async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'COMIC_CRAWLER_BROWSER_STATUS') return workspace;
      if (message.type === 'COMIC_CRAWLER_RESOLVE_ADAPTER') return { status: 'not_found' };
      if (message.type === 'COMIC_CRAWLER_BROWSER_CREATE_TASK') return {};
      throw new Error(`Unexpected message: ${message.type}`);
    });
    vi.stubGlobal('browser', { runtime: { sendMessage } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(createElement(ComicCrawlerBrowserPanel));
    fireEvent.click(await screen.findByRole('button', { name: 'browserClientCreateTask' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
      type: 'COMIC_CRAWLER_BROWSER_CREATE_TASK',
      allowDiscovery: true,
    }));
  });

  it('offers explicit recovery and sends no rebind request before the user clicks it', async () => {
    const recoverableWorkspace = {
      ...workspace,
      canRecover: true,
      recoveryIssue: 'worker_changed' as const,
      task: {
        targetUrl: workspace.client.resource.url,
        taskId: 'task-1',
        status: 'interrupted',
        updatedAt: '2026-10-19T00:00:00.000Z',
      },
    };
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'COMIC_CRAWLER_BROWSER_STATUS') return recoverableWorkspace;
      if (message.type === 'COMIC_CRAWLER_BROWSER_RECOVER_TASK') return recoverableWorkspace;
      throw new Error(`Unexpected message: ${message.type}`);
    });
    vi.stubGlobal('browser', { runtime: { sendMessage } });

    render(createElement(ComicCrawlerBrowserPanel));
    const recover = await screen.findByRole('button', { name: 'browserClientRecoverTask' });
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'COMIC_CRAWLER_BROWSER_RECOVER_TASK',
    }));

    fireEvent.click(recover);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
      type: 'COMIC_CRAWLER_BROWSER_RECOVER_TASK',
    }));
  });
});
