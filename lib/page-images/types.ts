export type PageImageOrigin = 'dom' | 'comic_crawler';
export type PageImageLoadStatus = 'loaded' | 'pending' | 'failed';

export type PageImageTargetKind = 'img' | 'canvas' | 'css-background' | 'video';

export interface PageImageCandidate {
  id: string;
  order: number;
  sourceUrl: string;
  fileName: string;
  width: number | null;
  height: number | null;
  origin: PageImageOrigin;
  loadStatus: PageImageLoadStatus;
  domLocator?: string;
  targetKind?: PageImageTargetKind;
  comicCrawler?: {
    chapterId: string;
    pageId: string;
    sourceOrderIndex: number;
    sourceFingerprint?: string;
  };
  selected: boolean;
}

export interface DetectorAdapterMetadata {
  id: string;
  name?: string;
  version?: string;
}

export interface DetectionResult {
  images: PageImageCandidate[];
  detector: PageImageOrigin;
  adapter?: DetectorAdapterMetadata;
  adapterStatus?: 'matched' | 'capability_mismatch' | 'not_found';
  chapterUrl?: string;
  chapterIdentity?: {
    id: string;
    canonicalUrl: string;
    stability: 'deterministic';
    identitySource: 'adapter' | 'normalized-url';
  };
  warnings: string[];
  discoveryAvailable: boolean;
}

export interface DetectionOptions {
  deep?: boolean;
  resolveOnly?: boolean;
  timeoutMs?: number;
  renderContext?: {
    viewport: { width: number; height: number };
    deviceScaleFactor?: number;
  };
  signal?: AbortSignal;
  onProgress?: (count: number) => void;
}

export interface ImageDetector {
  detect(url: string, options?: DetectionOptions): Promise<DetectionResult>;
}

export interface SourceBytes {
  bytes: ArrayBuffer;
  contentType: string;
  fileName: string;
}
