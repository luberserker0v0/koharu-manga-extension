import type { DetectorAdapterMetadata } from '../page-images/types';

export interface AdapterResolution {
  status: 'matched' | 'capability_mismatch' | 'not_found';
  adapter?: DetectorAdapterMetadata;
}

export type AdapterDiscoveryFeature = 'specific_chapters';

export interface ChapterImagesResponse {
  adapterId: string;
  chapterUrl: string;
  imageUrlCount: number;
  imageUrls: string[];
  domSource: 'static' | 'dynamic' | 'interactive' | string;
  durationMs: number;
}

export interface DiscoveryQueued {
  discoveryId: string;
  feature: AdapterDiscoveryFeature;
}
