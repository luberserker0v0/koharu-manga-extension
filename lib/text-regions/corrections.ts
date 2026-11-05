import type {
  TextRegion,
  TextRegionCreateOperation,
  TextRegionCorrectionGeometry,
  TextRegionOperation,
  TextRegionPage,
  TextRegionPageCorrection,
  TextRegionUpdateOperation,
} from '../api/types';

export interface TextRegionDraft {
  sourceText: string;
  geometry: TextRegionCorrectionGeometry;
}

export interface CreatedTextRegionDraft extends TextRegionDraft {
  sourceImageId: string;
  clientOperationId: string;
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

export function correctionFromDraft(region: TextRegion, draft: TextRegionDraft): TextRegionUpdateOperation | null {
  const sourceTextChanged = draft.sourceText !== region.sourceText;
  const changedGeometry = geometryChanged(region, draft.geometry);
  if (!sourceTextChanged && !changedGeometry) return null;
  if (sourceTextChanged && !draft.sourceText.trim()) throw new Error('text_region_source_text_required');
  return {
    type: 'update',
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
  createdDrafts: ReadonlyMap<string, CreatedTextRegionDraft> = new Map(),
  deletedRegionKeys: ReadonlySet<string> = new Set(),
): TextRegionPageCorrection[] {
  return pages.flatMap((page) => {
    const operations: TextRegionOperation[] = [];
    for (const region of page.regions) {
      const key = textRegionDraftKey(page.sourceImageId, region.id);
      if (deletedRegionKeys.has(key)) {
        operations.push({ type: 'delete', regionId: region.id });
        continue;
      }
      const draft = drafts.get(key);
      if (!draft) continue;
      validateTextRegionDraft(page, draft);
      const correction = correctionFromDraft(region, draft);
      if (correction) operations.push(correction);
    }
    for (const draft of createdDrafts.values()) {
      if (draft.sourceImageId !== page.sourceImageId) continue;
      validateTextRegionDraft(page, draft);
      if (!draft.sourceText.trim()) throw new Error('text_region_source_text_required');
      operations.push({
        type: 'create',
        clientOperationId: draft.clientOperationId,
        sourceText: draft.sourceText,
        geometry: { ...draft.geometry },
      } satisfies TextRegionCreateOperation);
    }
    return operations.length ? [{
      sourceImageId: page.sourceImageId,
      baseRegionSetRevisionId: page.regionSetRevisionId,
      operations,
    }] : [];
  });
}
