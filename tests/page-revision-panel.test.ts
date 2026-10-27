import { createElement } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageRevisionPanel } from '../components/PageRevisionPanel';
import type { BackendClient } from '../lib/api/backend-client';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PageRevisionPanel automatic promotion', () => {
  it('reapplies the active manifest after a successful revision job without activating it again', async () => {
    vi.stubGlobal('browser', { i18n: { getMessage: (key: string) => key } });
    const manifest = {
      rootJobId: 'job-root', sourcePreflightId: 'preflight-1', pageCount: 1,
      pages: [{
        sourceImageId: 'source-1', sourceOrderIndex: 0, sourceFileName: '001.png', activeRevisionId: 'revision-2',
        revisions: [{
          revisionId: 'revision-2', revisionNumber: 2, active: true, jobId: 'job-revision',
          createdAt: '2026-10-27T00:00:00.000Z',
          image: { id: 'image-2', index: 0, fileName: '001.png', mediaType: 'image/png', size: 10, encodedUrl: '/encoded', contentUrl: '/content' },
        }],
      }],
    };
    const client = {
      getPageRevisions: vi.fn().mockResolvedValue(manifest),
      activatePageRevisions: vi.fn(),
    } as unknown as BackendClient;
    const onApplied = vi.fn().mockResolvedValue(undefined);

    render(createElement(PageRevisionPanel, {
      client,
      rootJobId: 'job-root',
      parentJobId: 'job-revision',
      currentJob: {
        id: 'job-revision', type: 'translation', status: 'succeeded', stage: 'succeeded', result: {}, error: null,
        createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:01:00.000Z',
        revision: { rootJobId: 'job-root', parentJobId: 'job-root', reason: 'selective_retranslation', sourceImageIds: ['source-1'] },
      },
      onJobCreated: vi.fn(),
      onApplied,
    }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(manifest));
    expect(client.activatePageRevisions).not.toHaveBeenCalled();
  });
});
