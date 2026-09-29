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
- single-image inline replacement with original-image restoration

The API and view models retain mode types for `reference_style`, `local_style`, and `learning_style`; only `quick` is exposed in the UI today.

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

## Architecture

- `lib/api`: typed transport, centralized errors, raw upload, SSE parsing/reconciliation
- `lib/domain`: job-state normalization and translation request construction
- `lib/storage`: protected extension-local settings and resumable workflow metadata
- `hooks`: workflow orchestration and live job monitoring
- `components`: focused feature UI
- `entrypoints`: thin WXT startup and composition files

See [docs/BACKEND_API.md](docs/BACKEND_API.md), [docs/COMIC_CRAWLER_API.md](docs/COMIC_CRAWLER_API.md), and [docs/IMMERSIVE_TRANSLATE_ANALYSIS.md](docs/IMMERSIVE_TRANSLATE_ANALYSIS.md) for the backend boundary, ComicCrawler integration contract, and page-translation design comparison.

Source uploads are intentionally not deleted when a translation finishes because post-edit and re-export workflows may still require them.
