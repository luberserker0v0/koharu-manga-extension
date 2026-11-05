import type {
  JobResource,
  OcrTextReviewResultItem,
  TextRegionPage,
  TextRegionSnapshot,
} from '../api/types';
import {
  buildTextRegionPageCorrections,
  draftFromRegion,
  textRegionDraftKey,
  type CreatedTextRegionDraft,
  type TextRegionDraft,
} from './corrections';
import type { StoredTextRegionWorkspace } from './workspace';

export type ChapterOcrBatchStatus =
  | 'preparing'
  | 'reviewing'
  | 'submitting'
  | 'translating'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'canceled';

export interface StoredChapterOcrTarget {
  clientItemId: string;
  sourceImageId: string;
  regionId: string;
  targetKind: 'existing' | 'created';
  originalText: string;
}

export interface StoredChapterOcrReviewJob {
  jobId: string;
  sourceImageIds: string[];
  targets: StoredChapterOcrTarget[];
}

export interface ChapterOcrBatchSummary {
  totalChapterPages: number;
  totalPages: number;
  totalRegions: number;
  reviewedRegions: number;
  succeededRegions: number;
  failedRegions: number;
  changedRegions: number;
  correctionPages: number;
  unchangedPages: number;
  failedWithoutRetranslationPages: number;
  partialFailurePages: number;
  retranslatedPageNumbers: number[];
  unchangedPageNumbers: number[];
  failedPageNumbers: number[];
  partialFailurePageNumbers: number[];
}

export interface StoredChapterOcrBatch {
  id: string;
  baseJobId: string;
  status: ChapterOcrBatchStatus;
  processedSourceImageIds: string[];
  reviewJobs: StoredChapterOcrReviewJob[];
  sourceImageIds: string[];
  summary: ChapterOcrBatchSummary;
  correctionJobId?: string;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterOcrTargetInput extends StoredChapterOcrTarget {
  id: string;
  readingOrder: number;
  geometry: TextRegionDraft['geometry'];
  sourceText: string;
}

export interface ChapterOcrCorrectionResult {
  pages: ReturnType<typeof buildTextRegionPageCorrections>;
  summary: Pick<ChapterOcrBatchSummary,
    | 'reviewedRegions' | 'succeededRegions' | 'failedRegions' | 'changedRegions' | 'correctionPages'
    | 'unchangedPages' | 'failedWithoutRetranslationPages' | 'partialFailurePages'
    | 'retranslatedPageNumbers' | 'unchangedPageNumbers' | 'failedPageNumbers' | 'partialFailurePageNumbers'>;
}

export const OCR_REVIEW_BATCH_LIMIT = 500;

export function chapterOcrBatchIsActive(batch: StoredChapterOcrBatch | undefined): boolean {
  return Boolean(batch && !['succeeded', 'failed', 'canceled'].includes(batch.status));
}

function workspaceMaps(workspace: StoredTextRegionWorkspace | undefined) {
  return {
    drafts: new Map(workspace?.drafts ?? []),
    createdDrafts: new Map(workspace?.createdDrafts ?? []),
    deletedRegionKeys: new Set(workspace?.deletedRegionKeys ?? []),
  };
}

export function chapterOcrTargetsForPage(
  page: TextRegionPage,
  workspace: StoredTextRegionWorkspace | undefined,
): ChapterOcrTargetInput[] {
  const { drafts, createdDrafts, deletedRegionKeys } = workspaceMaps(workspace);
  const existing = page.regions.flatMap((region, index) => {
    const key = textRegionDraftKey(page.sourceImageId, region.id);
    if (deletedRegionKeys.has(key)) return [];
    const draft = drafts.get(key) ?? draftFromRegion(region);
    // A user-edited transcription is already authoritative. Preserve it instead of
    // sending it through the automatic chapter-wide review.
    if (draft.sourceText !== region.sourceText) return [];
    const clientItemId = JSON.stringify([page.sourceImageId, 'existing', region.id]);
    return [{
      id: clientItemId,
      clientItemId,
      sourceImageId: page.sourceImageId,
      regionId: region.id,
      targetKind: 'existing' as const,
      originalText: draft.sourceText,
      sourceText: draft.sourceText,
      geometry: { ...draft.geometry },
      readingOrder: index,
    }];
  });
  const created = [...createdDrafts.values()].flatMap((draft, index) => {
    if (draft.sourceImageId !== page.sourceImageId || draft.sourceText.trim()) return [];
    const clientItemId = JSON.stringify([page.sourceImageId, 'created', draft.clientOperationId]);
    return [{
      id: clientItemId,
      clientItemId,
      sourceImageId: page.sourceImageId,
      regionId: draft.clientOperationId,
      targetKind: 'created' as const,
      originalText: draft.sourceText,
      sourceText: draft.sourceText,
      geometry: { ...draft.geometry },
      readingOrder: existing.length + index,
    }];
  });
  return [...existing, ...created];
}

export function buildChapterOcrCorrections(
  snapshot: TextRegionSnapshot,
  workspace: StoredTextRegionWorkspace | undefined,
  reviewJobs: StoredChapterOcrReviewJob[],
  completedJobs: JobResource[],
): ChapterOcrCorrectionResult {
  const { drafts, createdDrafts, deletedRegionKeys } = workspaceMaps(workspace);
  const jobById = new Map(completedJobs.map((job) => [job.id, job]));
  let reviewedRegions = 0;
  let succeededRegions = 0;
  let failedRegions = 0;
  let changedRegions = 0;
  const failedSourceImageIds = new Set<string>();

  for (const reviewJob of reviewJobs) {
    reviewedRegions += reviewJob.targets.length;
    const job = jobById.get(reviewJob.jobId);
    if (!job || job.status !== 'succeeded' || !job.result || !Array.isArray(job.result.items)) {
      failedRegions += reviewJob.targets.length;
      reviewJob.targets.forEach((target) => failedSourceImageIds.add(target.sourceImageId));
      continue;
    }
    const resultItems = job.result.items as OcrTextReviewResultItem[];
    const resultById = new Map(resultItems.map((item) => [item.clientItemId, item]));
    for (const target of reviewJob.targets) {
      const result = resultById.get(target.clientItemId);
      if (!result || result.status !== 'succeeded' || !result.correctedText.trim()) {
        failedRegions += 1;
        failedSourceImageIds.add(target.sourceImageId);
        continue;
      }
      succeededRegions += 1;
      if (result.correctedText === target.originalText) continue;
      if (target.targetKind === 'existing') {
        const page = snapshot.pages.find((item) => item.sourceImageId === target.sourceImageId);
        const region = page?.regions.find((item) => item.id === target.regionId);
        if (!page || !region) continue;
        const key = textRegionDraftKey(target.sourceImageId, target.regionId);
        const current = drafts.get(key);
        // Preserve text typed manually after the batch was started.
        if (current && current.sourceText !== target.originalText) continue;
        drafts.set(key, {
          ...(current ?? draftFromRegion(region)),
          sourceText: result.correctedText,
        });
        changedRegions += 1;
      } else {
        const key = textRegionDraftKey(target.sourceImageId, target.regionId);
        const current = createdDrafts.get(key);
        if (current && current.sourceText === target.originalText) {
          createdDrafts.set(key, { ...current, sourceText: result.correctedText });
          changedRegions += 1;
        }
      }
    }
  }

  const pages = buildTextRegionPageCorrections(snapshot.pages, drafts, createdDrafts, deletedRegionKeys);
  const pageNumberBySourceImageId = new Map(snapshot.pages.map((page) => [page.sourceImageId, page.sourceOrderIndex + 1]));
  const ocrSourceImageIds = snapshot.pages.filter((page) => page.regions.length > 0).map((page) => page.sourceImageId);
  const correctionSourceImageIds = new Set(pages.map((page) => page.sourceImageId));
  const retranslatedPageNumbers = pages.flatMap((page) => {
    const pageNumber = pageNumberBySourceImageId.get(page.sourceImageId);
    return pageNumber === undefined ? [] : [pageNumber];
  }).sort((left, right) => left - right);
  const unchangedPageNumbers = ocrSourceImageIds.flatMap((sourceImageId) => {
    if (correctionSourceImageIds.has(sourceImageId) || failedSourceImageIds.has(sourceImageId)) return [];
    const pageNumber = pageNumberBySourceImageId.get(sourceImageId);
    return pageNumber === undefined ? [] : [pageNumber];
  }).sort((left, right) => left - right);
  const failedPageNumbers = ocrSourceImageIds.flatMap((sourceImageId) => {
    if (correctionSourceImageIds.has(sourceImageId) || !failedSourceImageIds.has(sourceImageId)) return [];
    const pageNumber = pageNumberBySourceImageId.get(sourceImageId);
    return pageNumber === undefined ? [] : [pageNumber];
  }).sort((left, right) => left - right);
  const partialFailurePageNumbers = ocrSourceImageIds.flatMap((sourceImageId) => {
    if (!correctionSourceImageIds.has(sourceImageId) || !failedSourceImageIds.has(sourceImageId)) return [];
    const pageNumber = pageNumberBySourceImageId.get(sourceImageId);
    return pageNumber === undefined ? [] : [pageNumber];
  }).sort((left, right) => left - right);
  return {
    pages,
    summary: {
      reviewedRegions,
      succeededRegions,
      failedRegions,
      changedRegions,
      correctionPages: pages.length,
      unchangedPages: unchangedPageNumbers.length,
      failedWithoutRetranslationPages: failedPageNumbers.length,
      partialFailurePages: partialFailurePageNumbers.length,
      retranslatedPageNumbers,
      unchangedPageNumbers,
      failedPageNumbers,
      partialFailurePageNumbers,
    },
  };
}

export function emptyChapterOcrBatchSummary(): ChapterOcrBatchSummary {
  return {
    totalChapterPages: 0,
    totalPages: 0,
    totalRegions: 0,
    reviewedRegions: 0,
    succeededRegions: 0,
    failedRegions: 0,
    changedRegions: 0,
    correctionPages: 0,
    unchangedPages: 0,
    failedWithoutRetranslationPages: 0,
    partialFailurePages: 0,
    retranslatedPageNumbers: [],
    unchangedPageNumbers: [],
    failedPageNumbers: [],
    partialFailurePageNumbers: [],
  };
}
