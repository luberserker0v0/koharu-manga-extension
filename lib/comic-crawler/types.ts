import type { DetectorAdapterMetadata } from '../page-images/types';

export interface AdapterResolution {
  status: 'matched' | 'capability_mismatch' | 'not_found';
  adapter?: DetectorAdapterMetadata;
}

export type AdapterDiscoveryFeature = 'specific_chapters';

export interface ChapterImagesResponse {
  adapterId: string;
  chapterUrl: string;
  chapter: {
    id: string;
    canonicalUrl: string;
    stability: 'deterministic';
    identitySource: 'adapter' | 'normalized-url';
  };
  imageUrlCount: number;
  imageUrls: string[];
  images: Array<{
    id: string;
    orderIndex: number;
    url: string;
    sourceFingerprint?: string;
  }>;
  domSource: 'static' | 'dynamic' | 'interactive' | string;
  durationMs: number;
}

export interface ChapterRenderContext {
  viewport: {
    width: number;
    height: number;
  };
  deviceScaleFactor?: number;
}

export interface DiscoveryQueued {
  discoveryId: string;
  feature: AdapterDiscoveryFeature;
}

export type BrowserTarget = {
  mode: 'existing-tab';
  workerId: string;
  resourceId: string;
};

export interface BrowserTargetRecovery {
  reason: 'browser_client_process_restarted';
  reboundAt: string;
  idempotent: boolean;
}

export interface BrowserTargetReboundEvent {
  type: 'task:browser_target_rebound';
  occurredAt: string;
  previousBrowserTarget: BrowserTarget;
  browserTarget: BrowserTarget;
  previousStatus: string;
  previousTaskError?: string;
  previousResultError?: string;
  recovery: Omit<BrowserTargetRecovery, 'idempotent'>;
}

export interface RebindBrowserTargetResponse {
  task: {
    id: string;
    status: string;
    browserTarget: BrowserTarget;
  };
  previousBrowserTarget: BrowserTarget;
  recovery: BrowserTargetRecovery;
  challenge?: ChallengeDiscoveryJob;
}

export type CreateCrawlerTaskResponse =
  | { kind: 'taskCreated'; taskId: string; browserTarget: BrowserTarget }
  | {
      kind: 'discoveryQueued';
      reason: 'adapter_not_found' | 'adapter_capability_mismatch';
      discoveryId: string;
      status: string;
      normalizedUrl: string;
    }
  | {
      kind: 'challengeDiscoveryQueued';
      reason: 'browser_challenge';
      challengeDiscoveryId: string;
      status: string;
      normalizedUrl: string;
    };

export interface CrawlerTaskDetail {
  task: {
    id: string;
    url: string;
    status: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    error?: string;
    browserTarget?: BrowserTarget;
  };
  progress: {
    totalItems: number;
    completedItems: number;
    failedItems: number;
    percentage: number;
    stage?: string;
    stageDetail?: string;
  } | null;
  result?: {
    taskId: string;
    status: string;
    downloadedImages: number;
    failedImages: number;
    totalImages: number;
    error?: string;
    challengeDiscoveryId?: string;
    challengeStatus?: string;
  };
  events?: Array<BrowserTargetReboundEvent | Record<string, unknown>>;
}

export interface ChallengeDiscoveryJob {
  id: string;
  status: string;
  normalizedUrl?: string;
  browserSessionId?: string;
  browserTarget?: BrowserTarget;
  error?: string;
  updatedAt?: string;
}

export interface ChapterImagesVerificationChallenge {
  id: string;
  status: string;
  normalizedUrl: string;
  retryableAfterVerification: boolean;
  ownerUserId?: string;
  browserTarget?: BrowserTarget;
}

export interface ChapterImagesVerificationData {
  status: 'verification_required';
  challengeDiscoveryId: string;
  challengeStatus: string;
  challenge: ChapterImagesVerificationChallenge;
}

export type ChapterImagesProxyResponse = ChapterImagesResponse | {
  kind: 'verification_required';
  data: ChapterImagesVerificationData;
  message?: string;
};

export type BrowserTaskRecoveryIssue =
  | 'browser_disconnected'
  | 'resource_unavailable'
  | 'worker_changed';

export interface StoredBrowserTask {
  targetUrl: string;
  taskId?: string;
  discoveryId?: string;
  challengeDiscoveryId?: string;
  status: string;
  updatedAt: string;
  verificationStatus?: string;
  chapterImagesVerification?: ChapterImagesVerificationData;
  resumeRequestedForChallengeId?: string;
  retryNotificationSentForChallengeId?: string;
  detail?: CrawlerTaskDetail;
}
