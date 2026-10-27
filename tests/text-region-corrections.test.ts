import { describe, expect, it } from 'vitest';
import type { TextRegionPage } from '../lib/api/types';
import {
  buildTextRegionPageCorrections,
  draftFromRegion,
  textRegionDraftKey,
} from '../lib/text-regions/corrections';

function page(sourceImageId: string, regionSetRevisionId: string, regionId: string): TextRegionPage {
  return {
    sourceImageId,
    sourceOrderIndex: sourceImageId === 'source-1' ? 0 : 1,
    sourceFileName: `${sourceImageId}.png`,
    pageRevisionId: `revision-${sourceImageId}`,
    regionSetRevisionId,
    coordinateSpace: {
      kind: 'source_image_pixels', origin: 'top_left', width: 1000, height: 1500,
      rotationUnit: 'degrees_clockwise',
    },
    regions: [{
      id: regionId, readingOrder: 0,
      geometry: { x: 100, y: 150, width: 300, height: 90, rotation: 0 },
      sourceText: 'inter\ngalactic', translatedText: '星際',
    }],
  };
}

describe('text-region correction drafts', () => {
  it('batches only changed fields across multiple pages and preserves OCR whitespace', () => {
    const pages = [page('source-1', 'set-1', 'region-1'), page('source-2', 'set-2', 'region-2')];
    const first = draftFromRegion(pages[0]!.regions[0]!);
    first.sourceText = 'intergalactic\nEmpire';
    const second = draftFromRegion(pages[1]!.regions[0]!);
    second.geometry = { ...second.geometry, x: 120, width: 320 };
    const drafts = new Map([
      [textRegionDraftKey('source-1', 'region-1'), first],
      [textRegionDraftKey('source-2', 'region-2'), second],
    ]);

    expect(buildTextRegionPageCorrections(pages, drafts)).toEqual([
      {
        sourceImageId: 'source-1', baseRegionSetRevisionId: 'set-1',
        regions: [{ regionId: 'region-1', sourceText: 'intergalactic\nEmpire' }],
      },
      {
        sourceImageId: 'source-2', baseRegionSetRevisionId: 'set-2',
        regions: [{ regionId: 'region-2', geometry: { x: 120, y: 150, width: 320, height: 90, rotation: 0 } }],
      },
    ]);
  });

  it('omits unchanged drafts', () => {
    const pages = [page('source-1', 'set-1', 'region-1')];
    const drafts = new Map([[textRegionDraftKey('source-1', 'region-1'), draftFromRegion(pages[0]!.regions[0]!)]]);
    expect(buildTextRegionPageCorrections(pages, drafts)).toEqual([]);
  });

  it('rejects empty OCR overrides and out-of-bounds geometry before submission', () => {
    const pages = [page('source-1', 'set-1', 'region-1')];
    const empty = draftFromRegion(pages[0]!.regions[0]!);
    empty.sourceText = '';
    expect(() => buildTextRegionPageCorrections(pages, new Map([
      [textRegionDraftKey('source-1', 'region-1'), empty],
    ]))).toThrowError('text_region_source_text_required');

    const outside = draftFromRegion(pages[0]!.regions[0]!);
    outside.geometry = { ...outside.geometry, x: 900, width: 200 };
    expect(() => buildTextRegionPageCorrections(pages, new Map([
      [textRegionDraftKey('source-1', 'region-1'), outside],
    ]))).toThrowError('text_region_geometry_out_of_bounds');
  });
});
