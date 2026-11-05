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

  it('uses page-local numbering and commits pointerup geometry on mobile-style drags', async () => {
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
        regions: [
          { id: 'region-1', readingOrder: 4, geometry: { x: 100, y: 150, width: 300, height: 90, rotation: 0 }, sourceText: 'first', translatedText: '一' },
          { id: 'region-2', readingOrder: 5, geometry: { x: 500, y: 600, width: 200, height: 80, rotation: 0 }, sourceText: 'second', translatedText: '二' },
        ],
      }],
    };
    const client = {
      getTextRegions: vi.fn().mockResolvedValue(snapshot),
      getPageRevisions: vi.fn().mockResolvedValue({
        rootJobId: 'job-root', sourcePreflightId: 'preflight-1', pageCount: 1,
        pages: [{ sourceImageId: 'source-1', sourceOrderIndex: 0, activeRevisionId: 'revision-2', revisions: [{
          revisionId: 'revision-2', revisionNumber: 2, active: true, jobId: 'job-2', createdAt: '2026-10-27T00:00:00.000Z',
          image: { id: 'image-2', index: 0, fileName: '001.png', mediaType: 'image/png', size: 10, encodedUrl: '/encoded', contentUrl: '/content' },
        }] }],
      }),
      downloadPageRevisionImage: vi.fn().mockResolvedValue(new Blob(['page'], { type: 'image/png' })),
      createTextRegionCorrection: vi.fn().mockResolvedValue({ id: 'job-correction', status: 'queued' }),
    } as unknown as BackendClient;
    const { container } = render(createElement(TextRegionInspectionPanel, {
      client, jobId: 'job-2', onJobCreated: vi.fn(),
    }));

    await waitFor(() => expect(container.querySelectorAll('.text-region-list button')).toHaveLength(2));
    const numbered = [...container.querySelectorAll('.text-region-list button > span')].map((item) => item.textContent);
    expect(numbered).toEqual(['1', '2']);
    const stage = await waitFor(() => {
      const value = container.querySelector('.text-region-stage') as HTMLElement | null;
      expect(value).not.toBeNull();
      return value!;
    });
    Object.defineProperty(stage, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 750, width: 500, height: 750, toJSON: () => ({}) }),
    });
    const box = container.querySelector('.text-region-overlay button') as HTMLButtonElement;
    fireEvent.pointerDown(box, { pointerId: 7, button: 0, clientX: 50, clientY: 75 });
    // Deliberately omit pointermove: mobile browsers may coalesce it.
    fireEvent.pointerUp(box, { pointerId: 7, clientX: 100, clientY: 125 });
    fireEvent.click(screen.getByRole('button', { name: 'textRegionSubmitCorrections' }));

    await waitFor(() => expect(client.createTextRegionCorrection).toHaveBeenCalledWith('job-2', {
      pages: [{
        sourceImageId: 'source-1', baseRegionSetRevisionId: 'region-set-2',
        operations: [{
          type: 'update', regionId: 'region-1',
          geometry: { x: 200, y: 250, width: 300, height: 90, rotation: 0 },
        }],
      }],
    }));
  });

  it('reloads the preview immediately when the selected OCR page changes', async () => {
    vi.stubGlobal('browser', { i18n: { getMessage: (key: string) => key } });
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:page-1')
      .mockReturnValueOnce('blob:page-2');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const page = (sourceImageId: string, sourceOrderIndex: number, pageRevisionId: string) => ({
      sourceImageId,
      sourceOrderIndex,
      sourceFileName: `${sourceOrderIndex + 1}.png`,
      pageRevisionId,
      regionSetRevisionId: `set-${sourceOrderIndex + 1}`,
      coordinateSpace: {
        kind: 'source_image_pixels' as const,
        origin: 'top_left' as const,
        width: 1000,
        height: 1500,
        rotationUnit: 'degrees_clockwise' as const,
      },
      regions: [],
    });
    const revisionPage = (sourceImageId: string, sourceOrderIndex: number, revisionId: string) => ({
      sourceImageId,
      sourceOrderIndex,
      activeRevisionId: revisionId,
      revisions: [{
        revisionId,
        revisionNumber: 1,
        active: true,
        jobId: 'job-1',
        createdAt: '2026-10-27T00:00:00.000Z',
        image: {
          id: `image-${sourceOrderIndex + 1}`,
          index: sourceOrderIndex,
          fileName: `${sourceOrderIndex + 1}.png`,
          mediaType: 'image/png',
          size: 10,
          encodedUrl: `/encoded/${sourceOrderIndex + 1}`,
          contentUrl: `/content/${sourceOrderIndex + 1}`,
        },
      }],
    });
    const client = {
      getTextRegions: vi.fn().mockResolvedValue({
        jobId: 'job-1',
        rootJobId: 'job-1',
        snapshotFingerprint: 'snapshot-1',
        pages: [page('source-1', 0, 'revision-1'), page('source-2', 1, 'revision-2')],
      }),
      getPageRevisions: vi.fn().mockResolvedValue({
        rootJobId: 'job-1',
        sourcePreflightId: 'preflight-1',
        pageCount: 2,
        pages: [revisionPage('source-1', 0, 'revision-1'), revisionPage('source-2', 1, 'revision-2')],
      }),
      downloadPageRevisionImage: vi.fn().mockResolvedValue(new Blob(['page'], { type: 'image/png' })),
    } as unknown as BackendClient;

    render(createElement(TextRegionInspectionPanel, {
      client,
      jobId: 'job-1',
      onJobCreated: vi.fn(),
    }));

    await waitFor(() => expect(screen.getByAltText('textRegionPreviewAlt').getAttribute('src')).toBe('blob:page-1'));
    fireEvent.change(screen.getByRole('combobox', { name: 'textRegionPageLabel' }), {
      target: { value: 'source-2' },
    });

    await waitFor(() => expect(client.downloadPageRevisionImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ revisionId: 'revision-2' }),
      expect.any(AbortSignal),
    ));
    await waitFor(() => expect(screen.getByAltText('textRegionPreviewAlt').getAttribute('src')).toBe('blob:page-2'));
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
        operations: [{ type: 'update', regionId: 'region-1', sourceText: 'intergalactic' }],
      }],
    }));
    expect(onJobCreated).toHaveBeenCalledWith(queued, ['source-1']);
  });

  it('queues deletion of an existing OCR region as an explicit operation', async () => {
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
          sourceText: 'false positive', translatedText: '誤判',
        }],
      }],
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
      createTextRegionCorrection: vi.fn().mockResolvedValue({ id: 'job-delete', status: 'queued' }),
    } as unknown as BackendClient;

    render(createElement(TextRegionInspectionPanel, { client, jobId: 'job-2', onJobCreated: vi.fn() }));
    fireEvent.click(await screen.findByRole('button', { name: 'textRegionDelete' }));
    fireEvent.click(screen.getByRole('button', { name: 'textRegionSubmitCorrections' }));

    await waitFor(() => expect(client.createTextRegionCorrection).toHaveBeenCalledWith('job-2', {
      pages: [{
        sourceImageId: 'source-1', baseRegionSetRevisionId: 'region-set-2',
        operations: [{ type: 'delete', regionId: 'region-1' }],
      }],
    }));
  });

  it('draws a new OCR region and queues it with source-image coordinates', async () => {
    vi.stubGlobal('browser', { i18n: { getMessage: (key: string) => key } });
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' });
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
        regions: [],
      }],
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
      createTextRegionCorrection: vi.fn().mockResolvedValue({ id: 'job-create', status: 'queued' }),
    } as unknown as BackendClient;
    const { container } = render(createElement(TextRegionInspectionPanel, { client, jobId: 'job-2', onJobCreated: vi.fn() }));

    fireEvent.click(await screen.findByRole('button', { name: 'textRegionAdd' }));
    const stage = container.querySelector('.text-region-stage') as HTMLElement;
    const overlay = container.querySelector('.text-region-overlay') as HTMLElement;
    Object.defineProperty(stage, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 750, width: 500, height: 750, toJSON: () => ({}) }),
    });
    fireEvent.pointerDown(overlay, { pointerId: 1, button: 0, clientX: 50, clientY: 75 });
    fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 250, clientY: 225 });
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 250, clientY: 225 });
    fireEvent.change(await screen.findByLabelText('textRegionSourceText'), { target: { value: 'missing text' } });
    fireEvent.click(screen.getByRole('button', { name: 'textRegionSubmitCorrections' }));

    await waitFor(() => expect(client.createTextRegionCorrection).toHaveBeenCalledWith('job-2', {
      pages: [{
        sourceImageId: 'source-1', baseRegionSetRevisionId: 'region-set-2',
        operations: [{
          type: 'create', clientOperationId: 'create-00000000-0000-4000-8000-000000000001',
          sourceText: 'missing text', geometry: { x: 100, y: 150, width: 400, height: 300, rotation: 0 },
        }],
      }],
    }));
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

  it('keeps AI OCR review as an editable draft before applying it as a correction job', async () => {
    vi.stubGlobal('browser', { i18n: { getMessage: (key: string) => key } });
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000099' });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:original') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1000, height: 1500, close: vi.fn() }));
    vi.stubGlobal('OffscreenCanvas', class {
      width: number;
      height: number;
      constructor(width: number, height: number) { this.width = width; this.height = height; }
      getContext() { return { drawImage: vi.fn() }; }
      convertToBlob() { return Promise.resolve(new Blob(['crop'], { type: 'image/png' })); }
    });
    const snapshot = {
      jobId: 'job-1', rootJobId: 'job-1', snapshotFingerprint: 'snapshot-1',
      pages: [{
        sourceImageId: 'source-1', sourceOrderIndex: 0, sourceFileName: '001.png',
        pageRevisionId: 'revision-1', regionSetRevisionId: 'set-1',
        coordinateSpace: {
          kind: 'source_image_pixels', origin: 'top_left', width: 1000, height: 1500,
          rotationUnit: 'degrees_clockwise',
        },
        regions: [{
          id: 'region-1', readingOrder: 0,
          geometry: { x: 10, y: 20, width: 100, height: 80, rotation: 0 },
          sourceText: 'old', translatedText: '舊',
        }],
      }],
    };
    const queued = {
      id: 'job-ai', type: 'translation', status: 'queued', stage: 'queued', result: null, error: null,
      createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z',
    };
    const reviewJob = {
      id: 'ocr-review-1', type: 'ocr_text_review', status: 'queued', stage: 'queued', result: null, error: null,
      createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z',
    };
    const completedReviewJob = {
      ...reviewJob,
      status: 'succeeded',
      result: {
        uploadId: 'upload-1', sourceLanguages: ['en'],
        items: [
          { clientItemId: 'region-1', originalText: 'old', correctedText: 'corrected', changed: true, status: 'succeeded' },
          { clientItemId: 'create-00000000-0000-4000-8000-000000000099', originalText: '', correctedText: 'missing dialogue', changed: true, status: 'succeeded' },
        ],
        summary: { total: 2, succeededCount: 2, failedCount: 0, changedCount: 2 },
      },
    };
    const client = {
      getTextRegions: vi.fn().mockResolvedValue(snapshot),
      getJob: vi.fn()
        .mockResolvedValueOnce({ ...queued, id: 'job-1', payload: { sourceLanguage: ['en'] } })
        .mockResolvedValueOnce(completedReviewJob),
      createUpload: vi.fn().mockResolvedValue({ uploadId: 'upload-1' }),
      uploadFiles: vi.fn().mockImplementation(async (_uploadId, files, onProgress) => {
        onProgress({ fileIndex: 0, fileCount: files.length, percent: 100 });
      }),
      completeUpload: vi.fn().mockResolvedValue({ uploadId: 'upload-1', status: 'ready' }),
      createOcrTextReviewJob: vi.fn().mockResolvedValue(reviewJob),
      createTextRegionCorrection: vi.fn().mockResolvedValue(queued),
    } as unknown as BackendClient;
    const loadOriginalImage = vi.fn().mockResolvedValue(new Blob(['original'], { type: 'image/png' }));
    const onJobCreated = vi.fn();

    const { container } = render(createElement(TextRegionInspectionPanel, {
      client, jobId: 'job-1', onJobCreated, loadOriginalImage,
    }));

    fireEvent.click(await screen.findByRole('button', { name: 'textRegionAdd' }));
    const stage = await waitFor(() => {
      const value = container.querySelector('.text-region-stage') as HTMLElement | null;
      expect(value).not.toBeNull();
      return value!;
    });
    const overlay = container.querySelector('.text-region-overlay') as HTMLElement;
    Object.defineProperty(stage, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 750, width: 500, height: 750, toJSON: () => ({}) }),
    });
    fireEvent.pointerDown(overlay, { pointerId: 9, button: 0, clientX: 100, clientY: 150 });
    fireEvent.pointerMove(overlay, { pointerId: 9, clientX: 250, clientY: 250 });
    fireEvent.pointerUp(overlay, { pointerId: 9, clientX: 250, clientY: 250 });
    const mainEditor = await screen.findByLabelText('textRegionSourceText') as HTMLTextAreaElement;
    const reviewButton = screen.getByRole('button', { name: 'textRegionAiReviewStart' }) as HTMLButtonElement;
    expect(mainEditor.value).toBe('');
    expect(reviewButton.disabled).toBe(false);
    fireEvent.change(mainEditor, { target: { value: 'rough manual hint' } });
    expect(reviewButton.disabled).toBe(false);
    fireEvent.change(mainEditor, { target: { value: '' } });
    fireEvent.click(reviewButton);
    await waitFor(() => expect(client.createOcrTextReviewJob).toHaveBeenCalledWith({
      uploadId: 'upload-1',
      sourceLanguages: ['en'],
      items: [
        { clientItemId: 'region-1', fileName: 'ocr_001.png', ocrText: 'old' },
        { clientItemId: 'create-00000000-0000-4000-8000-000000000099', fileName: 'ocr_002.png', ocrText: '' },
      ],
    }, expect.any(AbortSignal)));
    const reviewTexts = await waitFor(() => {
      const values = container.querySelectorAll('.text-region-ai-review textarea');
      expect(values).toHaveLength(2);
      return values;
    });
    expect(container.querySelector('.text-region-ai-review input[type="number"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'textRegionAiReviewRemove' })).toBeNull();
    fireEvent.change(reviewTexts[0]!, { target: { value: 'manually confirmed' } });
    fireEvent.click(screen.getByRole('button', { name: 'textRegionAiReviewApply' }));

    await waitFor(() => expect(mainEditor.value).toBe('missing dialogue'));
    expect(client.createTextRegionCorrection).not.toHaveBeenCalled();
    expect(onJobCreated).not.toHaveBeenCalled();

    fireEvent.change(mainEditor, { target: { value: 'final missing text' } });
    fireEvent.click(screen.getByRole('button', { name: 'textRegionSubmitCorrections' }));
    await waitFor(() => expect(client.createTextRegionCorrection).toHaveBeenCalledWith('job-1', {
      pages: [{
        sourceImageId: 'source-1', baseRegionSetRevisionId: 'set-1',
        operations: [
          { type: 'update', regionId: 'region-1', sourceText: 'manually confirmed' },
          {
            type: 'create', clientOperationId: 'create-00000000-0000-4000-8000-000000000099',
            sourceText: 'final missing text', geometry: { x: 200, y: 300, width: 300, height: 200, rotation: 0 },
          },
        ],
      }],
    }));
    expect(onJobCreated).toHaveBeenCalledWith(queued, ['source-1']);
  });
});
