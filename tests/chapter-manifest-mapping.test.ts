import { describe, expect, it } from 'vitest';
import type { ChapterImageManifest } from '../lib/comic-crawler/types';
import {
  originalCandidateFromChapterManifest,
  passiveSourcePagesForWorkflow,
  workflowManifestCompatibilityError,
} from '../lib/page-images/chapter-manifest';
import type { StoredWorkflow } from '../lib/storage/workflow';

const revisionA = `sha256:${'a'.repeat(64)}`;
const revisionB = `sha256:${'b'.repeat(64)}`;

function manifest(revision = revisionA): ChapterImageManifest {
  return {
    adapterId: 'reader',
    chapter: {
      id: 'chapter-1',
      canonicalUrl: 'https://reader.test/chapter/1',
      stability: 'deterministic',
      identitySource: 'normalized-url',
    },
    identityResolver: { id: 'normalized-url', version: 1 },
    revision,
    capturedAt: '2026-10-30T00:00:00.000Z',
    images: [
      { id: 'page-1', orderIndex: 0, url: 'https://cdn.test/1.jpg', sourceFingerprint: 'etag:first' },
      { id: 'page-2', orderIndex: 1, url: 'https://cdn.test/2.jpg' },
    ],
  };
}

function workflow(manifestRevision?: string): StoredWorkflow {
  return {
    uploadId: 'upload-1',
    jobId: 'job-1',
    fileNames: ['1.jpg', '2.jpg'],
    updatedAt: '2026-10-30T00:00:00.000Z',
    comicCrawler: {
      adapterId: 'reader',
      chapterUrl: 'https://reader.test/chapter/1',
      chapterId: 'chapter-1',
      ...(manifestRevision ? { manifestRevision } : {}),
      pages: [
        { pageId: 'page-1', sourceOrderIndex: 0, uploadOrder: 0, fileName: '1.jpg', sourceImageId: 'source-1', sourceFingerprint: 'etag:first' },
        { pageId: 'page-2', sourceOrderIndex: 1, uploadOrder: 1, fileName: '2.jpg', sourceImageId: 'source-2' },
      ],
    },
  };
}

describe('persisted chapter manifest workflow mapping', () => {
  it('creates a passive page mapping without reproducing ComicCrawler URL normalization', () => {
    expect(passiveSourcePagesForWorkflow(workflow(revisionA))).toEqual([
      { pageId: 'page-1', sourceImageId: 'source-1' },
      { pageId: 'page-2', sourceImageId: 'source-2' },
    ]);
    expect(workflowManifestCompatibilityError(manifest(), workflow(revisionA))).toBeNull();
  });

  it('rejects a newer semantic manifest revision', () => {
    expect(workflowManifestCompatibilityError(manifest(revisionB), workflow(revisionA)))
      .toBe('source_page_manifest_changed');
  });

  it('supports older stored workflows only while their page IDs and fingerprints remain compatible', () => {
    expect(workflowManifestCompatibilityError(manifest(), workflow())).toBeNull();
    const changed = manifest();
    changed.images[0] = { ...changed.images[0]!, sourceFingerprint: 'etag:replacement' };
    expect(workflowManifestCompatibilityError(changed, workflow())).toBe('source_page_changed');
  });

  it('recovers an original image URL for a legacy workflow that only stored stable page IDs', () => {
    const saved = workflow();
    const candidate = originalCandidateFromChapterManifest(manifest(), saved, 'source-2');

    expect(candidate).toMatchObject({
      sourceUrl: 'https://cdn.test/2.jpg',
      fileName: '2.jpg',
      order: 1,
      loadStatus: 'loaded',
      comicCrawler: { chapterId: 'chapter-1', pageId: 'page-2', sourceOrderIndex: 1 },
    });
  });

  it('requires every selected page to exist in the current owner-scoped manifest', () => {
    const incomplete = manifest();
    incomplete.images = incomplete.images.slice(0, 1);
    expect(workflowManifestCompatibilityError(incomplete, workflow())).toBe('source_page_mapping_incomplete');
  });
});
