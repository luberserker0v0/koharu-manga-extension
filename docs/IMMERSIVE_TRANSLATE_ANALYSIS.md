# Immersive Translate image and manga workflow analysis

Immersive Translate provides two relevant interaction models: translating an individual image from its context/hover UI and translating a supported manga page from a floating page action. Its documented manga workflow detects images, applies OCR and translation, removes source text, renders translated text, and replaces the page presentation inline.

The distributed extension also injects page-side image instrumentation for readers that render through canvas. In particular, it wraps image/canvas creation and drawing paths so the extension can retain source URLs and crop information that would otherwise disappear inside a canvas. That is a powerful compatibility technique, but it requires broad page instrumentation and is intentionally outside this project's first version.

Official references:

- [Image translation](https://immersivetranslate.com/docs/features/image/)
- [Manga translation](https://immersivetranslate.com/docs/features/manga/)

## Koharu Manga Companion design

This extension adopts the useful product pattern—a discoverable floating action, user review, and inline replacement where mapping is certain—while preserving a narrower trust boundary:

- Site access is optional and granted per origin instead of declaring blanket host access.
- Approved ComicCrawler REST adapters are preferred over extension-bundled site scraping rules.
- The generic detector handles loaded HTML `<img>` elements, `<picture>` sources, shadow-DOM images, video posters, CSS background images, and canvas snapshots through bounded lazy-page scrolling; PDFs and browser-internal pages remain unsupported.
- Single- and multi-image results can be applied inline through the backend's ordered `translated-images` API; the extension never guesses from ZIP order or filenames.
- Koharu, AO, backend files, ComicCrawler files, and Docker volumes are never accessed directly.
