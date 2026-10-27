import type { CreateCrawlerTaskResponse, CrawlerTaskDetail, StoredBrowserTask } from './types';
import type { ExtensionStorageArea } from './browser-state-store';

export const BROWSER_TASK_KEY = 'comiccrawler.currentBrowserTask';

export async function readBrowserTask(
  storage: ExtensionStorageArea = browser.storage.local,
): Promise<StoredBrowserTask | undefined> {
  const stored = await storage.get(BROWSER_TASK_KEY);
  return stored[BROWSER_TASK_KEY] as StoredBrowserTask | undefined;
}

export async function writeBrowserTask(
  task: StoredBrowserTask,
  storage: ExtensionStorageArea = browser.storage.local,
): Promise<StoredBrowserTask> {
  await storage.set({ [BROWSER_TASK_KEY]: task });
  return task;
}

export async function clearBrowserTask(
  storage: ExtensionStorageArea = browser.storage.local,
): Promise<void> {
  await storage.remove(BROWSER_TASK_KEY);
}

export function storedTaskFromCreated(targetUrl: string, result: CreateCrawlerTaskResponse): StoredBrowserTask {
  const common = { targetUrl, updatedAt: new Date().toISOString() };
  if (result.kind === 'taskCreated') {
    return { ...common, taskId: result.taskId, status: 'pending' };
  }
  if (result.kind === 'discoveryQueued') {
    return { ...common, discoveryId: result.discoveryId, status: result.status || 'discovery_queued' };
  }
  return {
    ...common,
    challengeDiscoveryId: result.challengeDiscoveryId,
    status: result.status || 'waiting_verification',
  };
}

export function storedTaskFromDetail(previous: StoredBrowserTask, detail: CrawlerTaskDetail): StoredBrowserTask {
  return {
    ...previous,
    taskId: detail.task.id,
    status: detail.task.status,
    challengeDiscoveryId: detail.result?.challengeDiscoveryId ?? previous.challengeDiscoveryId,
    verificationStatus: detail.result?.challengeStatus ?? previous.verificationStatus,
    resumeRequestedForChallengeId: detail.task.status === 'waiting_verification'
      ? previous.resumeRequestedForChallengeId
      : undefined,
    updatedAt: new Date().toISOString(),
    detail,
  };
}
