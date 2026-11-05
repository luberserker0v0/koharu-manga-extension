import { describe, expect, it, vi } from 'vitest';
import { PassiveTranslationApplicator } from '../lib/page-images/passive-translation-applicator';
import type { PageImageCandidate } from '../lib/page-images/types';

function candidate(id: string, sourceUrl: string): PageImageCandidate {
  return {
    id,
    order: 0,
    sourceUrl,
    fileName: `${id}.jpg`,
    width: 800,
    height: 1200,
    origin: 'dom',
    loadStatus: 'loaded',
    selected: true,
  };
}

describe('passive translated-image application', () => {
  it('replaces images only as matching source images are naturally offered', async () => {
    const applied: string[] = [];
    const progress = vi.fn();
    const applicator = new PassiveTranslationApplicator({
      pages: [
        { pageId: 'page-1', sourceImageId: 'source-1' },
        { pageId: 'page-2', sourceImageId: 'source-2' },
      ],
      resolveTranslatedUrl: async (sourceImageId) => `data:${sourceImageId}`,
      apply: async (image) => { applied.push(image.id); return true; },
      onProgress: progress,
    });

    applicator.offerResolved('page-1', candidate('visible-1', 'https://new.test/book/1.jpg?token=renewed'));
    await vi.waitFor(() => expect(applied).toEqual(['visible-1']));
    expect(progress).toHaveBeenLastCalledWith({ completed: 1, total: 2 });

    applicator.offerResolved('page-2', candidate('visible-2', 'https://new.test/book/2.jpg?expires=999'));
    await applicator.completion;
    expect(applied).toEqual(['visible-1', 'visible-2']);
    expect(progress).toHaveBeenLastCalledWith({ completed: 2, total: 2 });
  });

  it('bounds concurrent translated-image downloads', async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const pages = Array.from({ length: 4 }, (_, index) => ({
      pageId: `page-${index}`,
      sourceImageId: `source-${index}`,
    }));
    const applicator = new PassiveTranslationApplicator({
      pages,
      concurrency: 2,
      resolveTranslatedUrl: async (sourceImageId) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return `data:${sourceImageId}`;
      },
      apply: async () => true,
    });

    pages.forEach((page, index) => applicator.offerResolved(
      page.pageId,
      candidate(`candidate-${index}`, `https://cdn.test/book/${index}.jpg`),
    ));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0).forEach((release) => release());
    await applicator.completion;
    expect(maximum).toBe(2);
  });
});
