export interface StoredBindings {
  mangaId: string;
  translatorId: string;
  chapterId: string;
  targetLanguage: string;
  sourceLanguage: string;
  exportFormat: string;
  translationProviderId?: string;
  translationModelId?: string;
}

export interface StoredWorkflow {
  uploadId: string;
  sourcePageUrl?: string;
  preflightId?: string;
  jobId?: string;
  fileNames: string[];
  bindings?: StoredBindings;
  updatedAt: string;
  uploadDeletedAt?: string;
  comicCrawler?: {
    adapterId: string;
    chapterUrl: string;
  };
}

const WORKFLOW_KEY = 'currentWorkflow';
const PAGE_WORKFLOWS_KEY = 'pageWorkflows';
export const WORKFLOW_HISTORY_KEY = 'workflowHistory';

export function pageWorkflowKey(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = '';
  return url.href;
}

function safePageWorkflowKey(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try { return pageWorkflowKey(rawUrl); } catch { return null; }
}

export function workflowMatchesChapter(workflow: StoredWorkflow, pageUrl: string, chapterUrl: string): boolean {
  const targets = new Set([safePageWorkflowKey(pageUrl), safePageWorkflowKey(chapterUrl)].filter((value): value is string => Boolean(value)));
  return [workflow.sourcePageUrl, workflow.comicCrawler?.chapterUrl]
    .some((url) => {
      const key = safePageWorkflowKey(url);
      return key ? targets.has(key) : false;
    });
}

export function findWorkflowForChapter(
  workflows: StoredWorkflow[],
  pageUrl: string,
  chapterUrl: string,
): StoredWorkflow | null {
  return workflows.find((workflow) => workflow.jobId && workflowMatchesChapter(workflow, pageUrl, chapterUrl)) ?? null;
}

export async function readWorkflowFromStorage(sourcePageUrl?: string): Promise<StoredWorkflow | null> {
  if (sourcePageUrl) {
    const stored = await browser.storage.local.get(PAGE_WORKFLOWS_KEY);
    const workflows = stored[PAGE_WORKFLOWS_KEY] as Record<string, StoredWorkflow> | undefined;
    return workflows?.[pageWorkflowKey(sourcePageUrl)] ?? null;
  }
  const stored = await browser.storage.local.get(WORKFLOW_KEY);
  return (stored[WORKFLOW_KEY] as StoredWorkflow | undefined) ?? null;
}

export async function writeWorkflowToStorage(workflow: StoredWorkflow): Promise<void> {
  await browser.storage.local.set({ [WORKFLOW_KEY]: workflow });
  if (workflow.sourcePageUrl) {
    const stored = await browser.storage.local.get(PAGE_WORKFLOWS_KEY);
    const workflows = (stored[PAGE_WORKFLOWS_KEY] as Record<string, StoredWorkflow> | undefined) ?? {};
    await browser.storage.local.set({
      [PAGE_WORKFLOWS_KEY]: { ...workflows, [pageWorkflowKey(workflow.sourcePageUrl)]: workflow },
    });
  }
  if (workflow.jobId && workflow.bindings) {
    const history = await readWorkflowHistoryFromStorage();
    const normalizedHistory = workflow.uploadDeletedAt
      ? history.map((item) => item.uploadId === workflow.uploadId ? { ...item, uploadDeletedAt: workflow.uploadDeletedAt } : item)
      : history;
    const next = [workflow, ...normalizedHistory.filter((item) => workflow.sourcePageUrl
      ? item.sourcePageUrl !== workflow.sourcePageUrl
      : item.jobId !== workflow.jobId)].slice(0, 50);
    await browser.storage.local.set({ [WORKFLOW_HISTORY_KEY]: next });
  }
}

export async function deleteWorkflowFromStorage(sourcePageUrl?: string): Promise<void> {
  if (!sourcePageUrl) {
    await browser.storage.local.remove(WORKFLOW_KEY);
    return;
  }
  const key = pageWorkflowKey(sourcePageUrl);
  const stored = await browser.storage.local.get([WORKFLOW_KEY, PAGE_WORKFLOWS_KEY]);
  const workflows = (stored[PAGE_WORKFLOWS_KEY] as Record<string, StoredWorkflow> | undefined) ?? {};
  const { [key]: removed, ...remaining } = workflows;
  void removed;
  await browser.storage.local.set({ [PAGE_WORKFLOWS_KEY]: remaining });
  const current = stored[WORKFLOW_KEY] as StoredWorkflow | undefined;
  if (current?.sourcePageUrl && pageWorkflowKey(current.sourcePageUrl) === key) {
    await browser.storage.local.remove(WORKFLOW_KEY);
  }
}

export async function readWorkflowHistoryFromStorage(): Promise<StoredWorkflow[]> {
  const stored = await browser.storage.local.get(WORKFLOW_HISTORY_KEY);
  const value = stored[WORKFLOW_HISTORY_KEY];
  return Array.isArray(value) ? value as StoredWorkflow[] : [];
}

export async function removeWorkflowHistoryItem(jobId: string): Promise<void> {
  const history = await readWorkflowHistoryFromStorage();
  await browser.storage.local.set({
    [WORKFLOW_HISTORY_KEY]: history.filter((item) => item.jobId !== jobId),
  });
}

export async function clearWorkflowHistory(): Promise<void> {
  await browser.storage.local.remove(WORKFLOW_HISTORY_KEY);
}

export async function loadWorkflow(sourcePageUrl?: string): Promise<StoredWorkflow | null> {
  try {
    return await readWorkflowFromStorage(sourcePageUrl);
  } catch {
    return await browser.runtime.sendMessage({ type: 'WORKFLOW_LOAD', sourcePageUrl }) as StoredWorkflow | null;
  }
}

export async function saveWorkflow(workflow: StoredWorkflow): Promise<void> {
  try {
    await writeWorkflowToStorage(workflow);
  } catch {
    await browser.runtime.sendMessage({ type: 'WORKFLOW_SAVE', workflow });
  }
}

export async function clearWorkflow(sourcePageUrl?: string): Promise<void> {
  try {
    await deleteWorkflowFromStorage(sourcePageUrl);
  } catch {
    await browser.runtime.sendMessage({ type: 'WORKFLOW_CLEAR', sourcePageUrl });
  }
}

export async function loadWorkflowHistory(): Promise<StoredWorkflow[]> {
  try {
    return await readWorkflowHistoryFromStorage();
  } catch {
    return await browser.runtime.sendMessage({ type: 'WORKFLOW_HISTORY_LOAD' }) as StoredWorkflow[];
  }
}
