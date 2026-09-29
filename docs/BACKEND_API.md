# Manga Translation Backend browser contract

Reviewed against backend commit `36af9f9431ff4c5bfa4f4ad4904c88a530d28031`.

The backend owns the export destination and generates it beneath its configured `paths.translated` root. Browser clients must not send `outputDir`, store backend paths, or attempt to open exported files directly.

Koharu Manga Companion sends the minimal browser-safe Translation Job payload with `translationMode`, language and export choices, publication identifiers, and `sourcePreflightId`. It discovers results through the Job Artifact API and downloads bytes only through the artifact content endpoint.

The optional legacy `outputDir` override remains for trusted desktop integrations and is intentionally absent from this extension.
