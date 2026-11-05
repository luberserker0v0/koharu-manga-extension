# Microsoft Edge on Android adaptation

## Platform baseline

Microsoft's current Edge extension API matrix lists every extension API used by
Koharu Manga Companion as supported on Android: Manifest V3 `action`, `alarms`,
`downloads`, `permissions`, `runtime`, `scripting`, `storage`, and `tabs`.
The extension therefore keeps the Edge MV3 build and does not introduce a
separate mobile API client.

Primary references:

- [Supported APIs for Microsoft Edge extensions](https://learn.microsoft.com/microsoft-edge/extensions/developer-guide/api-support)
- [Manifest file format for extensions](https://learn.microsoft.com/microsoft-edge/extensions/getting-started/manifest-format)
- [Overview of Microsoft Edge extensions](https://learn.microsoft.com/microsoft-edge/extensions/)

Physical-device testing remains authoritative. Edge Android can suspend its
background service worker more aggressively than desktop Edge, and the mobile
extension UI and Add-ons availability can vary by Edge release channel.

### Emulator architecture limitation

The current Edge Canary Android package delivers ARM64 Chromium native
libraries. On the Windows x86_64 Android Emulator used during development, the
app's first-run activity starts but its native sandbox zygote fails to load
`libchrome.so` with `EM_AARCH64 instead of EM_X86_64`. The AVD advertises NDK
translation, but this Chromium process model is not translated successfully.

Android Emulator release notes describe Windows support for fixes needed by
some ARM64 applications under NDK translation as still in progress. An ARM
system image on an Intel/AMD host also cannot use normal VM acceleration. Use a
physical ARM64 Android phone as the authoritative Edge extension test target;
do not interpret the Emulator's frozen Edge first-run screen as an extension
failure.

- [Android Emulator release notes](https://developer.android.com/studio/releases/emulator)
- [Android Emulator acceleration requirements](https://developer.android.com/studio/run/emulator-acceleration)

## Experimental installation

Microsoft's Amplifier Browser Bridge project documents the current practical
limit: stable Edge Android exposes a curated extension catalog, while custom
development packages use an experimental Canary/Beta developer-options flow.
That flow requires a real signed CRX3 file; renaming the release ZIP is not
valid. Treat this as experimental behavior rather than a stable distribution
contract:

- [Microsoft Android operator runbook](https://github.com/microsoft/amplifier-browser-bridge/blob/main/docs/ANDROID.md)

On the Windows development PC, create a signed CRX3 with:

```powershell
npm run package:edge-android
```

The command builds the Edge MV3 package and writes `.crx` and download-safe
`.bin` copies under `.output/`. On first use it lets Edge generate a signing
key and moves that key outside the repository to:

```text
%USERPROFILE%\.koharu-manga-companion\edge-android-signing-key.pem
```

Keep that key private and backed up. Reusing it preserves the extension ID and
therefore the installed extension's storage and permissions. The key and all
`.pem` files are ignored by Git.

For the currently observed Canary workflow, enable developer options from
**Settings → About Microsoft Edge** by tapping the build number repeatedly,
then use **Developer options → Extension install by crx**. If downloading with
Edge causes the CRX to disappear, download the generated `.bin`, rename it to
`.crx` in the Android file manager, and select that local file. This exact UI is
not part of Microsoft's public Edge extension contract and may change.

## Network topology

`127.0.0.1` on Android refers to the phone, not the development PC. When the
Manga Translation Backend or ComicCrawler runs on another computer, configure
the extension with that computer's reachable LAN address, for example:

```text
http://192.168.1.20:4001/api/v1
http://192.168.1.20:4100
```

The services must listen on a LAN-reachable interface, the host firewall must
allow the selected ports, and both services must allow the installed
extension's origin through CORS. Do not expose either service directly to the
public Internet. Prefer a trusted local network or an authenticated private
network, and configure the existing Bearer/Basic credentials.

Saving settings requests optional host access for the configured origins. No
blanket host access is added to the install-time permissions.

## Responsive and touch behavior

- Action popups retain an explicit `430 × 600` document size on every platform.
  Extension popup viewports are initially measured from their contents; using
  `vw`, `vh`, or `dvh` for the document itself can create a circular size
  calculation and collapse Edge's popup. Responsive rules only change the
  internal layout and safe-area padding.
- The page translator becomes a full dynamic-viewport drawer at 440 CSS pixels
  or below and respects notches and gesture-navigation safe areas.
- Form fields use a 16-pixel mobile font to avoid browser focus zoom and a
  minimum 44-pixel control height.
- Drawer navigation uses 44-pixel touch targets on mobile.
- The floating page action no longer depends on hover to expand on coarse
  pointer devices. It remains draggable using Pointer Events.
- Image review always provides explicit up/down controls. Native HTML drag and
  drop is only an enhancement; translation ordering never depends on touch drag
  support.
- OCR image zoom and text-region manipulation use Pointer Events and retain the
  existing numeric geometry editor as an accessible fallback.
- The live Job panel can enable page-number badges. Badges use a separate,
  pointer-transparent overlay, follow image rectangles during scroll, resize,
  orientation changes, and lazy DOM replacement, and disappear in fullscreen.
  They never wrap reader images or change the site's layout.
  The preference uses a dedicated local UI-storage key, so toggling it does not
  restart ComicCrawler Browser Client maintenance or touch protected backend
  credentials. Candidate elements are resolved in one bounded bulk traversal
  per DOM update instead of rescanning the page once per badge.

## ComicCrawler and page mapping

The extension sends ComicCrawler the actual page CSS viewport width/height and
device pixel ratio. This is contextual rendering input rather than a separate
"mobile" API mode.

Translated images are applied by stable ComicCrawler page identity when it is
available and by the preserved DOM candidate otherwise. Replacement dimensions
follow the original page element's layout, so translated raster dimensions do
not select desktop or mobile placement. The extension must not infer mappings
from viewport position, output filename, or ZIP order.

Responsive sites may serve different source assets at different widths. A
changed ComicCrawler `sourceFingerprint` must prevent silent application of an
older translation. Generic DOM fallback should be tested separately because it
does not have the same cross-device identity guarantee.

## Physical-device test matrix

Test a current Edge Canary build first. Stable Edge can be tested after the
extension becomes available through its supported catalog/distribution path:

1. Install/update the Edge MV3 package and open its action UI.
2. Save LAN backend and optional ComicCrawler URLs; grant and revoke each origin.
3. Reload a supported chapter and verify the floating action remains tappable,
   draggable, and visible across orientation and browser-toolbar changes.
4. Review, exclude, and reorder images without native drag and drop.
5. Complete upload, preflight, job creation, SSE progress, service-worker
   suspension/reconnection, and terminal reconciliation.
6. Apply translated pages, reload the chapter, auto-apply history, restore
   originals, and verify stable page ordering.
7. Exercise OCR original/translated preview, zoom, box selection, geometry edit,
   and correction submission.
8. Exercise ComicCrawler existing-tab registration and CAPTCHA handoff. The
   extension may observe and resume after verification but must never solve it.
9. Test portrait, landscape, display zoom, font scaling, pinch zoom, and a
   device with gesture-navigation safe areas.
10. Confirm downloads, error diagnostics, credentials redaction, local-time
    formatting, and Traditional Chinese/English text.

## Known boundaries

- iOS Edge does not run Chromium extensions and is outside this target.
- Canvas-only readers, PDF viewers, and restricted browser pages retain the
  existing desktop limitations.
- A phone cannot use the PC's loopback backend addresses.
- Generic DOM detection cannot guarantee that a responsive site exposes the
  same assets or DOM across devices; approved ComicCrawler page identities are
  preferred for cross-device history and automatic application.
