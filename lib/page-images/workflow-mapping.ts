import type { StoredWorkflow } from '../storage/workflow';
import type { DetectionResult, PageImageCandidate } from './types';

const VOLATILE_SOURCE_QUERY = /^(?:token|signature|sig|expires?|x-amz-.+|x-goog-.+)$/i;

export interface StoredSourcePageReference {
  sourceImageId: string;
  sourceOrderIndex: number;
  sourceFileName: string;
}

export function sourcePageReferencesForWorkflow(workflow: StoredWorkflow | null): StoredSourcePageReference[] {
  if (!workflow) return [];
  const references = new Map<string, StoredSourcePageReference>();
  for (const page of workflow.comicCrawler?.pages ?? []) {
    if (!page.sourceImageId) continue;
    references.set(page.sourceImageId, {
      sourceImageId: page.sourceImageId,
      sourceOrderIndex: page.sourceOrderIndex,
      sourceFileName: page.fileName,
    });
  }
  for (const image of workflow.sourceImages ?? []) {
    if (references.has(image.sourceImageId)) continue;
    references.set(image.sourceImageId, {
      sourceImageId: image.sourceImageId,
      sourceOrderIndex: image.uploadOrder,
      sourceFileName: image.fileName,
    });
  }
  return [...references.values()].sort((left, right) => left.sourceOrderIndex - right.sourceOrderIndex);
}

export function sourceImageMatchKey(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const stable = [...url.searchParams.entries()]
      .filter(([name]) => !VOLATILE_SOURCE_QUERY.test(name))
      .sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName)
        || leftValue.localeCompare(rightValue));
    const query = new URLSearchParams(stable).toString();
    return `${url.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return null;
  }
}

export function workflowMappingComplete(result: DetectionResult | null, workflow: StoredWorkflow | null): boolean {
  if (!result?.images.length || !workflow?.fileNames.length) return false;
  try {
    return candidatesForStoredWorkflow(result.images, workflow).length === workflow.fileNames.length;
  } catch {
    return false;
  }
}

export function candidateForStoredSourceImage(
  candidates: PageImageCandidate[],
  workflow: StoredWorkflow,
  sourceImageId: string,
): PageImageCandidate | null {
  const uploadOrder = workflow.sourceImages?.find((image) => image.sourceImageId === sourceImageId)?.uploadOrder
    ?? workflow.comicCrawler?.pages?.find((page) => page.sourceImageId === sourceImageId)?.uploadOrder;
  if (uploadOrder === undefined) return null;
  return candidatesForStoredWorkflow(candidates, workflow)[uploadOrder] ?? null;
}

export function candidatesForStoredWorkflow(
  candidates: PageImageCandidate[],
  workflow: StoredWorkflow,
): PageImageCandidate[] {
  const storedPages = workflow.comicCrawler?.pages;
  if (!storedPages?.length) {
    const available = candidates.filter((image) => image.selected && image.loadStatus === 'loaded');
    const storedImages = [...(workflow.sourceImages ?? [])].sort((left, right) => left.uploadOrder - right.uploadOrder);
    if (!storedImages.length) return available;
    const byFileName = new Map<string, PageImageCandidate>();
    for (const candidate of available) {
      if (byFileName.has(candidate.fileName)) throw new Error('source_page_mapping_incomplete');
      byFileName.set(candidate.fileName, candidate);
    }
    return storedImages.map((stored) => {
      const candidate = byFileName.get(stored.fileName);
      if (!candidate) throw new Error('source_page_mapping_incomplete');
      return candidate;
    });
  }
  const byPageId = new Map(candidates.flatMap((candidate) => candidate.comicCrawler
    ? [[candidate.comicCrawler.pageId, candidate] as const]
    : []));
  const bySourceKey = new Map<string, PageImageCandidate | null>();
  for (const candidate of candidates) {
    const key = sourceImageMatchKey(candidate.sourceUrl);
    if (!key) continue;
    bySourceKey.set(key, bySourceKey.has(key) ? null : candidate);
  }
  return [...storedPages]
    .sort((left, right) => left.uploadOrder - right.uploadOrder)
    .map((stored) => {
      const sourceKey = stored.sourceUrl ? sourceImageMatchKey(stored.sourceUrl) : null;
      const candidate = byPageId.get(stored.pageId) ?? (sourceKey ? bySourceKey.get(sourceKey) ?? undefined : undefined);
      if (!candidate || candidate.loadStatus !== 'loaded') throw new Error('source_page_mapping_incomplete');
      const currentFingerprint = candidate.comicCrawler?.sourceFingerprint;
      if (stored.sourceFingerprint && currentFingerprint && stored.sourceFingerprint !== currentFingerprint) {
        throw new Error('source_page_changed');
      }
      return candidate;
    });
}
