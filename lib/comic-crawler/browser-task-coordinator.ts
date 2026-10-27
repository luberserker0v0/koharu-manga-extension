import type { ComicCrawlerSettings } from '../api/types';
import type { BrowserClientSnapshot, ComicCrawlerBrowserClientManager } from './browser-client-manager';
import { ComicCrawlerClient } from './client';
import { ComicCrawlerError } from './errors';
import {
  readBrowserTask,
  storedTaskFromDetail,
  writeBrowserTask,
} from './browser-task-store';
import type {
  BrowserTarget,
  BrowserTaskRecoveryIssue,
  ChallengeDiscoveryJob,
  CrawlerTaskDetail,
  RebindBrowserTargetResponse,
  StoredBrowserTask,
} from './types';

const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const TERMINAL_CHALLENGE_STATES = new Set(['failed', 'cancelled']);
const INSPECTABLE_CHALLENGE_STATES = new Set(['browser_open', 'challenge_required']);
const REBINDABLE_TASK_STATES = new Set(['waiting_for_browser_worker', 'interrupted', 'waiting_verification']);
const BROWSER_TARGET_LOSS = /browser (worker|resource|session).*(offline|disconnect|not found|closed|lost|restart)/i;

interface CrawlerClientLike {
  getTask(taskId: string): Promise<CrawlerTaskDetail>;
  getVerification(challengeDiscoveryId: string): Promise<ChallengeDiscoveryJob>;
  completeVerification(challengeDiscoveryId: string): Promise<ChallengeDiscoveryJob>;
  resumeTask(taskId: string): Promise<void>;
  rebindBrowserTarget(
    taskId: string,
    expectedBrowserTarget: BrowserTarget,
    browserTarget: BrowserTarget,
  ): Promise<RebindBrowserTargetResponse>;
}

export interface BrowserWorkspaceSnapshot {
  client: BrowserClientSnapshot;
  task?: StoredBrowserTask;
  recoveryIssue?: BrowserTaskRecoveryIssue;
  canRecover: boolean;
}

interface CoordinatorDependencies {
  readTask(): Promise<StoredBrowserTask | undefined>;
  writeTask(task: StoredBrowserTask): Promise<StoredBrowserTask>;
  createClient(settings: ComicCrawlerSettings): CrawlerClientLike;
}

const defaultDependencies: CoordinatorDependencies = {
  readTask: () => readBrowserTask(),
  writeTask: (task) => writeBrowserTask(task),
  createClient: (settings) => new ComicCrawlerClient(settings),
};

function taskNeedsBrowser(task: StoredBrowserTask): boolean {
  return !TERMINAL_TASK_STATES.has(task.status)
    && Boolean(task.taskId || task.challengeDiscoveryId);
}

function hasBrowserTargetLoss(task: StoredBrowserTask): boolean {
  if (task.status !== 'failed') return false;
  const error = task.detail?.task.error ?? task.detail?.result?.error ?? '';
  return BROWSER_TARGET_LOSS.test(error);
}

function canRebindTask(task: StoredBrowserTask): boolean {
  return Boolean(
    task.taskId
    && task.detail?.task.browserTarget
    && (REBINDABLE_TASK_STATES.has(task.status) || hasBrowserTargetLoss(task)),
  );
}

function equivalentTargetUrl(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
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

function rebindError(error: unknown): Error | unknown {
  if (!(error instanceof ComicCrawlerError)) return error;
  const knownCodes = new Set(['NOT_FOUND', 'FORBIDDEN', 'INVALID_STATE', 'STALE_TARGET', 'INVALID_TARGET']);
  if (!error.code || !knownCodes.has(error.code)) return error;
  return new Error(`comicCrawler_browser_rebind_${error.code.toLowerCase()}`);
}

function recoveryIssue(
  browserClient: BrowserClientSnapshot,
  task: StoredBrowserTask,
): BrowserTaskRecoveryIssue | undefined {
  if (!taskNeedsBrowser(task) && !canRebindTask(task)) return undefined;
  if (browserClient.status !== 'connected' || !browserClient.workerId) return 'browser_disconnected';
  if (!browserClient.resource || browserClient.resource.url !== task.targetUrl) return 'resource_unavailable';
  const expectedWorkerId = task.detail?.task.browserTarget?.workerId;
  if (expectedWorkerId && expectedWorkerId !== browserClient.workerId) return 'worker_changed';
  if (hasBrowserTargetLoss(task)) return 'resource_unavailable';
  return undefined;
}

export class ComicCrawlerBrowserTaskCoordinator {
  private currentCycle?: Promise<BrowserWorkspaceSnapshot>;

  constructor(
    private readonly manager: ComicCrawlerBrowserClientManager,
    private readonly readSettings: () => Promise<{ comicCrawler: ComicCrawlerSettings }>,
    private readonly dependencies: CoordinatorDependencies = defaultDependencies,
  ) {}

  run(): Promise<BrowserWorkspaceSnapshot> {
    if (!this.currentCycle) {
      this.currentCycle = this.runOnce().finally(() => {
        this.currentCycle = undefined;
      });
    }
    return this.currentCycle;
  }

  async continueAfterVerification(): Promise<StoredBrowserTask> {
    const task = await this.dependencies.readTask();
    if (!task?.challengeDiscoveryId) throw new Error('comicCrawler_browser_no_verification');
    const settings = (await this.readSettings()).comicCrawler;
    const client = this.dependencies.createClient(settings);
    const challenge = await client.completeVerification(task.challengeDiscoveryId);
    let next = await this.dependencies.writeTask({
      ...task,
      verificationStatus: challenge.status,
      updatedAt: new Date().toISOString(),
    });
    if (challenge.status !== 'ready') throw new Error('comicCrawler_browser_verification_not_ready');
    if (!task.taskId) {
      return this.dependencies.writeTask({
        ...next,
        status: 'verification_completed',
        updatedAt: new Date().toISOString(),
      });
    }
    await client.resumeTask(task.taskId);
    next = await this.dependencies.writeTask({
      ...next,
      status: 'pending',
      resumeRequestedForChallengeId: task.challengeDiscoveryId,
      updatedAt: new Date().toISOString(),
    });
    next = await this.refreshTask(client, next);
    return next;
  }

  async recoverWithCurrentTab(tab: { id?: number; url?: string; title?: string }): Promise<BrowserWorkspaceSnapshot> {
    const settings = (await this.readSettings()).comicCrawler;
    if (!settings.enabled) throw new Error('comicCrawler_disabled');
    await this.manager.connect(settings);

    const task = await this.dependencies.readTask();
    if (!task?.taskId) throw new Error('comicCrawler_browser_no_task');
    const client = this.dependencies.createClient(settings);
    const currentDetail = await client.getTask(task.taskId);
    const currentTask = await this.dependencies.writeTask(storedTaskFromDetail(task, currentDetail));
    const expectedBrowserTarget = currentDetail.task.browserTarget;
    if (!expectedBrowserTarget || !canRebindTask(currentTask)) {
      throw new Error('comicCrawler_browser_task_not_recoverable');
    }
    let matchesRecoveryUrl = equivalentTargetUrl(tab.url, currentTask.targetUrl);
    if (!matchesRecoveryUrl && currentTask.status === 'waiting_verification' && currentTask.challengeDiscoveryId) {
      const challenge = await client.getVerification(currentTask.challengeDiscoveryId);
      matchesRecoveryUrl = equivalentTargetUrl(tab.url, challenge.normalizedUrl);
    }
    if (!matchesRecoveryUrl) throw new Error('comicCrawler_browser_recovery_wrong_tab');

    const registered = await this.manager.registerTab(tab);
    if (registered.status !== 'connected' || !registered.workerId || !registered.resource) {
      throw new Error('comicCrawler_browser_not_connected');
    }
    const browserTarget: BrowserTarget = {
      mode: 'existing-tab',
      workerId: registered.workerId,
      resourceId: registered.resource.resourceId,
    };
    let rebound: RebindBrowserTargetResponse;
    try {
      rebound = await client.rebindBrowserTarget(
        task.taskId,
        expectedBrowserTarget,
        browserTarget,
      );
    } catch (error) {
      throw rebindError(error);
    }
    const refreshedDetail = await client.getTask(task.taskId);
    let refreshedTask = storedTaskFromDetail(currentTask, refreshedDetail);
    if (rebound.challenge) {
      refreshedTask = {
        ...refreshedTask,
        challengeDiscoveryId: rebound.challenge.id,
        verificationStatus: rebound.challenge.status,
      };
    }
    refreshedTask = await this.dependencies.writeTask(refreshedTask);
    const browserClient = await this.manager.snapshot();
    const issue = recoveryIssue(browserClient, refreshedTask);
    return {
      client: browserClient,
      task: refreshedTask,
      recoveryIssue: issue,
      canRecover: Boolean(issue && canRebindTask(refreshedTask)),
    };
  }

  private async runOnce(): Promise<BrowserWorkspaceSnapshot> {
    const settings = (await this.readSettings()).comicCrawler;
    if (settings.enabled) await this.manager.autoReconnect(settings);
    const browserClient = await this.manager.snapshot();
    let task = await this.dependencies.readTask();
    if (!settings.enabled || !task) return { client: browserClient, task, canRecover: false };

    const client = this.dependencies.createClient(settings);
    if (task.taskId && !TERMINAL_TASK_STATES.has(task.status)) {
      task = await this.refreshTask(client, task);
    }

    const issue = recoveryIssue(browserClient, task);
    if (issue || !task.challengeDiscoveryId || TERMINAL_TASK_STATES.has(task.status)) {
      return { client: browserClient, task, recoveryIssue: issue, canRecover: Boolean(issue && canRebindTask(task)) };
    }

    const challengeDiscoveryId = task.challengeDiscoveryId;
    let challenge = await client.getVerification(challengeDiscoveryId);
    task = await this.dependencies.writeTask({
      ...task,
      verificationStatus: challenge.status,
      updatedAt: new Date().toISOString(),
    });
    if (INSPECTABLE_CHALLENGE_STATES.has(challenge.status)) {
      challenge = await client.completeVerification(challengeDiscoveryId);
      task = await this.dependencies.writeTask({
        ...task,
        verificationStatus: challenge.status,
        updatedAt: new Date().toISOString(),
      });
    }
    if (TERMINAL_CHALLENGE_STATES.has(challenge.status)) {
      task = await this.dependencies.writeTask({
        ...task,
        status: challenge.status,
        updatedAt: new Date().toISOString(),
      });
      return { client: browserClient, task, canRecover: false };
    }
    if (challenge.status !== 'ready') return { client: browserClient, task, canRecover: false };

    if (!task.taskId) {
      task = await this.dependencies.writeTask({
        ...task,
        status: 'verification_completed',
        updatedAt: new Date().toISOString(),
      });
      return { client: browserClient, task, canRecover: false };
    }

    if (task.resumeRequestedForChallengeId === challengeDiscoveryId) {
      return { client: browserClient, task, canRecover: false };
    }

    await client.resumeTask(task.taskId);
    task = await this.dependencies.writeTask({
      ...task,
      status: 'pending',
      resumeRequestedForChallengeId: challengeDiscoveryId,
      updatedAt: new Date().toISOString(),
    });
    task = await this.refreshTask(client, task);
    return { client: browserClient, task, canRecover: false };
  }

  private async refreshTask(client: CrawlerClientLike, task: StoredBrowserTask): Promise<StoredBrowserTask> {
    if (!task.taskId) return task;
    const detail = await client.getTask(task.taskId);
    return this.dependencies.writeTask(storedTaskFromDetail(task, detail));
  }
}

