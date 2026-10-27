# Manga Translation Backend browser contract

Reviewed against backend release `v0.3.0`, commit `9ec19a409211cfe89cf8ea0e7db8e683f7a6b367`.

The backend owns the export destination and generates it beneath its configured `paths.translated` root. Browser clients must not send `outputDir`, store backend paths, or attempt to open exported files directly.

Koharu Manga Companion sends the minimal browser-safe Translation Job payload with `translationMode`, language and export choices, publication identifiers, and `sourcePreflightId`. It discovers results through the Job Artifact API and downloads bytes only through the artifact content endpoint.

No client sends `outputDir`. Desktop output-folder settings are local download destinations and are never part of a Job request.

Source preflight copies accepted images into backend-owned durable storage and releases the consumed upload session. `DELETE /uploads/{uploadId}` is only for abandoning a session before preflight; completed Translation Jobs retain `preflightId` and source-image identities instead of a live upload session.

## Selective page retranslation

The extension uses the backend's persisted source-image and revision identities; it never infers page identity from ZIP order or output filenames.

- `POST /jobs/{parentJobId}/retranslations` queues a new job for selected `sourceImageIds`. Omitted provider, model, and language fields inherit from the parent job. Optional correction instructions are sent only when the user enters them.
- `GET /jobs/{rootJobId}/page-revisions` returns every source page, immutable translation revisions, and the currently active revision.
- `POST /jobs/{rootJobId}/page-revisions/activate` remains available for administrative recovery and rollback.
- Revision image bytes are read through the producing job's `/translated-images/{imageId}/content` endpoint.

A successful selective job automatically promotes its page revisions, rebuilds the complete chapter export, and replaces the active publication. The extension refreshes the active manifest and reapplies it to the current page; it does not issue a second activation request. Failed, blocked, or canceled jobs leave the active chapter unchanged and are never retried automatically.

## Text-region inspection and correction

- `GET /jobs/{jobId}/text-regions` returns immutable OCR and translated text regions in a declared source-image-pixel coordinate space. `sourceImageId`, `pageRevisionId`, opaque region IDs, and `regionSetRevisionId` are authoritative.
- `POST /jobs/{parentJobId}/text-region-corrections` queues a normal Translation Job for one or more OCR-text or geometry corrections. Each page uses `baseRegionSetRevisionId` for optimistic concurrency.
- Successful correction Jobs automatically promote their pages and rebuild the complete chapter export. The existing Job GET, SSE, event, diagnostic, cancellation, and artifact workflows remain authoritative.
- `409 text_region_snapshot_unavailable` and `409 text_region_coordinate_space_unavailable` are explicit unavailable states, not empty OCR results.

The extension editor preserves OCR whitespace, allows direct box movement/resizing plus exact numeric
coordinate editing, and batches changed regions from multiple pages of the inspected immutable snapshot
into one request. It validates non-empty corrected text and source-image bounds before submission. A
`409 stale_region_set_revision` response is never retried automatically; the user is prompted to reload
the latest snapshot and review the edits again.

## Runtime checks and progress

`GET /health` is liveness only. Before creating work, the extension checks `GET /api/v1/ready` and then reads `GET /api/v1/runtime/status` for diagnostics. Pipeline progress follows `progressSemanticsVersion: 2`: `currentPageIndex` is one-based, `completedPages` excludes the active page, and the backend emits a terminal progress event before Export.
