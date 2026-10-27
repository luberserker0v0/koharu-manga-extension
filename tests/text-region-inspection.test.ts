import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextRegionInspectionPanel } from '../components/TextRegionInspectionPanel';
import type { BackendClient } from '../lib/api/backend-client';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TextRegionInspectionPanel', () => {
  it('renders exact OCR text and uses the matching page revision image', async () => {
    vi.stubGlobal('browser', { i18n: { getMessage: (key: string) => key } });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:translated') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const client = {
      getTextRegions: vi.fn().mockResolvedValue({
        jobId: 'job-2',
        rootJobId: 'job-root',
        snapshotFingerprint: 'snapshot-1',
        pages: [{
          sourceImageId: 'source-1',
          sourceOrderIndex: 0,
          sourceFileName: '001.png',
          pageRevisionId: 'revision-2',
          regionSetRevisionId: 'region-set-2',
          coordinateSpace: {
            kind: 'source_image_pixels', origin: 'top_left', width: 1000, height: 1500,
            rotationUnit: 'degrees_clockwise',
          },
          regions: [{
            id: 'region-1', readingOrder: 0,
            geometry: { x: 100, y: 150, width: 300, height: 90, rotation: 0 },
            sourceText: 'inter\ngalactic', translatedText: '星際', ocrConfidence: 0.81,
          }],
        }],
      }),
      getPageRevisions: vi.fn().mockResolvedValue({
        rootJobId: 'job-root', sourcePreflightId: 'preflight-1', pageCount: 1,
        pages: [{
          sourceImageId: 'source-1', sourceOrderIndex: 0, activeRevisionId: 'revision-2',
          revisions: [{
            revisionId: 'revision-2', revisionNumber: 2, active: true, jobId: 'job-2',
            createdAt: '2026-10-27T00:00:00.000Z',
            image: { id: 'image-2', index: 0, fileName: '001.png', mediaType: 'image/png', size: 10, encodedUrl: '/encoded', contentUrl: '/content' },
          }],
        }],
      }),
      downloadPageRevisionImage: vi.fn().mockResolvedValue(new Blob(['page'], { type: 'image/png' })),
    } as unknown as BackendClient;

    const { container } = render(createElement(TextRegionInspectionPanel, {
      client,
      jobId: 'job-2',
      onJobCreated: vi.fn(),
    }));

    await waitFor(() => expect(client.downloadPageRevisionImage).toHaveBeenCalledWith(
      expect.objectContaining({ revisionId: 'revision-2' }),
      expect.any(AbortSignal),
    ));
    await waitFor(() => expect(container.querySelector('.text-region-overlay-text')?.textContent).toBe('inter\ngalactic'));
    expect(container.querySelector('.text-region-overlay-text')?.textContent).toBe('inter\ngalactic');
    expect(container.querySelector('.text-region-overlay')?.classList.contains('show-text')).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'textRegionShowText' }));
    expect(container.querySelector('.text-region-overlay')?.classList.contains('show-text')).toBe(true);
    expect(screen.getByText('星際')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'textRegionZoomIn' }));
    expect((container.querySelector('.text-region-stage') as HTMLElement).style.width).toBe('125%');
    fireEvent.click(screen.getByRole('button', { name: 'textRegionZoomReset' }));
    expect((container.querySelector('.text-region-stage') as HTMLElement).style.width).toBe('100%');
  });

  it('queues edited OCR text and hands the new job to the shared monitor workflow', async () => {
    vi.stubGlobal('browser', { i18n: { getMessage: (key: string) => key } });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:translated') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const snapshot = {
      jobId: 'job-2', rootJobId: 'job-root', snapshotFingerprint: 'snapshot-1',
      pages: [{
        sourceImageId: 'source-1', sourceOrderIndex: 0, sourceFileName: '001.png',
        pageRevisionId: 'revision-2', regionSetRevisionId: 'region-set-2',
        coordinateSpace: {
          kind: 'source_image_pixels', origin: 'top_left', width: 1000, height: 1500,
          rotationUnit: 'degrees_clockwise',
        },
        regions: [{
          id: 'region-1', readingOrder: 0,
          geometry: { x: 100, y: 150, width: 300, height: 90, rotation: 0 },
          sourceText: 'inter\ngalactic', translatedText: '星際',
        }],
      }],
    };
    const queued = {
      id: 'job-correction', type: 'translation', status: 'queued', stage: 'queued', result: null, error: null,
      createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z',
    };
    const client = {
      getTextRegions: vi.fn().mockResolvedValue(snapshot),
      getPageRevisions: vi.fn().mockResolvedValue({
        rootJobId: 'job-root', sourcePreflightId: 'preflight-1', pageCount: 1,
        pages: [{
          sourceImageId: 'source-1', sourceOrderIndex: 0, activeRevisionId: 'revision-2',
          revisions: [{
            revisionId: 'revision-2', revisionNumber: 2, active: true, jobId: 'job-2',
            createdAt: '2026-10-27T00:00:00.000Z',
            image: { id: 'image-2', index: 0, fileName: '001.png', mediaType: 'image/png', size: 10, encodedUrl: '/encoded', contentUrl: '/content' },
          }],
        }],
      }),
      downloadPageRevisionImage: vi.fn().mockResolvedValue(new Blob(['page'], { type: 'image/png' })),
      createTextRegionCorrection: vi.fn().mockResolvedValue(queued),
    } as unknown as BackendClient;
    const onJobCreated = vi.fn();

    render(createElement(TextRegionInspectionPanel, { client, jobId: 'job-2', onJobCreated }));

    const editor = await screen.findByLabelText('textRegionSourceText');
    fireEvent.change(editor, { target: { value: 'intergalactic' } });
    fireEvent.click(screen.getByRole('button', { name: 'textRegionSubmitCorrections' }));

    await waitFor(() => expect(client.createTextRegionCorrection).toHaveBeenCalledWith('job-2', {
      pages: [{
        sourceImageId: 'source-1',
        baseRegionSetRevisionId: 'region-set-2',
        regions: [{ regionId: 'region-1', sourceText: 'intergalactic' }],
      }],
    }));
    expect(onJobCreated).toHaveBeenCalledWith(queued);
  });

  it('shows the original source image by default and can switch to the translated revision', async () => {
    vi.stubGlobal('browser', { i18n: { getMessage: (key: string) => key } });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const snapshot = {
      jobId: 'job-1', rootJobId: 'job-1', snapshotFingerprint: 'snapshot-1',
      pages: [{
        sourceImageId: 'source-1', sourceOrderIndex: 0, sourceFileName: '001.png',
        pageRevisionId: 'revision-1', regionSetRevisionId: 'set-1',
        coordinateSpace: {
          kind: 'source_image_pixels', origin: 'top_left', width: 1000, height: 1500,
          rotationUnit: 'degrees_clockwise',
        },
        regions: [],
      }],
    };
    const client = {
      getTextRegions: vi.fn().mockResolvedValue(snapshot),
      getPageRevisions: vi.fn().mockResolvedValue({
        rootJobId: 'job-1', sourcePreflightId: 'preflight-1', pageCount: 1,
        pages: [{
          sourceImageId: 'source-1', sourceOrderIndex: 0, activeRevisionId: 'revision-1',
          revisions: [{
            revisionId: 'revision-1', revisionNumber: 1, active: true, jobId: 'job-1',
            createdAt: '2026-10-27T00:00:00.000Z',
            image: { id: 'image-1', index: 0, fileName: '001.png', mediaType: 'image/png', size: 10, encodedUrl: '/encoded', contentUrl: '/content' },
          }],
        }],
      }),
      downloadPageRevisionImage: vi.fn().mockResolvedValue(new Blob(['translated'], { type: 'image/png' })),
    } as unknown as BackendClient;
    const loadOriginalImage = vi.fn().mockResolvedValue(new Blob(['original'], { type: 'image/png' }));

    render(createElement(TextRegionInspectionPanel, {
      client, jobId: 'job-1', onJobCreated: vi.fn(), loadOriginalImage,
    }));

    await waitFor(() => expect(loadOriginalImage).toHaveBeenCalledWith('source-1', expect.any(AbortSignal)));
    expect(client.getPageRevisions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'textRegionTranslatedImage' }));
    await waitFor(() => expect(client.downloadPageRevisionImage).toHaveBeenCalled());
  });
});
