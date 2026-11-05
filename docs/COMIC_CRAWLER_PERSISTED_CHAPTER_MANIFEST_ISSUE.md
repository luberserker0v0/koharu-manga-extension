## Problem

`POST /api/adapters/chapter-images` is an extraction operation. For a dynamic
reader it may acquire an existing Browser Client tab, run reader preparation,
scroll the page, and return only after the complete ordered image list is ready.
This behavior is appropriate when the user explicitly starts a new whole-chapter
crawl or translation.

It is not appropriate when a browser extension is applying an already completed
translation. Re-running extraction moves the user's page, delays reading, and
couples translated-image replacement to a full reader-preparation operation.
Adding `batch_size` to the extraction operation would not solve that problem: the
Browser Client would still control the tab in order to produce each batch.

The extension instead needs a persisted, read-only source manifest from an
earlier successful extraction. It can then observe images as the user naturally
scrolls and replace only the images that have loaded.

## Requested API capability

Persist the successful result of `POST /api/adapters/chapter-images`, scoped by
the authenticated owner, and expose a read-only lookup API. One possible shape:

```http
GET /api/chapter-image-manifests/resolve?url={chapterUrl}
GET /api/chapter-image-manifests/{chapterId}
```

A successful response should contain:

```json
{
  "data": {
    "adapterId": "comix",
    "chapter": {
      "id": "chapter_opaque",
      "canonicalUrl": "https://reader.example/chapter/1",
      "stability": "deterministic",
      "identitySource": "adapter"
    },
    "revision": "opaque-manifest-revision",
    "capturedAt": "2026-10-29T00:00:00.000Z",
    "images": [
      {
        "id": "page_opaque",
        "orderIndex": 0,
        "url": "https://cdn.example/page-001.jpg",
        "sourceKey": "opaque-stable-source-key",
        "sourceFingerprint": "etag:optional"
      }
    ]
  }
}
```

`sourceKey` may be another explicitly documented stable matching field. The
extension must be able to associate a currently loaded image URL with the
persisted page ID without executing an adapter or reproducing ComicCrawler's
private identity algorithm.

If raw CDN URLs can expire or rotate, also provide a pure identity-resolution
operation such as:

```http
POST /api/chapter-image-manifests/{chapterId}/resolve-pages
```

```json
{
  "urls": ["https://cdn.example/page-001.jpg?token=renewed"]
}
```

This operation may normalize and match URLs, but it must not create a Browser
session, navigate, scroll, run reader preparation, or execute an adapter.

## Required behavior

- A manifest lookup is read-only and never acquires a Browser Worker or lease.
- A manifest lookup never navigates, focuses, scrolls, or otherwise mutates a
  registered Browser Client resource.
- A missing manifest returns an explicit `404`/not-found result. It must not
  silently fall back to live extraction.
- Results preserve deterministic opaque chapter/page IDs and current page order.
- Persisted records retain adapter ID, canonical chapter URL, capture time,
  optional source fingerprints, and a manifest revision or ETag.
- Existing Basic/authenticated API ownership and configurable CORS behavior are
  preserved.
- The existing `POST /api/adapters/chapter-images` contract remains unchanged and
  continues to return a complete, non-truncated extraction result.
- Filesystem paths, Browser Client handles, tab IDs, and internal storage paths
  are never exposed.

## Extension workflow enabled by this API

1. Resolve the current chapter URL to a persisted manifest.
2. Read the completed translation's page-ID/source-image mapping.
3. Observe the live page with `MutationObserver`, image `load` events, and
   `IntersectionObserver`.
4. When one source image appears, match it to its persisted page ID.
5. Download only that translated image from the Manga Translation Backend.
6. Replace it immediately and prefetch only a small number of nearby images.

The extension controls download concurrency (for example, two or three images
at a time). ComicCrawler does not scroll the page during this workflow.

## Acceptance criteria

- After one successful chapter-images extraction, a manifest can be retrieved
  after Server restart without a connected Browser Client.
- Looking up the manifest produces no Browser Client commands.
- Looking up an unknown chapter returns not found and does not start extraction.
- Signed URL renewal or CDN host rotation can be resolved to the same stable page
  ID when the adapter identity strategy considers the source unchanged.
- Reordered, inserted, removed, and fingerprint-changed pages retain the identity
  guarantees documented for the existing chapter-images API.
- Integration tests assert that manifest lookup does not call Browser Render
  Service, Browser session scheduling, reader preparation, or adapter execution.

## Non-goals

- Streaming image bytes from ComicCrawler.
- Managing translated images or translation versions in ComicCrawler.
- Automatically starting extraction when no persisted manifest exists.
- Using `batch_size` to split Browser Client scrolling into user-visible batches.

