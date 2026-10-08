import type { DetectionResult, PageImageCandidate } from './types';

export interface PageDomBridge {
  detect(deep: boolean, signal?: AbortSignal): Promise<DetectionResult>;
  apply(candidate: PageImageCandidate, url: string): Promise<boolean>;
  restore(): Promise<void>;
  setLayout(open: boolean, visible: boolean): Promise<void>;
  snapshotCanvas(candidate: PageImageCandidate): Promise<File>;
}
