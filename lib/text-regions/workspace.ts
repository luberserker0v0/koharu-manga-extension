import type { JobStatus, TextRegionCorrectionGeometry, TextRegionReviewRegion } from '../api/types';
import type { CreatedTextRegionDraft, TextRegionDraft } from './corrections';

export type BackgroundTaskKind = 'selective_retranslation' | 'text_region_correction' | 'ocr_text_review';

export interface StoredBackgroundTask {
  jobId: string;
  kind: BackgroundTaskKind;
  parentJobId?: string;
  sourceImageIds: string[];
  status: JobStatus;
  stage: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  reconciledAt?: string;
  error?: string | null;
}

export interface StoredPageReviewDraft {
  count: number;
  baseRegionSetRevisionId: string;
  regions: Array<TextRegionReviewRegion & {
    clientItemId: string;
    originalText: string;
    targetKind: 'existing' | 'created';
    status: 'succeeded' | 'failed';
    error?: string;
    code?: string | null;
  }>;
}

export interface StoredOcrReviewTarget {
  id: string;
  readingOrder: number;
  geometry: TextRegionCorrectionGeometry;
  sourceText: string;
  targetKind: 'existing' | 'created';
}

export interface StoredActiveOcrReview {
  jobId: string;
  sourceImageId: string;
  targets: StoredOcrReviewTarget[];
}

export interface StoredTextRegionWorkspace {
  baseJobId: string;
  selectedSourceImageId?: string;
  selectedRegionId?: string;
  drafts: Array<[string, TextRegionDraft]>;
  createdDrafts: Array<[string, CreatedTextRegionDraft]>;
  deletedRegionKeys: string[];
  reviewDrafts: Array<[string, StoredPageReviewDraft]>;
  activeReview?: StoredActiveOcrReview;
  instructions: string;
  updatedAt: string;
}

function sourceImageIdFromKey(key: string): string | null {
  try {
    const value = JSON.parse(key);
    return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
  } catch { return null; }
}

export function rebaseTextRegionWorkspace(
  workspace: StoredTextRegionWorkspace | undefined,
  baseJobId: string,
  affectedSourceImageIds: string[],
): StoredTextRegionWorkspace | undefined {
  if (!workspace) return undefined;
  const affected = new Set(affectedSourceImageIds);
  const drafts = workspace.drafts.filter(([key]) => !affected.has(sourceImageIdFromKey(key) ?? ''));
  const createdDrafts = workspace.createdDrafts.filter(([, draft]) => !affected.has(draft.sourceImageId));
  const deletedRegionKeys = workspace.deletedRegionKeys.filter((key) => !affected.has(sourceImageIdFromKey(key) ?? ''));
  const reviewDrafts = workspace.reviewDrafts.filter(([sourceImageId]) => !affected.has(sourceImageId));
  const activeReview = workspace.activeReview && !affected.has(workspace.activeReview.sourceImageId)
    ? workspace.activeReview
    : undefined;
  const hasContent = drafts.length || createdDrafts.length || deletedRegionKeys.length || reviewDrafts.length
    || activeReview || workspace.instructions.trim();
  if (!hasContent) return undefined;
  const next: StoredTextRegionWorkspace = {
    ...workspace,
    baseJobId,
    drafts,
    createdDrafts,
    deletedRegionKeys,
    reviewDrafts,
    updatedAt: new Date().toISOString(),
  };
  if (activeReview) next.activeReview = activeReview;
  else delete next.activeReview;
  return next;
}
