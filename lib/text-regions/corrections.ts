import type {
  TextRegion,
  TextRegionCorrection,
  TextRegionCorrectionGeometry,
  TextRegionPage,
  TextRegionPageCorrection,
} from '../api/types';

export interface TextRegionDraft {
  sourceText: string;
  geometry: TextRegionCorrectionGeometry;
}

export function textRegionDraftKey(sourceImageId: string, regionId: string): string {
  return JSON.stringify([sourceImageId, regionId]);
}

export function draftFromRegion(region: TextRegion): TextRegionDraft {
  return {
    sourceText: region.sourceText,
    geometry: { ...region.geometry },
  };
}

function geometryChanged(region: TextRegion, geometry: TextRegionCorrectionGeometry): boolean {
  return geometry.x !== region.geometry.x
    || geometry.y !== region.geometry.y
    || geometry.width !== region.geometry.width
    || geometry.height !== region.geometry.height
    || (geometry.rotation ?? 0) !== region.geometry.rotation;
}

export function correctionFromDraft(region: TextRegion, draft: TextRegionDraft): TextRegionCorrection | null {
  const sourceTextChanged = draft.sourceText !== region.sourceText;
  const changedGeometry = geometryChanged(region, draft.geometry);
  if (!sourceTextChanged && !changedGeometry) return null;
  if (sourceTextChanged && !draft.sourceText.length) throw new Error('text_region_source_text_required');
  return {
    regionId: region.id,
    ...(sourceTextChanged ? { sourceText: draft.sourceText } : {}),
    ...(changedGeometry ? { geometry: { ...draft.geometry } } : {}),
  };
}

export function validateTextRegionDraft(page: TextRegionPage, draft: TextRegionDraft): void {
  const { x, y, width, height, rotation = 0 } = draft.geometry;
  if (![x, y, width, height, rotation].every(Number.isFinite)) throw new Error('text_region_geometry_invalid');
  if (x < 0 || y < 0 || width <= 0 || height <= 0) throw new Error('text_region_geometry_invalid');
  if (x + width > page.coordinateSpace.width || y + height > page.coordinateSpace.height) {
    throw new Error('text_region_geometry_out_of_bounds');
  }
}

export function buildTextRegionPageCorrections(
  pages: TextRegionPage[],
  drafts: ReadonlyMap<string, TextRegionDraft>,
): TextRegionPageCorrection[] {
  return pages.flatMap((page) => {
    const regions = page.regions.flatMap((region) => {
      const draft = drafts.get(textRegionDraftKey(page.sourceImageId, region.id));
      if (!draft) return [];
      validateTextRegionDraft(page, draft);
      const correction = correctionFromDraft(region, draft);
      return correction ? [correction] : [];
    });
    return regions.length ? [{
      sourceImageId: page.sourceImageId,
      baseRegionSetRevisionId: page.regionSetRevisionId,
      regions,
    }] : [];
  });
}
