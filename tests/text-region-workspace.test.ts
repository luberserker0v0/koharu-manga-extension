import { describe, expect, it } from 'vitest';
import type { StoredTextRegionWorkspace } from '../lib/text-regions/workspace';
import { rebaseTextRegionWorkspace } from '../lib/text-regions/workspace';

function workspace(): StoredTextRegionWorkspace {
  return {
    baseJobId: 'job-parent',
    selectedSourceImageId: 'source-1',
    selectedRegionId: 'region-1',
    drafts: [
      [JSON.stringify(['source-1', 'region-1']), { sourceText: 'one', geometry: { x: 1, y: 2, width: 3, height: 4 } }],
      [JSON.stringify(['source-2', 'region-2']), { sourceText: 'two', geometry: { x: 5, y: 6, width: 7, height: 8 } }],
    ],
    createdDrafts: [
      ['created-1', { clientOperationId: 'created-1', sourceImageId: 'source-1', sourceText: 'new one', geometry: { x: 1, y: 1, width: 2, height: 2 } }],
      ['created-2', { clientOperationId: 'created-2', sourceImageId: 'source-2', sourceText: 'new two', geometry: { x: 3, y: 3, width: 4, height: 4 } }],
    ],
    deletedRegionKeys: [
      JSON.stringify(['source-1', 'deleted-1']),
      JSON.stringify(['source-2', 'deleted-2']),
    ],
    reviewDrafts: [
      ['source-1', { count: 0, baseRegionSetRevisionId: 'revision-1', regions: [] }],
      ['source-2', { count: 0, baseRegionSetRevisionId: 'revision-2', regions: [] }],
    ],
    activeReview: { jobId: 'review-1', sourceImageId: 'source-1', targets: [] },
    instructions: '',
    updatedAt: '2026-11-04T00:00:00.000Z',
  };
}

describe('text-region workspace rebasing', () => {
  it('drops submitted-page edits while preserving other page drafts for the new revision', () => {
    const next = rebaseTextRegionWorkspace(workspace(), 'job-child', ['source-1']);

    expect(next).toMatchObject({ baseJobId: 'job-child' });
    expect(next?.drafts).toHaveLength(1);
    expect(next?.drafts[0]?.[0]).toBe(JSON.stringify(['source-2', 'region-2']));
    expect(next?.createdDrafts.map(([, draft]) => draft.sourceImageId)).toEqual(['source-2']);
    expect(next?.deletedRegionKeys).toEqual([JSON.stringify(['source-2', 'deleted-2'])]);
    expect(next?.reviewDrafts.map(([sourceImageId]) => sourceImageId)).toEqual(['source-2']);
    expect(next?.activeReview).toBeUndefined();
  });

  it('removes an empty workspace after all submitted-page state is reconciled', () => {
    const onlyOnePage = workspace();
    onlyOnePage.drafts = onlyOnePage.drafts.slice(0, 1);
    onlyOnePage.createdDrafts = onlyOnePage.createdDrafts.slice(0, 1);
    onlyOnePage.deletedRegionKeys = onlyOnePage.deletedRegionKeys.slice(0, 1);
    onlyOnePage.reviewDrafts = onlyOnePage.reviewDrafts.slice(0, 1);

    expect(rebaseTextRegionWorkspace(onlyOnePage, 'job-child', ['source-1'])).toBeUndefined();
  });
});
