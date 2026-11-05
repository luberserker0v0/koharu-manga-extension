import type { ChapterImageManifest } from '../comic-crawler/types';
import type { StoredWorkflow } from '../storage/workflow';
import type { PassiveSourcePage } from './passive-translation-applicator';
import type { PageImageCandidate } from './types';

export function passiveSourcePagesForWorkflow(workflow: StoredWorkflow | null): PassiveSourcePage[] | null {
  const pages = workflow?.comicCrawler?.pages;
  if (!workflow?.jobId || !pages?.length || pages.length !== workflow.fileNames.length) return null;
  if (pages.some((page) => !page.sourceImageId)) return null;
  return pages.map((page) => ({
    pageId: page.pageId,
    sourceImageId: page.sourceImageId!,
  }));
}

export function workflowManifestCompatibilityError(
  manifest: ChapterImageManifest | null,
  workflow: StoredWorkflow,
): string | null {
  const crawler = workflow.comicCrawler;
  if (!manifest || !crawler?.chapterId || !crawler.pages?.length) return 'source_page_manifest_unavailable';
  if (manifest.adapterId !== crawler.adapterId || manifest.chapter.id !== crawler.chapterId) {
    return 'source_page_mapping_incomplete';
  }
  if (crawler.manifestRevision && crawler.manifestRevision !== manifest.revision) {
    return 'source_page_manifest_changed';
  }
  const manifestPages = new Map(manifest.images.map((image) => [image.id, image]));
  for (const page of crawler.pages) {
    const current = manifestPages.get(page.pageId);
    if (!current) return 'source_page_mapping_incomplete';
    if (page.sourceFingerprint && current.sourceFingerprint
      && page.sourceFingerprint !== current.sourceFingerprint) return 'source_page_changed';
  }
  return null;
}

export function originalCandidateFromChapterManifest(
  manifest: ChapterImageManifest,
  workflow: StoredWorkflow,
  sourceImageId: string,
): PageImageCandidate {
  const compatibilityError = workflowManifestCompatibilityError(manifest, workflow);
  if (compatibilityError) throw new Error(compatibilityError);
  const stored = workflow.comicCrawler!.pages!.find((page) => page.sourceImageId === sourceImageId);
  if (!stored) throw new Error('source_page_mapping_incomplete');
  const image = manifest.images.find((candidate) => candidate.id === stored.pageId);
  if (!image) throw new Error('source_page_mapping_incomplete');
  return {
    id: `crawler:${image.id}`,
    order: stored.uploadOrder,
    sourceUrl: image.url,
    fileName: stored.fileName,
    width: null,
    height: null,
    origin: 'comic_crawler',
    loadStatus: 'loaded',
    comicCrawler: {
      chapterId: manifest.chapter.id,
      pageId: image.id,
      sourceOrderIndex: image.orderIndex,
      ...(image.sourceFingerprint ? { sourceFingerprint: image.sourceFingerprint } : {}),
    },
    selected: true,
  };
}
