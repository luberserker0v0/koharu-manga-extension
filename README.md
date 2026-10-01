# Koharu Manga Companion

A WXT browser extension for the Manga Translation Backend. It talks only to the backend's versioned REST API and selected-job SSE stream. It does not call Koharu or AO and does not read Docker volumes or backend files.

## Current scope

- Quick Translation workflow with health and runtime readiness checks
- raw-byte image upload with per-batch progress and cancellation
- source preflight review and explicit page reordering
- `202 Accepted` job creation followed by SSE-first monitoring
- GET reconciliation, reconnection, and polling fallback
- persisted events, diagnostics, child-job failures, and artifact downloads
- explicit failed-job retry/resume with new Job ID tracking
- resumable local workflow identifiers (`uploadId`, `preflightId`, `jobId`)
- local chapter Job history and explicit retained-upload cleanup
- local file validation plus pre-upload natural ordering and correction
- configurable versioned API URL and optional Bearer token
- English and Traditional Chinese extension i18n
- per-site floating page translation with lazy-image scanning and review
- optional approved ComicCrawler adapters with safe generic DOM fallback
- ordered multi-image inline replacement through the backend `translated-images` API, with original-image restoration

The API and view models retain mode types for `reference_style`, `local_style`, and `learning_style`; only `quick` is exposed in the UI today.

## Prerequisites

### Manga Translation Backend (required)

Run [koharu-manga-agent](https://github.com/luberserker0v0/koharu-manga-agent) before using translation features. By default, the extension expects its browser REST API at:

```text
http://127.0.0.1:4001/api/v1
```

The backend must report a healthy `/health` response and a ready `/api/v1/runtime/status`. It owns all Koharu and AO communication, uploads, jobs, artifacts, and translated-image extraction. The extension never connects to Koharu or AO directly and never reads backend or Docker filesystem paths.

If the backend requires authentication, configure its optional Bearer token in the extension settings. A different backend URL can also be configured there.

### ComicCrawler (optional)

Run [ComicCrawler](https://github.com/luberserker0v0/comic-crawler) to use approved site adapters, canonical chapter recognition, and ordered chapter-image discovery. The default service URL is:

```text
http://127.0.0.1:4100
```

Enable ComicCrawler in the extension settings and configure Basic-auth credentials when required. The integration uses ComicCrawler's REST API, including `POST /api/adapters/chapter-images`; it never reads crawler output directories or executes adapter drafts. When ComicCrawler is disabled, unavailable, or has no matching adapter, the extension falls back to generic page image detection.

For extension development, install Node.js and npm. Chrome or Edge is required to load and test the MV3 build.

## Development

```sh
npm install
npm run dev
```

Production and verification commands:

```sh
npm run compile
npm test
npm run build
```

Load `.output/chrome-mv3` as an unpacked extension after a build. The default setting is `http://127.0.0.1:4001/api/v1`; change it in the extension settings when the backend is elsewhere. The backend must allow the installed extension origin through CORS.

## Releases

The `Release extension` GitHub Actions workflow verifies the project, packages Chrome and Edge ZIP files, generates `SHA256SUMS.txt`, and attaches all three files to a GitHub Release.

To publish the version declared in `package.json`, push its matching `v`-prefixed tag:

```sh
git tag -a v0.1.0 -m "Koharu Manga Companion v0.1.0"
git push origin v0.1.0
```

The workflow can also be started from **Actions → Release extension → Run workflow** with the matching tag. A release fails before publishing if the requested tag does not exactly match the `package.json` version.

## Architecture

- `lib/api`: typed transport, centralized errors, raw upload, SSE parsing/reconciliation
- `lib/domain`: job-state normalization and translation request construction
- `lib/storage`: protected extension-local settings and resumable workflow metadata
- `hooks`: workflow orchestration and live job monitoring
- `components`: focused feature UI
- `entrypoints`: thin WXT startup and composition files

See [docs/BACKEND_API.md](docs/BACKEND_API.md), [docs/COMIC_CRAWLER_API.md](docs/COMIC_CRAWLER_API.md), and [docs/IMMERSIVE_TRANSLATE_ANALYSIS.md](docs/IMMERSIVE_TRANSLATE_ANALYSIS.md) for the backend boundary, ComicCrawler integration contract, and page-translation design comparison.

Source uploads are intentionally not deleted when a translation finishes because post-edit and re-export workflows may still require them.
