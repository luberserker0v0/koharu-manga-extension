# ComicCrawler v0.2.0 Extension Integration Report

## Environment

- Browser: Google Chrome `155.0.8059.84` with a disposable profile and the unpacked Chrome MV3 production build.
- Extension manifest version: 3.
- Node version: `v24.14.1`.
- ComicCrawler version: `0.2.0`; Browser Client discovery protocol version: `2`.
- SDK version: `@comiccrawler/browser-client-sdk@0.2.0` from the GitHub Release artifact.

## Implemented

The initial acceptance build exposed Browser Client diagnostic controls in the
popup. The current UI keeps those transport operations in the background:
opening the popup or starting translation automatically enrolls, connects, and
registers the active tab. The popup now exposes only settings and translation
work, and opening it no longer starts `chapter-images` or scroll-through content
preparation.

- Installed the release SDK without copying SDK source or protocol types.
- Used `ExistingTabExecutor` with the SDK `WebExtensionTabDriver`.
- Added an opaque `ChromeClientStateStore` backed by protected `storage.local`.
- Added enroll, automatic reconnect, connect, disconnect, and credential clearing.
- Kept the SDK outbound WebSocket in the MV3 background service worker.
- Added explicit current-tab approval and SDK resource registration.
- Kept native tab IDs local to the extension.
- Invalidated resources after tab close or URL change.
- Added task creation with the current `workerId`, opaque `resourceId`, page URL, and chapter mode.
- Added adapter preflight and explicit confirmation before an unmatched page may queue Agent discovery.
- Added task polling, progress, waiting-verification, continue, cancel, and local clear actions.
- Added human-verification focus through the documented ComicCrawler handoff endpoint.
- Added user-token REST authentication while preserving existing Basic-auth support.
- Redacted backend and ComicCrawler credentials from content-script settings.
- Added narrow-popup responsive rules for Edge mobile.
- Preserved existing ComicCrawler adapter detection and generic page fallback.
- Made Browser Client status wait for startup auto-reconnect, preventing a stale disconnected popup after service-worker restart.
- Added a background task coordinator and 30-second maintenance alarm. It
  reconnects dropped Browser Clients, reconciles persisted task state, checks an
  opened challenge handoff, and resumes the same task after the handoff becomes
  `ready`.
- Added duplicate-resume protection and explicit recovery diagnostics. The
  extension does not silently recreate a crawl when its process-scoped Worker
  or approved resource has changed.
- Integrated ComicCrawler's task recovery endpoint. A user can explicitly bind
  a recoverable saved task to a freshly approved current-tab resource while the
  old target is supplied as an optimistic concurrency check. Background
  maintenance never performs this rebind automatically.
- Declared Chrome 116 as the minimum Chromium version because active WebSocket
  traffic only extends MV3 service-worker lifetime from Chrome 116 onward.

## Tests

- Command: `npm run compile`.
- Result: passed.
- Command: `npm test`.
- Result: 18 files and 110 tests passed.
- Command: `npm run build`.
- Result: Chrome MV3 production build passed.
- Command: `npm run build:edge`.
- Result: Edge MV3 production build passed.
- SDK contract: `runBrowserExecutorContract()` passed for the WebExtension existing-tab executor.
- Security check: `npm audit --omit=dev` reports zero vulnerabilities.

## Realtime Result

- Enrollment: passed from the real extension popup against `http://127.0.0.1:4100` in public mode.
- WebSocket connection: passed; ComicCrawler assigned Worker ID `bw_fd46c4eb-f107-4e50-93c1-6b9a74681d8b` for the first process.
- Resource registration: passed for the user-approved Comix tab with opaque Resource ID `brr_95e74d8c-ea55-4c89-9aca-4105ea65d106`.
- Task creation: passed; task `task-1792315653864-1foltm` contained the same Worker ID, Resource ID, and target URL.
- Rendered DOM: ComicCrawler operated the approved existing tab and detected its human-verification state. Full adapter extraction did not proceed beyond that state.
- Chapter image URLs: not produced because Comix entered `waiting_verification`. The test did not bypass Cloudflare. The other installed adapter test domains did not resolve from this environment.
- Handoff: passed; **Focus verification tab** returned to the same approved tab.
  The page already showed normal manga content. Selecting **Continue** caused
  ComicCrawler to snapshot it, change the handoff to `ready`, and put the same
  task back in `pending`. CAPTCHA was not automated.
- Automatic handoff behavior: the extension now performs the same readiness
  check from its background coordinator. Popup polling checks approximately
  every 2 seconds; the maintenance alarm checks at least every 30 seconds when
  the popup is closed, subject to browser alarm scheduling.
- Popup lifecycle: after the popup was closed for more than 40 seconds, the Worker remained online and its heartbeat advanced.
- Service-worker restart: passed after a UI race fix. The old Worker became offline, SDK state reconnected automatically, and a new process-scoped Worker ID appeared in the popup.
- Task cancellation: passed; the task became `cancelled` and the Worker returned to `idle`.
- Cleanup: the test challenge was deleted, the local task was cleared, logout removed SDK state/resource data, and the final Worker disconnected.

## ComicCrawler follow-up

- The task-recovery gap reported in [ComicCrawler issue #3](https://github.com/luberserker0v0/comic-crawler/issues/3)
  was resolved at ComicCrawler commit `e720ccda0dbe8be621a066fe1b5222a7c58f2ce2`
  by the `POST /api/tasks/{taskId}/rebind-browser-target` API. The extension now
  uses it only from the explicit **Recover with current tab** action.
- One Comix run reported `Browser command "page.prepare-content" timed out`
  even though direct inspection showed normal chapter content. The handoff
  could still be opened and completed afterward.
- The earlier `/api/status` version mismatch is resolved; it now reports `0.2.0`.

## Extension Issues

- Fixed during acceptance: the popup could read Browser Client state before startup reconnect completed and incorrectly show **enrolled, disconnected** while the Server already had an online Worker.
- A resource from an earlier process was not retained after the forced browser
  restart. The extension now reports that condition and requires **Use current
  tab** again instead of silently retrying against a different resource.
- Long browser sleep, operating-system suspension, and multi-hour heartbeat behavior remain outside this bounded acceptance run.

## Open Questions

- Should ComicCrawler expose a stable task-event stream so the popup can avoid polling task detail?
- A manual Comix verification pass is still required to confirm the final ordered chapter-image URL list on that target.
