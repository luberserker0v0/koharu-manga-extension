# Backend API gap resolved

Backend commit `36af9f9431ff4c5bfa4f4ad4904c88a530d28031` made export locations server-owned. Browser clients now omit `outputDir`, so the earlier filesystem-path contract gap is resolved.

See [BACKEND_API.md](BACKEND_API.md) for the current browser contract.

## Multi-image inline replacement

Resolved by backend commit `2ad44111e7b78e65d07d2117f0c7cbfe868a97d6`.
The extension lists ordered rendered pages through
`GET /api/v1/jobs/{jobId}/translated-images` and fetches each page only through
its versioned binary content endpoint. ZIP extraction and backend cache paths
remain backend-owned. Replacement is aborted when counts or indexes are invalid.
