# ComicCrawler chapter-image API

Reviewed against local ComicCrawler commit `d9c47481d743032041a1ed8a336e44dd02c500b9`
(tree-equivalent to GitHub `main` commit `56f595c4759f974b8cdfac1a5fc4d7e4938bad57`).
This contract includes Browser-target recovery, stable chapter/page identities,
the chapter-image verification handoff, and persisted passive manifests.

The earlier API gap is resolved. ComicCrawler now provides one production endpoint that returns every image URL from a chapter in reading order:

```http
POST /api/adapters/chapter-images
Content-Type: application/json

{
  "url": "https://reader.example/manga/title/chapter-1",
  "browserTarget": {
    "mode": "existing-tab",
    "workerId": "bw_server_assigned_id",
    "resourceId": "brr_sdk_generated_id"
  },
  "renderContext": {
    "viewport": { "width": 390, "height": 844 },
    "deviceScaleFactor": 3
  }
}
```

Successful response:

```json
{
  "data": {
    "adapterId": "site-adapter",
    "chapterUrl": "https://reader.example/manga/title/chapter-1",
    "chapter": {
      "id": "chapter_opaque_id",
      "canonicalUrl": "https://reader.example/manga/title/chapter-1",
      "stability": "deterministic",
      "identitySource": "normalized-url"
    },
    "imageUrlCount": 2,
    "imageUrls": [
      "https://cdn.example/001.jpg",
      "https://cdn.example/002.jpg"
    ],
    "images": [
      {
        "id": "page_opaque_id_1",
        "orderIndex": 0,
        "url": "https://cdn.example/001.jpg",
        "sourceFingerprint": "etag:optional-revision"
      },
      {
        "id": "page_opaque_id_2",
        "orderIndex": 1,
        "url": "https://cdn.example/002.jpg"
      }
    ],
    "domSource": "dynamic",
    "durationMs": 42
  }
}
```

`imageUrls` is ordered and untruncated, and `imageUrlCount` must equal both
`imageUrls.length` and `images.length`. The extension persists opaque
`chapter.id` and `images[].id` values, never parses them, and uses
`orderIndex` only as presentation order. A changed optional
`sourceFingerprint` prevents an older translation from being applied silently
to updated source content. The extension requests optional access to the
returned image origins, downloads those URLs in the extension background
context, and uploads the bytes to the Manga Translation Backend.

For Playwright adapters, the extension calls this endpoint only when the
Browser Client is connected and the same current tab has been explicitly
registered. It supplies the opaque `browserTarget` plus the page's CSS viewport
and device scale factor. Without that approved target it immediately uses DOM
detection instead of waiting for ComicCrawler's global Worker-acquisition
timeout.

The extension never reads ComicCrawler output folders or preview paths. If no approved adapter matches, the user may explicitly queue Agent discovery and continue immediately with generic page `<img>` detection. AO-generated adapters still require review in ComicCrawler WebUI.

## Persisted passive chapter manifests

A complete successful chapter-image extraction atomically saves the latest
owner-scoped manifest. Applying an existing translation uses only these passive
routes:

```http
GET /api/chapter-image-manifests/resolve?url={chapterUrl}&adapterId={optionalAdapterId}
GET /api/chapter-image-manifests/{chapterId}
POST /api/chapter-image-manifests/{chapterId}/resolve-pages
```

The extension sends naturally observed, loaded image URLs to `resolve-pages` in
batches of at most 500 and uses the returned opaque `pageId` values. It does not
reproduce ComicCrawler's URL identity algorithm. `matched`, `not_found`, and
`ambiguous` are handled explicitly; ambiguous candidates remain pending until
enough matching DOM images have loaded. The stored manifest revision is sent as
an optimistic guard, and HTTP `409` stops replacement rather than risking a
stale translation.

Manifest reads never resolve an Adapter, acquire a Browser Client, navigate,
scroll, or retry extraction. The extension downloads translated bytes only from
the Manga Translation Backend after a page ID has been matched.

## Existing-tab verification handoff

If the chapter page requires human verification, ComicCrawler returns HTTP
`409` with code `CHAPTER_IMAGES_VERIFICATION_REQUIRED`. The extension preserves
the returned `data.challenge`, including its opaque ID and exact Browser target,
and monitors `/api/challenge-discovery/{id}` in the background. It does not
create a second handoff.

After the challenge becomes inspectable, the extension calls
`POST /api/challenge-discovery/{id}/complete-human-verification` with
`settle: true` and `allowNavigate: false`. When ComicCrawler reports `ready`,
the extension automatically retries the original chapter-image request with:

```json
{
  "url": "https://reader.example/manga/title/chapter-1",
  "browserTarget": {
    "mode": "existing-tab",
    "workerId": "bw_server_assigned_id",
    "resourceId": "brr_sdk_generated_id"
  },
  "challengeDiscoveryId": "challenge-discovery-opaque-id"
}
```

The pending handoff is retained across extension background restarts. Failed or
cancelled handoffs are terminal; a later user request may start a new one.

When ComicCrawler integration is enabled, the extension first checks the current page with:

```http
POST /api/adapters/resolve

{
  "url": "https://reader.example/manga/title/chapter-1",
  "mode": "chapters"
}
```

For `not_found` or `capability_mismatch`, the extension offers an explicit adapter-generation action. The only currently exposed feature is `specific_chapters`, mapped to ComicCrawler's `chapters` mode, and the current page is the only chapter submitted:

```http
POST /api/tasks

{
  "url": "https://reader.example/manga/title/chapter-1",
  "mode": "chapters",
  "chapterUrls": ["https://reader.example/manga/title/chapter-1"]
}
```

The extension never queues this request without user confirmation and never promotes the resulting draft.

## Existing-tab Browser Client tasks

The extension also supports explicit crawler tasks against the user's approved tab.
The SDK registers the local tab and returns an opaque `resourceId`. Task creation
uses the REST contract from ComicCrawler v0.5.0:

```http
POST /api/tasks

{
  "url": "https://reader.example/manga/title/chapter-1",
  "mode": "chapters",
  "chapterUrls": ["https://reader.example/manga/title/chapter-1"],
  "browserTarget": {
    "mode": "existing-tab",
    "workerId": "bw_server_assigned_id",
    "resourceId": "brr_sdk_generated_id"
  }
}
```

The extension never sends the native browser tab ID. Browser Client enrollment,
WebSocket discovery, command handling, and resource registration are delegated to
`@comiccrawler/browser-client-sdk@0.5.0`.

### Recovering a process-scoped Browser target

When the original Browser Worker/resource is lost, the extension first asks the
user to open and approve the task's target (or active handoff) URL. It registers
a new resource and then calls:

```http
POST /api/tasks/{taskId}/rebind-browser-target

{
  "expectedBrowserTarget": {
    "mode": "existing-tab",
    "workerId": "bw_old",
    "resourceId": "brr_old"
  },
  "browserTarget": {
    "mode": "existing-tab",
    "workerId": "bw_new",
    "resourceId": "brr_new"
  }
}
```

The action is available only for ComicCrawler's documented recoverable states.
The old target is an optimistic concurrency guard; the Server remains
authoritative for ownership, URL, Worker availability, resource, capability,
and state validation. The extension never sends a native tab ID and never
performs this replacement from automatic background maintenance.
