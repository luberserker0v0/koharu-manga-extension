# Return stable chapter and page identities from `chapter-images`

Published as [ComicCrawler issue #5](https://github.com/luberserker0v0/comic-crawler/issues/5)
and implemented by ComicCrawler commit
`6d5a02100e6aa357852292b2232724a9605159a7` (merged in `b05b7fa1814d822d346fb7bf4a98d24eabe7fca0`).

### Problem

`POST /api/adapters/chapter-images` currently returns the resolved `chapterUrl`
and an ordered `imageUrls` array.

This is sufficient for downloading a chapter once, but it does not let a
downstream browser extension reliably recognize the same logical page across
multiple extractions.

For example, a translation client may need to:

- retranslate only pages 3 and 7;
- keep multiple translation revisions for one source page;
- restore the active translation after the reader is refreshed;
- detect that the source page changed after a chapter was updated;
- avoid applying an older translation to a different page after insertion or
  reordering.

Array position alone is not a stable identity. Image URLs are also unsuitable
as identifiers because a reader may return signed CDN URLs, rotate hosts,
change query parameters, or generate a new URL for the same logical page.

ComicCrawler is the component that resolves the site adapter and understands
the ordered source chapter. It should expose stable source identities, while
translation jobs and translation revision history remain the responsibility of
downstream translation services.

### Current response

```json
{
  "data": {
    "adapterId": "comix",
    "chapterUrl": "https://reader.example/title/example/chapter-1",
    "imageUrlCount": 2,
    "imageUrls": [
      "https://cdn.example/signed/page-1.jpg?token=...",
      "https://cdn.example/signed/page-2.jpg?token=..."
    ],
    "domSource": "dynamic",
    "durationMs": 1234,
    "renderContext": {
      "viewport": { "width": 390, "height": 844 },
      "deviceScaleFactor": 3
    }
  }
}
```

The caller can preserve the order for that response, but it cannot determine
whether an image returned in a later response is the same logical page.

### Proposed response addition

Add opaque chapter metadata and ordered page descriptors to the response:

```json
{
  "data": {
    "adapterId": "comix",
    "chapterUrl": "https://reader.example/title/example/chapter-1",
    "chapter": {
      "id": "chapter_opaque_stable_id",
      "canonicalUrl": "https://reader.example/title/example/chapter-1"
    },
    "imageUrlCount": 2,
    "imageUrls": [
      "https://cdn.example/signed/page-1.jpg?token=...",
      "https://cdn.example/signed/page-2.jpg?token=..."
    ],
    "images": [
      {
        "id": "page_opaque_stable_id_1",
        "orderIndex": 0,
        "url": "https://cdn.example/signed/page-1.jpg?token=...",
        "sourceFingerprint": "sha256:optional-source-fingerprint"
      },
      {
        "id": "page_opaque_stable_id_2",
        "orderIndex": 1,
        "url": "https://cdn.example/signed/page-2.jpg?token=...",
        "sourceFingerprint": "sha256:optional-source-fingerprint"
      }
    ],
    "domSource": "dynamic",
    "durationMs": 1234,
    "renderContext": {
      "viewport": { "width": 390, "height": 844 },
      "deviceScaleFactor": 3
    }
  }
}
```

The names are illustrative. The exact contract may use `chapterId`, `imageId`,
or another naming convention consistent with ComicCrawler.

### Identity semantics

The API should document the following guarantees:

1. A chapter ID is scoped to an adapter and identifies the same logical
   chapter across repeated extraction requests.
2. A page ID is scoped to that chapter and identifies the same logical source
   page across repeated extraction requests.
3. Signed query parameters and CDN host rotation alone do not change a page ID
   when the adapter can recognize the same underlying page.
4. Inserting or reordering pages changes `orderIndex`, not the IDs of unaffected
   pages.
5. A genuinely replaced source page either receives a new page ID or retains
   its ID with a changed `sourceFingerprint`; the chosen behavior must be
   documented.
6. IDs are opaque. Clients must not parse them or reconstruct storage paths
   from them.
7. Identity is deterministic across ComicCrawler restarts, or the response
   explicitly reports a weaker stability scope.

Adapters may use a site-provided chapter/page key when one exists. For sites
without stable keys, ComicCrawler may derive an opaque identity from normalized
adapter-owned source information. A content hash is useful but should not be
required if producing it would force an additional image download solely for
this endpoint.

`sourceFingerprint` may therefore be optional. When present, it should describe
whether it is a content hash, ETag-derived value, or another opaque revision
token.

### Backward compatibility

- Keep `chapterUrl`, `imageUrlCount`, and `imageUrls` during a documented
  compatibility period.
- `images.map(image => image.url)` must have the same order and values as
  `imageUrls`.
- Existing callers that ignore `chapter` and `images` must continue to work.
- New clients should use opaque IDs for identity and URLs only for content
  retrieval.

### Why this belongs in ComicCrawler

Only ComicCrawler knows which adapter matched, how a site identifies a chapter,
and how the ordered chapter image list was derived. A browser extension can
observe DOM elements and URLs, but any identity it invents would be
site-specific, unstable, and likely to duplicate adapter logic.

This request does not make ComicCrawler responsible for translation. It only
provides stable source identities that downstream systems can reference.

### Expected extension workflow

1. The extension requests chapter images.
2. It stores the opaque chapter and page IDs with its translation workspace.
3. The user selects one or more unsatisfactory pages.
4. The translation backend creates a new translation revision for those source
   pages.
5. The extension applies the active translated revision by matching the stable
   source page ID instead of guessing from filenames or ZIP order.
6. On a later extraction, a changed fingerprint warns the user before an older
   translation is applied to updated source content.

### Acceptance criteria

- [ ] `POST /api/adapters/chapter-images` returns an opaque stable chapter ID.
- [ ] Every returned chapter image has an opaque stable page ID.
- [ ] Every image descriptor contains an explicit zero-based `orderIndex`.
- [ ] The descriptor contains the current retrievable image URL.
- [ ] Repeated extraction of an unchanged chapter returns the same chapter and
      page IDs.
- [ ] Signed URL renewal alone does not change stable IDs when the adapter can
      identify the same underlying source.
- [ ] Reordering pages preserves IDs and updates only their order where
      possible.
- [ ] Source replacement behavior is documented and test-covered.
- [ ] Optional source fingerprint semantics and stability are documented.
- [ ] IDs never expose server filesystem paths or Browser Client local handles.
- [ ] Existing `imageUrls` clients remain compatible during the migration.
- [ ] Shared API types, OpenAPI, and `docs/API.md` are updated.
- [ ] Unit tests cover unchanged, reordered, inserted, removed, URL-rotated,
      and source-replaced pages.
- [ ] An integration test covers a Dynamic/Playwright adapter across two
      extraction requests.

### Non-goals

- Translating manga images in ComicCrawler.
- Storing translated images or translation-provider credentials.
- Managing translation Jobs or translation revision history.
- Selecting which translation revision is active.
- Exposing browser-native tab IDs, local filesystem paths, or crawler output
  directories.
- Requiring ComicCrawler to download every image only to calculate a content
  hash.
- Removing the existing `imageUrls` field without a compatibility period.

