# Add selective page retranslation and translation revision management

> Implemented upstream in `koharu-manga-agent` commit
> `2c2a829bb38095d29fc5790262c0038ae1d82275`. The extension integration uses
> the delivered REST contract documented in `docs/API.md` and
> `docs/openapi.yaml`; the proposal below is retained as the issue record.

### Problem

A completed manga Translation Job may contain several pages whose translations
the user wants to improve. The current REST API supports:

- creating a Translation Job from a complete source preflight;
- retrying the complete previous Job payload;
- re-exporting from the retained preflight;
- reading the ordered translated-image manifest.

`POST /api/v1/jobs/{jobId}/retry` reruns the complete payload. It cannot select
only pages 3 and 7, and the translated-image manifest does not identify the
source preflight image represented by each output.

A browser extension therefore cannot safely provide page-level correction,
comparison, rollback, or active-version restoration without duplicating source
uploads and maintaining the complete revision graph only in extension-local
storage.

The backend already retains source uploads and preflight records for post-edit
and re-export workflows. It should be able to create a new Job for selected
source images while preserving immutable linkage to the original translation.

### Proposed workflow

1. The client creates and completes a normal Translation Job.
2. The user selects one or more unsatisfactory source pages.
3. The client submits those source preflight image IDs to a selective
   retranslation endpoint.
4. The backend creates a new queued Job and returns `202 Accepted`.
5. The client monitors it through the existing Job GET, SSE, events, and
   artifact APIs.
6. On success, the client compares the new page revisions with the currently
   active revisions.
7. The user explicitly activates the preferred revisions.
8. Older revisions remain available for rollback and audit.

Creating a successful retranslation must not silently overwrite or delete the
currently active translation.

### Proposed selective retranslation endpoint

One possible contract is:

```http
POST /api/v1/jobs/{jobId}/retranslations
Content-Type: application/json
```

```json
{
  "sourceImageIds": ["source-image-3", "source-image-7"],
  "translationTarget": {
    "providerId": "openai",
    "modelId": "gpt-5"
  },
  "targetLanguage": "zh-TW",
  "sourceLanguage": "ja",
  "instructions": "Keep the character name Koharu untranslated."
}
```

Only `sourceImageIds` needs to be required. Omitted translation settings should
inherit from the source Job. The exact endpoint name and override fields may
follow existing backend conventions.

The backend should validate that:

1. The source Job is a Translation Job with a retained source preflight.
2. Every selected ID belongs to that exact preflight.
3. Every selected image is accepted and still available.
4. IDs are unique and non-empty.
5. The source upload was not deleted.
6. The selected translation provider/model and languages are currently valid.
7. The source Job and any root revision lineage are visible to the authenticated
   caller.

A missing upload or preflight should return an actionable `409 Conflict`, not a
filesystem path or an attempt to reconstruct source files client-side.

### Job response and lineage

Return the normal Job resource with explicit immutable lineage metadata:

```json
{
  "id": "job-retranslation-2",
  "status": "queued",
  "kind": "translation",
  "revision": {
    "rootJobId": "job-original",
    "parentJobId": "job-original",
    "reason": "selective_retranslation",
    "sourceImageIds": ["source-image-3", "source-image-7"]
  }
}
```

`rootJobId` keeps the chapter revision family stable. `parentJobId` records the
specific version from which settings were inherited. Repeated retranslation of
one page creates another immutable Job rather than modifying earlier Job
payloads, diagnostics, events, or artifacts.

The new Job uses all existing lifecycle rules:

- `202 Accepted` means queued, not completed;
- SSE remains the primary live-update mechanism;
- GET reconciliation and polling fallback remain supported;
- waiting states are not failures;
- terminal states remain `succeeded`, `failed`, `canceled`, and `blocked`;
- failed retranslations are never retried automatically.

### Source-to-output mapping

Extend each entry returned by:

```http
GET /api/v1/jobs/{jobId}/translated-images
```

with its source identity and revision metadata:

```json
{
  "id": "translated-image-revision-2",
  "index": 0,
  "sourceImageId": "source-image-3",
  "sourceOrderIndex": 2,
  "revisionId": "revision-3-2",
  "revisionNumber": 2,
  "active": false,
  "fileName": "page-003.png",
  "mediaType": "image/png",
  "contentUrl": "/api/v1/jobs/job-retranslation-2/translated-images/translated-image-revision-2/content"
}
```

Clients must be able to associate output with source by `sourceImageId`; they
must not have to guess using ZIP order or filenames. `index` remains the order
inside that Job's selected subset.

### Read and activate revisions

Expose a backend-owned view of every source page and its immutable translation
revisions. One possible endpoint is:

```http
GET /api/v1/jobs/{rootJobId}/page-revisions
```

The response should contain:

- source preflight image ID and original chapter order;
- every succeeded translated-image revision;
- producing Job ID;
- provider/model and language settings;
- optional user instruction summary;
- creation time;
- the currently active revision ID.

Activation should be explicit and atomic:

```http
POST /api/v1/jobs/{rootJobId}/page-revisions/activate
Content-Type: application/json
```

```json
{
  "selections": [
    {
      "sourceImageId": "source-image-3",
      "revisionId": "revision-3-2"
    },
    {
      "sourceImageId": "source-image-7",
      "revisionId": "revision-7-3"
    }
  ]
}
```

The operation should either activate every requested selection or none of them.
It should reject revisions from a different root Job or source image. Repeating
the same activation should be idempotent.

The active-revision response gives browser clients one authoritative manifest
to restore after a page reload without deleting historical output.

### Instructions

An optional per-retranslation `instructions` field would allow corrections such
as terminology, character names, honorifics, or tone. If the selected Koharu
provider/workflow cannot consume instructions, the backend should reject the
field clearly or report that it was not applied. It must not silently claim
that unsupported instructions affected the output.

Instructions are not credentials and should be preserved with revision
metadata for audit and comparison. Provider credentials remain backend-owned
and must never appear in Job responses.

### ComicCrawler identity boundary

ComicCrawler now returns deterministic opaque chapter/page IDs from
`POST /api/adapters/chapter-images`. A browser extension may map those IDs to
backend `sourceImageId` values when it creates the original upload.

The manga translation backend should remain independent of ComicCrawler. Its
authoritative source identity is the preflight `sourceImageId`; optional client
metadata may preserve an external page ID, but the backend must not call
ComicCrawler or depend on crawler URLs.

### Failure and retention behavior

- A failed, blocked, or canceled selective Job creates no active revision.
- Successful revisions remain inactive until explicitly activated.
- Existing active revisions continue to render while a new Job is queued,
  waiting, or failed.
- Deleting a source upload disables future retranslations but does not erase
  existing Job diagnostics or translated artifacts outside their documented
  retention policy.
- Artifact and translated-image content remains accessible only through the
  REST content endpoints.
- No response exposes backend or Docker filesystem paths.

### Acceptance criteria

- [ ] A versioned REST endpoint creates a Translation Job for selected source
      preflight image IDs.
- [ ] The response is `202 Accepted` with a normal queued Job resource.
- [ ] Omitted settings inherit from the selected parent Job.
- [ ] Provider/model/language overrides are validated before Job creation.
- [ ] The new Job records immutable root, parent, reason, and source-image
      lineage.
- [ ] Only selected source images are translated and exported.
- [ ] `translated-images` maps every output to a `sourceImageId`.
- [ ] Multiple revisions for the same source image are preserved.
- [ ] Creating a revision does not automatically replace the active revision.
- [ ] A REST endpoint lists every page revision and the active selection.
- [ ] An atomic, idempotent REST operation activates selected revisions.
- [ ] Failed, blocked, and canceled retranslations do not change active state.
- [ ] Existing Job SSE, polling, events, diagnostics, child Jobs, and artifacts
      work without a separate monitoring protocol.
- [ ] Missing/deleted source data returns an actionable API error without
      leaking filesystem paths.
- [ ] No automatic retry is introduced.
- [ ] OpenAPI, `docs/API.md`, and `docs/REST_WORKFLOW.md` are updated.
- [ ] Unit tests cover subset validation, inheritance, lineage, revision
      numbering, activation, rollback, and cross-job rejection.
- [ ] Integration tests cover retranslating two pages from a multi-page Job and
      activating only the new successful revisions.

### Non-goals

- Calling ComicCrawler, Koharu, or AO directly from the browser extension.
- Making the backend depend on ComicCrawler chapter/page IDs.
- Mutating an existing Job payload, event history, diagnostics, or artifact.
- Guessing source/output mapping from filenames or ZIP order.
- Automatically activating a failed or incomplete revision.
- Automatically retrying a failed selective Job.
- Deleting older revisions when a newer revision succeeds.
- Exposing backend filesystem or Docker volume paths.
- Implementing bubble-level text editing or manual inpainting in this change.

