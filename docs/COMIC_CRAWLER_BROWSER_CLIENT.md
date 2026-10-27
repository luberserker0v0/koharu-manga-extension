# ComicCrawler Browser Client v0.2.0

The extension uses the published `@comiccrawler/browser-client-sdk` package in
`existing-tab` mode. It does not implement the Browser Client protocol itself.

## Install the SDK

1. Run:

   ```sh
   npm install https://github.com/luberserker0v0/comic-crawler/releases/download/v0.2.0/comiccrawler-browser-client-sdk-0.2.0.tgz
   ```

2. Do not copy SDK source or protocol types into the extension.
3. Do not add Playwright to the extension.

## Start ComicCrawler

1. Start ComicCrawler v0.2.0.
2. Confirm `http://127.0.0.1:4100/api/status` responds.
3. Confirm `http://127.0.0.1:4100/.well-known/comiccrawler-browser-client` responds.
4. Enable API CORS for the installed extension origin when required.
5. Use HTTPS/WSS when ComicCrawler runs on another device.

## Configure the extension

1. Open the extension popup.
2. Open **Backend settings**.
3. Enable **Use ComicCrawler adapters**.
4. Enter the ComicCrawler Server URL.
5. Enter the user ID and user API token when the Server uses token mode.
6. Leave both user fields blank only when the Server uses public mode.
7. Save the settings and approve the requested Server origin.

The user API token is used only for enrollment and authenticated REST requests.
The SDK-issued Browser Client credential is stored as opaque data in protected
`chrome.storage.local`. Neither value is placed in a URL or sent to a page.

## Automatic Browser Client preparation

1. Open the target manga chapter.
2. Open the extension popup or select **Translate this page**.
3. The background service automatically enrolls when no SDK credential exists,
   connects the Browser Client, and registers the active tab.
4. Keep the tab open until image discovery has completed.

Enrollment, connection, and current-tab registration are transport details and
are not shown as normal user controls. If the same tab and URL are already
registered, preparation is idempotent and does not revoke or recreate the
resource.

The native browser tab ID remains local. ComicCrawler receives only the SDK
Resource ID. Closing the tab revokes the local binding. A URL change also
revokes it, except for a same-origin redirect while an approved task is active;
that exception lets challenge pages return to the original chapter in the same
tab. A future task still requires the current URL to match its approval.

## Human-verification handoff

1. If the approved chapter tab shows a verification challenge, complete it
   manually in that same tab.
2. Do not use automation to solve CAPTCHA.
3. Leave the approved tab open. The extension checks the handoff in the
   background and resumes the same task after ComicCrawler reports `ready`.
4. Background checks run immediately while the popup is open and at least once
   every 30 seconds while it is closed. Chrome may delay an alarm.

The extension never solves CAPTCHA. Browser Client registration and handoff
polling remain background details; the user-facing surfaces stay limited to
settings and translation work.

## Required permissions

- `storage`: persist settings and opaque SDK state.
- `activeTab`: approve the tab selected by the user.
- `scripting`: read rendered DOM and prepare lazy page content through the SDK.
- `alarms`: reconnect and reconcile a waiting task while the popup is closed.
- ComicCrawler Server host permission: call discovery, REST, and WebSocket endpoints.
- Optional target-origin permission: support existing page translation behavior.

The extension does not request unrestricted `<all_urls>` access.

## Service-worker behavior

- The SDK WebSocket lives in the MV3 background service worker.
- Closing the popup does not explicitly disconnect it.
- Chrome 116 or newer is required. The SDK's 15-second heartbeat keeps the
  WebSocket inside Chrome's 30-second service-worker activity window.
- A 30-second maintenance alarm reconnects a dropped client and reconciles the
  current task and verification handoff.
- A restarted worker reads SDK state and reconnects before the popup reports its status.
- Reconnect creates a new process-scoped Worker ID.
- A saved tab resource is considered only when the same tab still has the exact URL.
- Existing crawler tasks are never silently rebound to a different tab. Normal
  page translation prepares the current tab again when the user retries.
- Automatic maintenance never rebinds a task or chooses another tab.

## Troubleshooting

- **Not enrolled**: save the correct Server URL and credentials, then reopen the popup or start translation.
- **Connection error**: check the discovery document and Server origin permission.
- **Approve the current tab again**: the tab closed, navigated, or lost its grant.
- **Waiting for Browser Worker**: another task is using the only Worker.
- **Waiting for verification**: focus the approved tab and complete the challenge manually.
- **Worker changed**: keep the exact chapter tab open and retry the translation.
- **Approved resource unavailable**: the tab closed, navigated, or its resource
  could not be restored. Open the exact chapter URL and retry the translation.
- **Credential rejected**: verify the Browser Client user ID/token in settings and retry translation.

