import type {
  JobResource,
  OcrTextReviewItemRequest,
  OcrTextReviewJobResult,
  TextRegionCorrectionGeometry,
  TextRegionPage,
} from '../api/types';

export interface OcrReviewCrop {
  file: File;
  request: OcrTextReviewItemRequest;
}

export interface OcrReviewRegionInput {
  id: string;
  readingOrder: number;
  geometry: TextRegionCorrectionGeometry;
  sourceText: string;
}

export interface CropRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_CROP_LONG_EDGE = 512;
const MIN_CROP_SHORT_EDGE = 256;
const MAX_CROP_LONG_EDGE = 1536;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function paddedCropRectangle(
  geometry: TextRegionCorrectionGeometry,
  sourceWidth: number,
  sourceHeight: number,
  bitmapWidth: number,
  bitmapHeight: number,
): CropRectangle {
  const paddingX = Math.max(4, geometry.width * 0.12);
  const paddingY = Math.max(4, geometry.height * 0.12);
  const left = clamp(geometry.x - paddingX, 0, sourceWidth);
  const top = clamp(geometry.y - paddingY, 0, sourceHeight);
  const right = clamp(geometry.x + geometry.width + paddingX, left + 1, sourceWidth);
  const bottom = clamp(geometry.y + geometry.height + paddingY, top + 1, sourceHeight);
  const scaleX = bitmapWidth / sourceWidth;
  const scaleY = bitmapHeight / sourceHeight;
  const x = Math.floor(left * scaleX);
  const y = Math.floor(top * scaleY);
  return {
    x,
    y,
    width: Math.max(1, Math.min(bitmapWidth - x, Math.ceil((right - left) * scaleX))),
    height: Math.max(1, Math.min(bitmapHeight - y, Math.ceil((bottom - top) * scaleY))),
  };
}

export function scaledCropDimensions(width: number, height: number): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  let scale = Math.max(1, MIN_CROP_LONG_EDGE / longEdge, MIN_CROP_SHORT_EDGE / shortEdge);
  if (longEdge * scale > MAX_CROP_LONG_EDGE) scale = MAX_CROP_LONG_EDGE / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function canvasPng(source: CanvasImageSource, crop: CropRectangle): Promise<Blob> {
  const output = scaledCropDimensions(crop.width, crop.height);
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(output.width, output.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('ocr_review_canvas_unavailable');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, output.width, output.height);
    return canvas.convertToBlob({ type: 'image/png' });
  }
  const canvas = document.createElement('canvas');
  canvas.width = output.width;
  canvas.height = output.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('ocr_review_canvas_unavailable');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, output.width, output.height);
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('ocr_review_crop_encoding_failed')),
    'image/png',
  ));
}

export async function createOcrReviewCrops(
  image: Blob,
  page: TextRegionPage,
  regions: readonly OcrReviewRegionInput[] = page.regions,
): Promise<OcrReviewCrop[]> {
  const bitmap = await createImageBitmap(image);
  try {
    const ordered = [...regions].sort((left, right) => left.readingOrder - right.readingOrder);
    const output: OcrReviewCrop[] = [];
    for (let index = 0; index < ordered.length; index += 1) {
      const region = ordered[index]!;
      const crop = paddedCropRectangle(
        region.geometry,
        page.coordinateSpace.width,
        page.coordinateSpace.height,
        bitmap.width,
        bitmap.height,
      );
      const blob = await canvasPng(bitmap, crop);
      const fileName = `ocr_${String(index + 1).padStart(3, '0')}.png`;
      output.push({
        file: new File([blob], fileName, { type: 'image/png' }),
        request: {
          clientItemId: region.id,
          fileName,
          ocrText: region.sourceText,
        },
      });
    }
    return output;
  } finally {
    bitmap.close();
  }
}

export function parseOcrTextReviewResult(job: JobResource): OcrTextReviewJobResult {
  const result = job.result as unknown as Partial<OcrTextReviewJobResult> | null;
  if (!result || !Array.isArray(result.items) || !result.summary || !Array.isArray(result.sourceLanguages)) {
    throw new Error('ocr_text_review_result_invalid');
  }
  return result as OcrTextReviewJobResult;
}

export function sourceLanguagesFromJob(job: JobResource): string[] {
  const sourceLanguage = job.payload?.sourceLanguage;
  if (Array.isArray(sourceLanguage)) return sourceLanguage.filter((item): item is string => typeof item === 'string');
  return typeof sourceLanguage === 'string' && sourceLanguage ? [sourceLanguage] : [];
}
