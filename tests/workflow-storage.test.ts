import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearWorkflow,
  clearWorkflowHistory,
  discardMissingWorkflow,
  findWorkflowForChapter,
  loadWorkflow,
  loadWorkflowHistory,
  pageWorkflowKey,
  removeWorkflowHistoryItem,
  saveWorkflow,
  type StoredWorkflow,
} from '../lib/storage/workflow';

const values: Record<string, unknown> = {};

beforeEach(() => {
  for (const key of Object.keys(values)) delete values[key];
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[]) => Array.isArray(key)
          ? Object.fromEntries(key.map((item) => [item, values[item]]))
          : ({ [key]: values[key] })),
        set: vi.fn(async (entries: Record<string, unknown>) => { Object.assign(values, entries); }),
        remove: vi.fn(async (key: string) => { delete values[key]; }),
      },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

function workflow(jobId: string): StoredWorkflow {
  return {
    uploadId: 'upload-1',
    preflightId: 'preflight-1',
    jobId,
    fileNames: ['001.jpg', '002.jpg'],
    bindings: {
      mangaId: 'manga', translatorId: 'translator', chapterId: 'chapter',
      targetLanguage: 'zh-TW', sourceLanguage: 'ja', exportFormat: 'rendered',
    },
    updatedAt: new Date().toISOString(),
  };
}

describe('workflow history', () => {
  it('routes workflow storage through the background when content-script access is blocked', async () => {
    const saved = workflow('job-bridge');
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'WORKFLOW_LOAD') return saved;
      if (message.type === 'WORKFLOW_HISTORY_LOAD') return [saved];
      return undefined;
    });
    const denied = vi.fn().mockRejectedValue(new Error('Access to storage is not allowed from this context.'));
    vi.stubGlobal('browser', {
      storage: { local: { get: denied, set: denied, remove: denied } },
      runtime: { sendMessage },
    });

    await expect(loadWorkflow('https://reader.example/chapter/1')).resolves.toMatchObject({ jobId: 'job-bridge' });
    await expect(loadWorkflowHistory()).resolves.toHaveLength(1);
    await expect(saveWorkflow(saved)).resolves.toBeUndefined();
    await expect(clearWorkflow()).resolves.toBeUndefined();
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual([
      'WORKFLOW_LOAD',
      'WORKFLOW_HISTORY_LOAD',
      'WORKFLOW_SAVE',
      'WORKFLOW_CLEAR',
    ]);
  });

  it('routes missing-job cleanup through the background when content-script storage is blocked', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const denied = vi.fn().mockRejectedValue(new Error('Access to storage is not allowed from this context.'));
    vi.stubGlobal('browser', {
      storage: { local: { get: denied, set: denied, remove: denied } },
      runtime: { sendMessage },
    });

    await expect(discardMissingWorkflow('job-missing', 'https://reader.example/chapter/1')).resolves.toBeUndefined();
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual([
      'WORKFLOW_CLEAR',
      'WORKFLOW_HISTORY_REMOVE',
    ]);
  });

  it('keeps separate explicit retry attempts for the same chapter', async () => {
    await saveWorkflow(workflow('job-1'));
    await saveWorkflow(workflow('job-2'));
    expect((await loadWorkflowHistory()).map((item) => item.jobId)).toEqual(['job-2', 'job-1']);
  });

  it('updates an existing job record without creating a duplicate', async () => {
    await saveWorkflow(workflow('job-1'));
    await saveWorkflow({ ...workflow('job-1'), fileNames: ['updated.png'] });
    const history = await loadWorkflowHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.fileNames).toEqual(['updated.png']);
  });

  it('stores and restores workflows separately for each chapter URL', async () => {
    const first = { ...workflow('job-1'), sourcePageUrl: 'https://reader.example/chapter/1#page' };
    const second = { ...workflow('job-2'), sourcePageUrl: 'https://reader.example/chapter/2' };
    await saveWorkflow(first);
    await saveWorkflow(second);

    await expect(loadWorkflow('https://reader.example/chapter/1')).resolves.toMatchObject({ jobId: 'job-1' });
    await expect(loadWorkflow('https://reader.example/chapter/2')).resolves.toMatchObject({ jobId: 'job-2' });
  });

  it('keeps only the latest history entry for the same page URL', async () => {
    const sourcePageUrl = 'https://reader.example/chapter/1';
    await saveWorkflow({ ...workflow('job-1'), sourcePageUrl });
    await saveWorkflow({ ...workflow('job-2'), sourcePageUrl });

    const history = await loadWorkflowHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.jobId).toBe('job-2');
  });

  it('clears only the workflow belonging to one page', async () => {
    await saveWorkflow({ ...workflow('job-1'), sourcePageUrl: 'https://reader.example/chapter/1' });
    await saveWorkflow({ ...workflow('job-2'), sourcePageUrl: 'https://reader.example/chapter/2' });
    await clearWorkflow('https://reader.example/chapter/1');
    await expect(loadWorkflow('https://reader.example/chapter/1')).resolves.toBeNull();
    await expect(loadWorkflow('https://reader.example/chapter/2')).resolves.toMatchObject({ jobId: 'job-2' });
  });

  it('normalizes URL fragments out of page workflow keys', () => {
    expect(pageWorkflowKey('https://reader.example/chapter/1#viewer')).toBe('https://reader.example/chapter/1');
  });

  it('matches a saved job by ComicCrawler canonical chapter URL', () => {
    const saved = {
      ...workflow('job-canonical'),
      sourcePageUrl: 'https://reader.example/read?chapter=1',
      comicCrawler: {
        adapterId: 'reader',
        chapterUrl: 'https://reader.example/manga/title/chapter-1',
      },
    };
    expect(findWorkflowForChapter(
      [saved],
      'https://reader.example/alternate-reader/1',
      'https://reader.example/manga/title/chapter-1#page-2',
    )?.jobId).toBe('job-canonical');
  });

  it('matches a saved job by stable ComicCrawler chapter ID when the URL changes', () => {
    const saved = {
      ...workflow('job-stable-id'),
      sourcePageUrl: 'https://reader.example/old-reader-url',
      comicCrawler: {
        adapterId: 'reader',
        chapterUrl: 'https://reader.example/old-canonical-url',
        chapterId: 'chapter-stable',
      },
    };
    expect(findWorkflowForChapter(
      [saved],
      'https://reader.example/new-reader-url',
      'https://reader.example/new-canonical-url',
      'chapter-stable',
    )?.jobId).toBe('job-stable-id');
  });

  it('removes one local history item without deleting the others', async () => {
    await saveWorkflow(workflow('job-1'));
    await saveWorkflow(workflow('job-2'));
    await removeWorkflowHistoryItem('job-1');
    expect((await loadWorkflowHistory()).map((item) => item.jobId)).toEqual(['job-2']);
  });

  it('discards a missing job from both its page slot and local history', async () => {
    const sourcePageUrl = 'https://reader.example/chapter/missing';
    await saveWorkflow({ ...workflow('job-missing'), sourcePageUrl });
    await saveWorkflow(workflow('job-kept'));

    await discardMissingWorkflow('job-missing', sourcePageUrl);

    await expect(loadWorkflow(sourcePageUrl)).resolves.toBeNull();
    expect((await loadWorkflowHistory()).map((item) => item.jobId)).toEqual(['job-kept']);
  });

  it('clears all local job history', async () => {
    await saveWorkflow(workflow('job-1'));
    await clearWorkflowHistory();
    await expect(loadWorkflowHistory()).resolves.toEqual([]);
  });
});
