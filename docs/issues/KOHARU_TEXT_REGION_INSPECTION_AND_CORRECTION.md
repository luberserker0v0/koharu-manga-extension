# Expose translation text-region inspection and correction APIs for browser clients

## Problem

A completed manga Translation Job may look wrong even when the rendered image
was produced successfully. One common failure starts before translation: OCR
may preserve a visual line break inside an English word, for example
`inter\ngalactic`. A weaker translator can interpret those fragments as two
tokens and produce a poor translation.

Koharu Manga Companion needs to help the user identify whether the problem came
from text detection, OCR, or translation. The extension should be able to:

1. draw the text-detection regions over the translated page;
2. show the exact OCR source text and translated text for each region;
3. later let the user correct a region's geometry and OCR text;
4. submit one or more corrected pages as a new Translation Job;
5. compare and activate the resulting page revisions through the existing
   revision workflow.

The current versioned REST API exposes rendered translated images and page
revision lineage, but it does not expose the text nodes used to create those
images. `POST /api/v1/jobs/{parentJobId}/retranslations` accepts complete
`sourceImageIds`; it cannot accept corrected text regions or OCR overrides.

The backend already reads Koharu scene text nodes internally. Translation
quality processing normalizes each node into an ID, page identity, source text,
translated text, and a rectangular transform (`x`, `y`, `width`, `height`).
Those backend-owned records should be exposed through a stable, sanitized REST
contract rather than requiring the extension to call Koharu or read project
files.

This is a follow-up to #1. That issue intentionally excluded bubble-level text
editing.

## Ownership boundary

This capability belongs to `koharu-manga-agent`, not ComicCrawler:

- ComicCrawler identifies the chapter and source page and returns the source
  image bytes.
- `koharu-manga-agent` creates and retains the Translation Job, Koharu project,
  detected text nodes, OCR output, translated text, rendered images, and page
  revisions.
- The browser extension consumes only versioned REST APIs from each service.

ComicCrawler must not store translation text or translation revision history.
The extension must not call Koharu directly or inspect backend/Docker paths.

## Phase 1: read-only text-region inspection

Add a versioned REST endpoint that returns the exact text-region snapshot used
by a Translation Job or page revision. One possible route is:

```http
GET /api/v1/jobs/{jobId}/text-regions
```

Illustrative response:

```json
{
  "jobId": "job-translation-2",
  "rootJobId": "job-original",
  "pages": [
    {
      "sourceImageId": "source-image-3",
      "sourceOrderIndex": 2,
      "pageRevisionId": "page_revision_abc123",
      "regionSetRevisionId": "region_set_abc123",
      "coordinateSpace": {
        "kind": "source_image_pixels",
        "width": 1600,
        "height": 2400
      },
      "regions": [
        {
          "id": "text_region_opaque_id",
          "readingOrder": 4,
          "geometry": {
            "x": 618,
            "y": 391,
            "width": 244,
            "height": 96,
            "rotation": 0
          },
          "sourceText": "inter\ngalactic",
          "translatedText": "星際",
          "ocrConfidence": 0.81
        }
      ]
    }
  ]
}
```

The exact route and names may follow existing conventions, but the contract
needs these semantics:

- `sourceImageId` is the authoritative source-preflight identity.
- Region IDs and region-set revision IDs are opaque and stable for that
  immutable snapshot.
- Coordinates declare their image dimensions and origin so a browser client
  can scale them over a responsive `<img>` without guessing.
- Preserve OCR whitespace and line breaks exactly; do not silently normalize
  the text returned for inspection.
- Return translated text from the same snapshot when available.
- Optional OCR confidence, polygon, rotation, text direction, or language may
  be returned only when the underlying data exists.
- Pages and regions retain chapter order and reading order.
- Legacy Jobs without a retained scene return an explicit unavailable response,
  not an empty result that could be mistaken for "no text detected".
- No field exposes a Koharu project path, backend path, Docker volume, or
  provider credential.

This phase is sufficient for the extension to provide two independent toggles:

1. show/hide detection boxes;
2. show/hide the OCR and translated text associated with each box.

The client can render the overlay over either the source or translated image by
scaling from the declared coordinate space.

## Phase 2: correct regions and create a new translation revision

Add a Job-creating endpoint for user-reviewed region corrections. One possible
contract is:

```http
POST /api/v1/jobs/{parentJobId}/text-region-corrections
Content-Type: application/json
```

```json
{
  "pages": [
    {
      "sourceImageId": "source-image-3",
      "baseRegionSetRevisionId": "region_set_abc123",
      "regions": [
        {
          "regionId": "text_region_opaque_id",
          "geometry": {
            "x": 606,
            "y": 382,
            "width": 270,
            "height": 112,
            "rotation": 0
          },
          "sourceText": "intergalactic"
        }
      ]
    }
  ],
  "instructions": "Keep Intergalactic Empire as one term."
}
```

The request should support multiple regions and multiple pages in one batch.
Omitted translation target and language settings should inherit from the parent
Job as they do for selective retranslation.

The backend should:

1. validate the parent/root lineage, retained source data, source page, region
   IDs, coordinate bounds, text limits, and caller access;
2. reject stale edits when `baseRegionSetRevisionId` is no longer current;
3. preserve the correction as immutable audit history instead of mutating the
   original Job or scene snapshot;
4. create a normal queued Job and return `202 Accepted`;
5. reuse the existing SSE, GET reconciliation, event, error, diagnostic, and
   cancellation behavior;
6. use corrected geometry for affected cleaning/inpainting/rendering and use
   corrected `sourceText` as the OCR override for translation;
7. rerun only the necessary affected pages and stages without claiming that an
   unsupported override was applied;
8. create inactive page revisions on success, compatible with the existing
   page-revision activation API;
9. leave the current active translation unchanged on queued, waiting, failed,
   blocked, or canceled jobs;
10. never retry a failed correction Job automatically.

Suggested lineage metadata:

```json
{
  "revision": {
    "rootJobId": "job-original",
    "parentJobId": "job-translation-2",
    "reason": "text_region_correction",
    "sourceImageIds": ["source-image-3"],
    "baseRegionSetRevisionIds": ["region_set_abc123"]
  }
}
```

Future additions may support creating, deleting, merging, splitting, or
reordering text regions. Updating existing geometry and OCR text is sufficient
for the first editable version, provided the contract can evolve without
changing region identity semantics.

## Errors and compatibility

Use stable machine-readable error codes for at least:

- text-region snapshot unavailable;
- source upload/preflight unavailable;
- unknown source page or region;
- stale region-set revision;
- invalid or out-of-bounds geometry;
- invalid OCR text;
- unsupported correction for the selected pipeline/provider;
- project or source data no longer retained.

The read endpoint should work for both initial Translation Jobs and selective
retranslation Jobs. A correction Job should participate in the same root page
revision family introduced by #1.

## Acceptance criteria

### Phase 1

- [ ] A versioned REST endpoint returns per-page text regions for a completed
      Translation Job or page revision.
- [ ] Every page maps to an authoritative `sourceImageId` and chapter order.
- [ ] Every region has an opaque ID, reading order, geometry, exact OCR source
      text, and translated text when available.
- [ ] Coordinate-space width, height, origin, and rotation semantics are
      documented and test-covered.
- [ ] OCR whitespace and line breaks are preserved.
- [ ] Legacy/unavailable snapshots return an explicit actionable state.
- [ ] Responses contain no filesystem paths, Docker paths, secrets, or raw
      Koharu-internal handles.
- [ ] `docs/API.md`, `docs/REST_WORKFLOW.md`, and OpenAPI are updated.

### Phase 2

- [ ] A versioned REST endpoint accepts corrected OCR text and/or geometry for
      one or more regions across one or more pages.
- [ ] The request uses optimistic concurrency through an immutable base
      region-set revision or equivalent token.
- [ ] The response is `202 Accepted` with a normal queued Job.
- [ ] Omitted translation settings inherit from the selected parent Job.
- [ ] Corrected OCR text is used for translation and corrected geometry is used
      for downstream affected image stages.
- [ ] The original Job and region snapshot remain immutable and inspectable.
- [ ] Successful output becomes an inactive page revision and can be activated
      or rolled back through the existing API.
- [ ] Batch correction of multiple regions/pages is supported by one Job.
- [ ] Waiting and terminal Job semantics remain unchanged, with no automatic
      retry or activation.
- [ ] Unit tests cover wrapped-word OCR correction, coordinate validation,
      stale edits, batch edits, inheritance, and immutable history.
- [ ] Integration tests cover correcting multiple regions, monitoring the Job,
      reading the new snapshot/output, and activating only the chosen pages.

## Non-goals

- Adding OCR or translation state to ComicCrawler.
- Calling Koharu or AO directly from the browser extension.
- Exposing or accepting backend filesystem paths.
- Mutating completed Job history or deleting older page/region revisions.
- Automatically accepting corrected output without user review.
- Replacing the existing page-level selective retranslation workflow.

