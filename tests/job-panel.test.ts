import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobPanel } from '../components/JobPanel';
import type { BackendClient } from '../lib/api/backend-client';
import { BackendApiError } from '../lib/api/errors';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('JobPanel inline replacement state', () => {
  it('shows restore instead of apply when the content page reports translated images', () => {
    vi.stubGlobal('browser', {
      i18n: { getMessage: (key: string) => key },
      downloads: { download: vi.fn() },
    });
    const restore = vi.fn();
    render(createElement(JobPanel, {
      client: {} as BackendClient,
      jobId: 'job-1',
      job: {
        id: 'job-1',
        type: 'translation',
        status: 'succeeded',
        stage: 'completed',
        result: {},
        error: null,
        createdAt: '2026-10-19T00:00:00.000Z',
        updatedAt: '2026-10-19T00:01:00.000Z',
      },
      events: [],
      artifacts: [{ id: 1, kind: 'export' }],
      transport: 'stopped',
      monitorError: null,
      autoApplyInline: false,
      pageApplied: true,
      onReset: vi.fn(),
      onApplyJob: vi.fn(async () => true),
      onRestoreInline: restore,
    }));

    fireEvent.click(screen.getByRole('tab', { name: /workspaceTabArtifacts/ }));
    expect(screen.queryByRole('button', { name: 'applyInline' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'restoreOriginal' }));
    expect(restore).toHaveBeenCalledOnce();
  });

  it('stops showing a reconnect spinner when the restored job no longer exists', () => {
    vi.stubGlobal('browser', {
      i18n: { getMessage: (key: string) => key },
      downloads: { download: vi.fn() },
    });
    const discard = vi.fn();
    render(createElement(JobPanel, {
      client: {} as BackendClient,
      jobId: 'missing-job',
      job: null,
      events: [],
      artifacts: [],
      transport: 'stopped',
      monitorError: new BackendApiError({
        message: 'Not found', status: 404, method: 'GET', path: '/jobs/missing-job', requestId: 'request-1',
      }),
      canRequeue: true,
      onReset: vi.fn(),
      onDiscardMissingJob: discard,
      onRequeue: vi.fn(),
    }));

    expect(screen.getByText('missingJobTitle')).toBeTruthy();
    expect(screen.queryByText('loadingJobTitle')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'discardMissingJob' }));
    expect(discard).toHaveBeenCalledOnce();
  });

  it('keeps auxiliary workspace panels mounted while switching tabs', () => {
    vi.stubGlobal('browser', {
      i18n: { getMessage: (key: string) => key },
      downloads: { download: vi.fn() },
    });
    const { container } = render(createElement(JobPanel, {
      client: {} as BackendClient,
      jobId: 'job-1',
      job: {
        id: 'job-1', type: 'translation', status: 'succeeded', stage: 'completed', result: {}, error: null,
        createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:01:00.000Z',
      },
      events: [], artifacts: [], transport: 'stopped', monitorError: null,
      onReset: vi.fn(),
      textRegionPanel: createElement('div', {}, 'ocr-panel-content'),
      pageRevisionPanel: createElement('div', {}, 'revision-panel-content'),
    }));

    expect(screen.getByText('ocr-panel-content')).toBeTruthy();
    expect(container.querySelector('#workspace-panel-ocr')?.hasAttribute('hidden')).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'workspaceTabOcr' }));
    expect(container.querySelector('#workspace-panel-ocr')?.hasAttribute('hidden')).toBe(false);
    expect(container.querySelector('#workspace-panel-job')?.hasAttribute('hidden')).toBe(true);
  });
});
