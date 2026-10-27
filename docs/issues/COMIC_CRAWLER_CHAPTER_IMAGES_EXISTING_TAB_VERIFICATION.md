# Resolved: `chapter-images` existing-tab verification handoff

Published as [ComicCrawler issue #7](https://github.com/luberserker0v0/comic-crawler/issues/7).

Resolved upstream by ComicCrawler PR #8 at commit
`d471ada1a44f8aa01bebdcb6a23cd2bacad52881`. Koharu Manga Companion now
implements the documented 409 handoff, background reconciliation, and same-ID
automatic retry flow.

## Summary

`POST /api/adapters/chapter-images` can correctly report that a rendered chapter
needs human verification, but a request that already supplied an
`existing-tab` Browser target currently creates a challenge-discovery record
without retaining that target. The new challenge can remain `queued` even while
the original Browser Worker is online and idle, so a browser-extension client
cannot complete verification in the same tab and automatically retry chapter
image extraction.

The Comix adapter may also be classifying a normally rendered reader page as a
challenge page when its HTML contains a Cloudflare challenge-platform script.
The handoff problem is reproducible independently of whether that classification
is ultimately confirmed as a false positive.

## Environment

- ComicCrawler commit: `b05b7fa1814d822d346fb7bf4a98d24eabe7fca0`
- Server version: `0.2.0`
- Adapter: `comix`
- Execution mode: `existing-tab`
- Client: Koharu Manga Companion Browser Client SDK integration
- Chapter URL:
  `https://comix.to/title/nl58n-im-the-evil-lord-of-an-intergalactic-empire/11212633-chapter-51.1`

## Reproduction

1. Open the chapter in a normal browser tab.
2. Connect an `existing-tab` Browser Client and register that tab.
3. Confirm that the Server reports the Worker online and idle.
4. Call `POST /api/adapters/chapter-images` with the chapter URL and the
   registered `browserTarget`:

   ```json
   {
     "url": "https://comix.to/title/nl58n-im-the-evil-lord-of-an-intergalactic-empire/11212633-chapter-51.1",
     "browserTarget": {
       "mode": "existing-tab",
       "workerId": "bw_...",
       "resourceId": "brr_..."
     },
     "renderContext": {
       "viewport": { "width": 1920, "height": 1080 },
       "deviceScaleFactor": 1
     }
   }
   ```

5. Observe the `409` verification-required response and its
   `challengeDiscoveryId`.
6. Read that challenge through `GET /api/challenge-discovery/{id}`.

## Observed result

During the latest reproduction, ComicCrawler created:

```text
challengeDiscoveryId: chal-1792415878645-nd6sk6
status: queued
target URL: the requested Comix chapter
browserTarget: absent
```

At the same time, `GET /api/browser-workers` reported the Koharu Manga
Companion Worker online and idle. The challenge did not retain the
`existing-tab` target passed to `chapter-images`, so it had no actionable route
back to the already approved tab.

The Server implementation currently creates the handoff through
`createDeferred({ url })` in the adapter-function runner. The request's
`browserTarget` is used for the extraction session but is not passed into the
created challenge-discovery job.

The Comix verification matcher also treats any rendered HTML containing
`cdn-cgi/challenge-platform` as verification-required. If Comix includes that
script on a normally rendered reader page, the endpoint can return a false
positive even when `.rpage-main` and the chapter images are available.

## Expected result

When `chapter-images` detects verification while using an `existing-tab`
target, ComicCrawler should preserve a resumable relationship to that exact
target:

1. The challenge record retains the requesting `browserTarget`, owner, and
   normalized target URL.
2. The user can complete verification in the same approved tab.
3. The challenge transitions through explicit states and eventually reaches
   `ready`, `failed`, or `cancelled`; it does not remain indefinitely `queued`
   while the selected Worker is online and idle.
4. Retrying `POST /api/adapters/chapter-images` with the returned
   `challengeDiscoveryId` and the same target continues extraction without
   creating unrelated handoff records.
5. The response provides a stable machine-readable error code and structured
   challenge state so clients do not need to classify human-readable error
   text.

If the current tab already contains a usable reader DOM, normal Cloudflare
script references alone should not classify it as a challenge page.

## Suggested implementation direction

- Propagate the validated `browserTarget` (or an equivalent leased-session
  handoff reference) from the `chapter-images` route into
  `createVerificationRequiredResponse` and `ChallengeDiscoveryService`.
- Reuse the same Browser Client resource for the human-verification handoff
  instead of creating an unbound deferred job.
- Include a stable response code such as
  `CHAPTER_IMAGES_VERIFICATION_REQUIRED`, plus:
  `challengeDiscoveryId`, `challengeStatus`, `retryableAfterVerification`, and
  the retained target mode.
- Prefer positive challenge-page evidence over the presence of a globally
  loaded Cloudflare script. For Comix, reader DOM such as `.rpage-main` with
  loaded `.rpage-page` nodes should outweigh a passive
  `cdn-cgi/challenge-platform` reference.

## Acceptance criteria

- [x] An `existing-tab` `chapter-images` challenge retains the exact selected
      Browser target.
- [x] A queued challenge starts or becomes actionable without requiring a
      separate crawl task.
- [x] Completing verification in the same tab allows the client to retry the
      same chapter-image request successfully.
- [x] A retry with the same `challengeDiscoveryId` is idempotent and does not
      create duplicate handoffs.
- [x] The 409 response exposes a documented machine-readable code and complete
      challenge metadata.
- [x] Normal rendered Comix reader HTML containing passive Cloudflare scripts
      does not produce a false verification-required result.
- [x] Tests cover real challenge HTML, normal reader HTML with Cloudflare
      scripts, target retention, ready-state retry, timeout/failure, and
      cancellation.

## Client follow-up

Koharu Manga Companion preserves the structured `challengeDiscoveryId`,
polls/reconciles its actual state, and automatically retries `chapter-images`
once it reaches `ready`. It classifies the documented stable error code instead
of inferring verification state from human-readable text.
