import type { DetectionResult, PageImageCandidate } from './types';
import type { PageNumberOverlayEntry } from './page-number-overlay';

export interface PageDomBridge {
  detect(deep: boolean, signal?: AbortSignal, preserveDuplicateUrls?: boolean): Promise<DetectionResult>;
  apply(candidate: PageImageCandidate, url: string): Promise<boolean>;
  restore(): Promise<void>;
  setLayout(open: boolean, visible: boolean): Promise<void>;
  snapshotCanvas(candidate: PageImageCandidate): Promise<File>;
  setPageNumberLabels(entries: PageNumberOverlayEntry[]): Promise<void>;
}
