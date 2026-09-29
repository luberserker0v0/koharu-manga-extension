# ComicCrawler chapter-image API

Reviewed against ComicCrawler commit `afa9a1a8a8fc29dfd8c34dad9d1388156971d110`.

The earlier API gap is resolved. ComicCrawler now provides one production endpoint that returns every image URL from a chapter in reading order:

```http
POST /api/adapters/chapter-images
Content-Type: application/json

{
  "url": "https://reader.example/manga/title/chapter-1"
}
```

Successful response:

```json
{
  "data": {
    "adapterId": "site-adapter",
    "chapterUrl": "https://reader.example/manga/title/chapter-1",
    "imageUrlCount": 2,
    "imageUrls": [
      "https://cdn.example/001.jpg",
      "https://cdn.example/002.jpg"
    ],
    "domSource": "dynamic",
    "durationMs": 42
  }
}
```

`imageUrls` is ordered and untruncated, and `imageUrlCount` must equal its length. The extension requests optional access to the returned image origins, downloads those URLs in the extension background context, and uploads the bytes to the Manga Translation Backend.

The extension never reads ComicCrawler output folders or preview paths. If no approved adapter matches, the user may explicitly queue Agent discovery and continue immediately with generic page `<img>` detection. AO-generated adapters still require review in ComicCrawler WebUI.

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
