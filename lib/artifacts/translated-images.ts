import type { TranslatedImage, TranslatedImagesEnvelope } from '../api/types';

export function orderedTranslatedImages(
  manifest: TranslatedImagesEnvelope,
  selectedImageCount: number,
): TranslatedImage[] {
  if (manifest.count !== manifest.images.length) throw new Error('translated_images_contract_invalid');
  if (manifest.images.length !== selectedImageCount) throw new Error('artifact_image_count_mismatch');
  const ordered = [...manifest.images].sort((left, right) => left.index - right.index);
  for (let index = 0; index < ordered.length; index += 1) {
    const image = ordered[index]!;
    if (image.index !== index || !image.id || !image.mediaType.startsWith('image/')) {
      throw new Error('translated_images_contract_invalid');
    }
  }
  return ordered;
}
