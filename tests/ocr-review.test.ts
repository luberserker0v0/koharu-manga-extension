import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOcrReviewCrops,
  paddedCropRectangle,
  scaledCropDimensions,
  sourceLanguagesFromJob,
} from '../lib/text-regions/ocr-review';
import type { JobResource } from '../lib/api/types';

afterEach(() => vi.unstubAllGlobals());

describe('OCR text review crops', () => {
  it('pads, scales, and clamps a region crop to the decoded bitmap', () => {
    expect(paddedCropRectangle(
      { x: 0, y: 10, width: 100, height: 50, rotation: 0 },
      1000,
      2000,
      500,
      1000,
    )).toEqual({ x: 0, y: 2, width: 56, height: 31 });
  });

  it('preserves ordered source-language priorities from the parent Job', () => {
    const job = { payload: { sourceLanguage: ['en', 'ja'] } } as unknown as JobResource;
    expect(sourceLanguagesFromJob(job)).toEqual(['en', 'ja']);
  });

  it('upscales small OCR crops without exceeding the vision input ceiling', () => {
    expect(scaledCropDimensions(62, 34)).toEqual({ width: 512, height: 281 });
    expect(scaledCropDimensions(235, 107)).toEqual({ width: 562, height: 256 });
    expect(scaledCropDimensions(2000, 1000)).toEqual({ width: 1536, height: 768 });
  });

  it('creates isolated requests without neighboring OCR context', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({
      width: 1000,
      height: 1500,
      close: vi.fn(),
    }));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) {}
      getContext() { return { drawImage: vi.fn() }; }
      convertToBlob() { return Promise.resolve(new Blob(['crop'], { type: 'image/png' })); }
    });
    const page = {
      sourceImageId: 'source-1', sourceOrderIndex: 0, sourceFileName: '001.png',
      pageRevisionId: 'revision-1', regionSetRevisionId: 'set-1',
      coordinateSpace: {
        kind: 'source_image_pixels' as const, origin: 'top_left' as const,
        width: 1000, height: 1500, rotationUnit: 'degrees_clockwise' as const,
      },
      regions: [
        { id: 'region-2', readingOrder: 1, geometry: { x: 20, y: 120, width: 120, height: 90, rotation: 0 }, sourceText: 'second', translatedText: '' },
        { id: 'region-1', readingOrder: 0, geometry: { x: 10, y: 20, width: 100, height: 80, rotation: 0 }, sourceText: 'first', translatedText: '' },
        { id: 'region-3', readingOrder: 2, geometry: { x: 30, y: 230, width: 140, height: 100, rotation: 0 }, sourceText: 'third', translatedText: '' },
      ],
    };

    const crops = await createOcrReviewCrops(new Blob(['page'], { type: 'image/png' }), page);

    expect(crops.map((item) => item.request)).toEqual([
      { clientItemId: 'region-1', fileName: 'ocr_001.png', ocrText: 'first' },
      { clientItemId: 'region-2', fileName: 'ocr_002.png', ocrText: 'second' },
      { clientItemId: 'region-3', fileName: 'ocr_003.png', ocrText: 'third' },
    ]);
    expect(JSON.stringify(crops.map((item) => item.request))).not.toContain('contextBefore');
    expect(JSON.stringify(crops.map((item) => item.request))).not.toContain('contextAfter');
  });

  it('creates an AI OCR request for a locally-created region with an empty text hint', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({
      width: 1000,
      height: 1500,
      close: vi.fn(),
    }));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) {}
      getContext() { return { drawImage: vi.fn() }; }
      convertToBlob() { return Promise.resolve(new Blob(['crop'], { type: 'image/png' })); }
    });
    const page = {
      sourceImageId: 'source-1', sourceOrderIndex: 0, sourceFileName: '001.png',
      pageRevisionId: 'revision-1', regionSetRevisionId: 'set-1',
      coordinateSpace: {
        kind: 'source_image_pixels' as const, origin: 'top_left' as const,
        width: 1000, height: 1500, rotationUnit: 'degrees_clockwise' as const,
      },
      regions: [],
    };

    const crops = await createOcrReviewCrops(new Blob(['page'], { type: 'image/png' }), page, [{
      id: 'create-local-1', readingOrder: 0,
      geometry: { x: 100, y: 200, width: 300, height: 100, rotation: 0 },
      sourceText: '',
    }]);

    expect(crops.map((item) => item.request)).toEqual([{
      clientItemId: 'create-local-1', fileName: 'ocr_001.png', ocrText: '',
    }]);
  });
});
