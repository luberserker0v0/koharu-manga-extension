# ComicCrawler API gap resolved

ComicCrawler commit `afa9a1a8a8fc29dfd8c34dad9d1388156971d110` added `POST /api/adapters/chapter-images`, which returns every chapter image URL in order without truncation. There is no remaining chapter-image discovery API gap.

See [COMIC_CRAWLER_API.md](COMIC_CRAWLER_API.md) for the extension integration contract.
