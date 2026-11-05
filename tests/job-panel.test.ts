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
  it('offers page application for an export when the content page can resolve the saved workflow', async () => {
    vi.stubGlobal('browser', {
      i18n: { getMessage: (key: string) => key },
      downloads: { download: vi.fn() },
    });
    const apply = vi.fn(async () => true);
    render(createElement(JobPanel, {
      client: {} as BackendClient,
      jobId: 'job-1',
      job: {
        id: 'job-1', type: 'translation', status: 'succeeded', stage: 'completed', result: {}, error: null,
        createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:01:00.000Z',
      },
      events: [], artifacts: [{ id: 1, kind: 'export' }], transport: 'stopped', monitorError: null,
      autoApplyInline: false, onReset: vi.fn(), onApplyJob: apply,
    }));

    fireEvent.click(screen.getByRole('tab', { name: /workspaceTabArtifacts/ }));
    fireEvent.click(screen.getByRole('button', { name: 'applyInline' }));
    expect(apply).toHaveBeenCalledWith('job-1');
  });

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

  it('renders whole-chapter quality actions in the live job panel and lets them open OCR details', () => {
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
      qualityImprovementPanel: ({ openOcr }) => createElement('button', { onClick: openOcr }, 'whole-chapter-action'),
    }));

    expect(screen.getByRole('button', { name: 'whole-chapter-action' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'whole-chapter-action' }));
    expect(container.querySelector('#workspace-panel-ocr')?.hasAttribute('hidden')).toBe(false);
  });

  it('exposes the persisted comic-page number checkbox in the live job panel', () => {
    vi.stubGlobal('browser', {
      i18n: { getMessage: (key: string) => key },
      downloads: { download: vi.fn() },
    });
    const change = vi.fn();
    render(createElement(JobPanel, {
      client: {} as BackendClient,
      jobId: 'job-1',
      job: {
        id: 'job-1', type: 'translation', status: 'succeeded', stage: 'completed', result: {}, error: null,
        createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:01:00.000Z',
      },
      events: [], artifacts: [], transport: 'stopped', monitorError: null,
      onReset: vi.fn(), showPageNumbers: false, onShowPageNumbersChange: change,
    }));

    fireEvent.click(screen.getByRole('checkbox', { name: 'showPageNumbersLabel' }));
    expect(change).toHaveBeenCalledWith(true);
  });

  it('keeps tabs responsive by rendering large event histories in bounded pages', () => {
    vi.stubGlobal('browser', {
      i18n: { getMessage: (key: string) => key },
      downloads: { download: vi.fn() },
    });
    const events = Array.from({ length: 685 }, (_, index) => ({
      id: index + 1,
      type: 'pipeline_progress',
      createdAt: `2026-10-19T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`,
      payload: { progress: index / 685 },
    }));
    const { container } = render(createElement(JobPanel, {
      client: {} as BackendClient,
      jobId: 'job-1',
      job: {
        id: 'job-1', type: 'translation', status: 'running', stage: 'monitor_pipeline', result: null, error: null,
        createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:01:00.000Z',
      },
      events, artifacts: [], transport: 'sse', monitorError: null, onReset: vi.fn(),
    }));

    fireEvent.click(screen.getByRole('tab', { name: /workspaceTabEvents/ }));
    expect(container.querySelectorAll('.event-card')).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: 'showMoreEvents' }));
    expect(container.querySelectorAll('.event-card')).toHaveLength(100);
    fireEvent.click(screen.getByRole('tab', { name: 'workspaceTabJob' }));
    expect(container.querySelector('#workspace-panel-job')?.hasAttribute('hidden')).toBe(false);
    expect(container.querySelector('#workspace-panel-events')?.hasAttribute('hidden')).toBe(true);
  });

  it('does not claim automatic OCR selection used explicit language hints', () => {
    vi.stubGlobal('browser', {
      i18n: { getMessage: (key: string) => key },
      downloads: { download: vi.fn() },
    });
    const baseJob = {
      id: 'job-ocr', type: 'translation', status: 'succeeded', stage: 'completed', error: null,
      createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:01:00.000Z',
    };
    const props = {
      client: {} as BackendClient, jobId: 'job-ocr', events: [], artifacts: [],
      transport: 'stopped' as const, monitorError: null, onReset: vi.fn(),
    };

    const first = render(createElement(JobPanel, {
      ...props,
      job: { ...baseJob, result: { ocrLanguageResolution: {
        engineId: 'paddle-ocr-vl-1.5', requestedSourceLanguages: [],
        selectionSource: 'adapter_default', hintsApplied: false, warnings: [],
      } } },
    }));
    expect(screen.getByText('ocrLanguageEngineDetail')).toBeTruthy();
    expect(screen.queryByText('ocrLanguageHintsNotApplied')).toBeNull();
    first.unmount();

    render(createElement(JobPanel, {
      ...props,
      job: { ...baseJob, result: { ocrLanguageResolution: {
        engineId: 'paddle-ocr-vl-1.5', requestedSourceLanguages: ['en'],
        selectionSource: 'language_policy', hintsApplied: false, warnings: [],
      } } },
    }));
    expect(screen.getByText('ocrLanguageHintsNotApplied')).toBeTruthy();
  });

  it('shows the chapter page number for a selective single-page job', () => {
    vi.stubGlobal('browser', {
      i18n: {
        getMessage: (key: string, substitutions?: string | string[]) => {
          const values = Array.isArray(substitutions) ? substitutions : substitutions ? [substitutions] : [];
          return values.length ? `${key}:${values.join(',')}` : key;
        },
      },
      downloads: { download: vi.fn() },
    });
    render(createElement(JobPanel, {
      client: {} as BackendClient,
      jobId: 'job-correction',
      job: {
        id: 'job-correction', type: 'translation', status: 'running', stage: 'translating', result: null, error: null,
        createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:01:00.000Z',
        revision: {
          rootJobId: 'job-root', parentJobId: 'job-parent', reason: 'text_region_correction', sourceImageIds: ['source-8'],
        },
      },
      sourceImagePages: [{ sourceImageId: 'source-8', sourceOrderIndex: 7, sourceFileName: '008.jpg' }],
      events: [], artifacts: [], transport: 'sse', monitorError: null, onReset: vi.fn(),
    }));

    expect(screen.getByText('retranslationPagesLabel')).toBeTruthy();
    expect(screen.getByText('pageRevisionPage')).toBeTruthy();
  });
});
