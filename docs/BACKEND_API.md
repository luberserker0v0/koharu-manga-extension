# Manga Translation Backend browser contract

Reviewed against the local backend OpenAPI `0.8.0` working tree and updated Docker container on
2026-11-03. The backend changes are newer than the current `9ec19a4` Git commit.

The backend owns the export destination and generates it beneath its configured `paths.translated` root. Browser clients must not send `outputDir`, store backend paths, or attempt to open exported files directly.

Koharu Manga Companion sends the minimal browser-safe Translation Job payload with `translationMode`, language and export choices, publication identifiers, and `sourcePreflightId`. It discovers results through the Job Artifact API and downloads bytes only through the artifact content endpoint.

`sourceLanguage` is sent as an ordered BCP 47 array. The first entry is primary and later entries are
secondary language context. An empty selection omits the field and requests automatic OCR policy.
Legacy stored workflows containing one string are normalized into a one-item list. The backend uses
the complete list for OCR-engine selection and the primary language for Translation Memory,
Observation, and Quality. Current Koharu does not accept OCR language hints, so the backend exposes
the effective policy through `ocr.language_resolution` events and `result.ocrLanguageResolution`.

No client sends `outputDir`. Desktop output-folder settings are local download destinations and are never part of a Job request.

Source preflight copies accepted images into backend-owned durable storage and releases the consumed upload session. `DELETE /uploads/{uploadId}` is only for abandoning a session before preflight; completed Translation Jobs retain `preflightId` and source-image identities instead of a live upload session.

## Selective page retranslation

The extension uses the backend's persisted source-image and revision identities; it never infers page identity from ZIP order or output filenames.

- `POST /jobs/{parentJobId}/retranslations` queues a new job for selected `sourceImageIds`. Omitted provider, model, and language fields inherit from the parent job. Optional correction instructions are sent only when the user enters them.
- `GET /jobs/{rootJobId}/page-revisions` returns every source page, immutable translation revisions, and the currently active revision.
- `POST /jobs/{rootJobId}/page-revisions/activate` remains available for administrative recovery and rollback.
- Revision image bytes are read through the producing job's `/translated-images/{imageId}/content` endpoint.

A successful selective job automatically promotes its page revisions, rebuilds the complete chapter export, and replaces the active publication. The extension refreshes the active manifest and reapplies it to the current page; it does not issue a second activation request. Failed, blocked, or canceled jobs leave the active chapter unchanged and are never retried automatically.

### Persistent background revision queue

Selective retranslations, text-region corrections, and OCR review requests are recorded in the
chapter's extension-local workflow before the user continues editing. The extension monitors every
nonterminal entry with the same SSE-first Job monitor and GET reconciliation used for the main Job.
Because the actual Job is owned by the backend, it continues when the popup, tab, browser, or phone UI
is closed. Reopening the same chapter reloads the saved queue and reconciles the authoritative state.

The current successful chapter Job remains inspectable while child Jobs are queued or running. Pages
with an outstanding mutation Job are locked against another correction so that their optimistic
`regionSetRevisionId` cannot silently become stale; other pages remain editable and can be submitted.
When a mutation Job succeeds, it becomes the current composed chapter revision, submitted-page drafts
are discarded, and drafts for other pages are rebased onto the new Job. OCR review Jobs never replace
the current translated Job. Failed, blocked, and canceled entries remain visible with their diagnostics
until the user removes them, and the extension does not retry them automatically.

## Text-region inspection and correction

- `GET /jobs/{jobId}/text-regions` returns immutable OCR and translated text regions in a declared source-image-pixel coordinate space. `sourceImageId`, `pageRevisionId`, opaque region IDs, and `regionSetRevisionId` are authoritative.
- `POST /jobs/{parentJobId}/text-region-corrections` queues a normal Translation Job containing explicit
  `create`, `update`, and `delete` operations. Each page uses `baseRegionSetRevisionId` for optimistic concurrency.
- Successful correction Jobs automatically promote their pages and rebuild the complete chapter export. The existing Job GET, SSE, event, diagnostic, cancellation, and artifact workflows remain authoritative.
- Correction Jobs inherit the nearest non-correction ancestor's actual detection and OCR bootstrap engines so opaque text-region mapping remains stable, including for legacy Jobs without `ocrLanguageResolution` and correction chains that previously drifted engines.
- A correction Job's text-region response composes its own revised pages with inherited parent page revisions; unchanged pages must not fail merely because the child Job did not regenerate them.
- Region numbers shown by the extension are page-local display positions (`1..n`); backend `readingOrder`
  remains opaque ordering metadata and is not assumed to start at zero in historical snapshots.
- When a newly submitted correction succeeds, the extension restores the original page DOM just before
  resolving ComicCrawler page identities and applies the new composed translated-image set automatically.
  This permits replacing a prior inline revision without a browser refresh.
- `409 text_region_snapshot_unavailable` and `409 text_region_coordinate_space_unavailable` are explicit unavailable states, not empty OCR results.

The extension editor preserves OCR whitespace, lets the user draw missing boxes, mark false positives
for deletion, move/resize retained boxes, and edit exact numeric coordinates. It batches all operations
from multiple pages of the inspected immutable snapshot into one request. New boxes use a client-only
operation ID; the backend remains responsible for opaque region and upstream node identities. The client
validates non-empty new/corrected text and source-image bounds before submission. A
`409 stale_region_set_revision` response is never retried automatically; the user is prompted to reload
the latest snapshot and review the edits again.

### Vision-assisted OCR review

- The extension crops each existing OCR region from the original image. It creates an
  `ocr_review` upload, sends every PNG crop as raw bytes through the existing upload API, completes
  the upload, then calls `POST /jobs/ocr-text-review` with `uploadId`, ordered source-language hints,
  and one `{clientItemId, fileName, ocrText}` entry per crop. The backend contract retains optional
  neighboring-context fields for compatibility, but the extension deliberately omits them so one
  region's unreliable OCR cannot contaminate another region's suggestion.
- Small crops are enlarged with high-quality browser canvas resampling to at least a 512-pixel long
  edge and 256-pixel short edge, capped at 1536 pixels, before PNG upload. This does not invent source
  detail but prevents very small text crops from being undersampled by a vision model.
- The request contains no box coordinates. The backend invokes the vision model independently for
  each crop, using only the current crop and its OCR as a noisy hint.
  The model returns only corrected source text; the backend wraps that assistant message as
  `correctedText`. It cannot change geometry or identity.
- The API returns a normal `202 Accepted` `ocr_text_review` Job. The extension uses the standard
  SSE-first monitor, GET reconciliation, polling fallback, cancellation endpoint, and persisted events.
  It maps results back through `clientItemId`; individual failures are shown and never retried automatically.
- OCR text correction uses LM Studio's native `/api/v1/chat` image input and its supported `reasoning`
  setting (normally `off`). It never sends the ineffective OpenAI-compatible `reasoning_effort` field.
  The backend wraps the native assistant text into `correctedText`, avoiding reasoning and structured-
  output overhead for a short transcription task.
- The extension keeps the result as a page-scoped local draft and overlays the current effective
  boxes on the original image. Effective boxes include existing regions after local move/resize edits
  and newly created regions, even when a new region has no OCR hint yet.
- Adopting AI suggestions performs no backend mutation and creates no Translation Job. It copies only
  suggested strings into the same local text-region draft used by manual create, update, delete, move,
  and resize operations. The user can continue editing and submits the combined operation batch once
  through `POST /jobs/{parentJobId}/text-region-corrections`.
- A failed per-item review is visibly marked as failed. Its retained original OCR is not presented or
  adopted as an AI suggestion; successful items in the same result can still be adopted.
- `POST /jobs/{jobId}/text-region-reviews/apply` remains a backend compatibility surface, but the
  extension does not call it because immediate application would split one editing session into
  multiple correction Jobs.
- The older synchronous `POST /jobs/{jobId}/text-region-reviews` route remains a backend compatibility
  surface, but the extension no longer uses it.
- A page without backend OCR boxes can use AI text correction after the user draws at least one local
  region. Empty new regions send an empty `ocrText` hint; populated new regions send their draft text.
- AI review may be started after manual edits. Results are correlated by `clientItemId`, and adoption
  fills successful suggested text into the matching existing or created draft while preserving all
  local geometry and deletion decisions.

### Whole-chapter AI OCR correction

After a Translation Job succeeds, the live Job tab offers a whole-chapter quality action. The
extension loads the immutable text-region snapshot, obtains each source page through the existing
page/ComicCrawler REST-backed source mapping, crops every untouched OCR region, and creates normal
`ocr_text_review` Jobs. A page with more than 500 eligible regions is split at the backend request
limit. User-edited text is authoritative and is not sent back through automatic AI correction;
geometry edits, created regions, and deletions remain part of the final correction draft.

Every AI Job and its opaque item-to-page mapping is stored in the chapter workflow before monitoring.
Closing the popup, tab, browser, or mobile UI therefore does not lose the orchestration state. On the
next open, the extension reattaches to nonterminal Jobs through SSE/GET reconciliation. Successful AI
items are adopted, failed items retain their OCR text, and all adopted plus manual edits are combined
into one `POST /jobs/{parentJobId}/text-region-corrections` request with multiple `pages[]`. The
resulting correction Job is monitored as one background batch and is never automatically retried.
Canceling the whole-chapter action aborts local crop/upload preparation and requests cancellation for
every already-created AI or correction Job.

The UI accounts for chapter pages explicitly: it reports `OCR pages / total source pages`, pages that
were retranslated, pages whose successful AI suggestions exactly matched the original OCR, and pages
that could not be retranslated because every useful correction failed. Page numbers are listed for
the latter categories. A page with some failed regions and at least one adopted correction is reported
separately as a partial AI failure while still counting as retranslated; region failures and page
outcomes are never presented as the same metric.

## Runtime checks and progress

`GET /health` is liveness only. Before creating work, the extension checks `GET /api/v1/ready`, requires
`capabilities.mangaProcessingJobs`, then reads `GET /api/v1/runtime/status` and its `mangaProcessor`
service for diagnostics. Translation providers are read from the provider-neutral
`GET /api/v1/runtime/manga-processor/translation-providers` route. Pipeline progress follows
`progressSemanticsVersion: 2`: `currentPageIndex` is one-based, `completedPages` excludes the active page,
and the backend emits a terminal progress event before Export.
