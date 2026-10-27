import { describe, expect, it } from 'vitest';
import { orderedTranslatedImages } from '../lib/artifacts/translated-images';
import type { TranslatedImagesEnvelope } from '../lib/api/types';

function manifest(indexes: number[]): TranslatedImagesEnvelope {
  return {
    jobId: 'job-1',
    rootJobId: 'job-1',
    artifactId: 8,
    sourceFormat: 'zip',
    count: indexes.length,
    images: indexes.map((index) => ({
      id: `page-${index}`,
      index,
      fileName: `page-${index + 1}.png`,
      mediaType: 'image/png',
      size: 100,
      encodedUrl: `/api/v1/jobs/job-1/translated-images/page-${index}`,
      contentUrl: `/api/v1/jobs/job-1/translated-images/page-${index}/content`,
      sourceImageId: `source-${index}`,
      sourceOrderIndex: index,
      revisionId: `revision-${index}`,
      revisionNumber: 1,
      active: true,
    })),
  };
}

describe('translated image manifest', () => {
  it('uses the backend index to order translated pages', () => {
    expect(orderedTranslatedImages(manifest([2, 0, 1]), 3).map((image) => image.index)).toEqual([0, 1, 2]);
  });

  it('rejects a source/result count mismatch', () => {
    expect(() => orderedTranslatedImages(manifest([0]), 2)).toThrow('artifact_image_count_mismatch');
  });

  it('rejects duplicate or non-contiguous indexes', () => {
    expect(() => orderedTranslatedImages(manifest([0, 0]), 2)).toThrow('translated_images_contract_invalid');
  });
});
