import type { StoredWorkflow } from '../storage/workflow';
import type { PageImageCandidate } from './types';

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
  return [...storedPages]
    .sort((left, right) => left.uploadOrder - right.uploadOrder)
    .map((stored) => {
      const candidate = byPageId.get(stored.pageId);
      if (!candidate || candidate.loadStatus !== 'loaded') throw new Error('source_page_mapping_incomplete');
      const currentFingerprint = candidate.comicCrawler?.sourceFingerprint;
      if (stored.sourceFingerprint && currentFingerprint && stored.sourceFingerprint !== currentFingerprint) {
        throw new Error('source_page_changed');
      }
      return candidate;
    });
}
