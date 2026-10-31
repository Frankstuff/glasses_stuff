# Meta glasses transport research

Checked **2026-10-28** against public official sources. **Documented** means the source was read; it does not mean hardware was tested. The attachment supplies the proposed project architecture, not proof that it works. No Mac, phone, glasses, call, SDK build, or audio driver was tested in this Linux VM.

**Recommendation:** first prove the WhatsApp video + BlackHole speech round trip for personal practice. It requires no custom phone app. DAT is a documented alternative that delivers camera frames to a native phone app, but requires a new integration and a separate phone-to-Mac transport if analysis remains on the Mac. Neither approach establishes chess-board readability or acceptable latency without a hardware test.

## 1. WhatsApp path: documented feature, untested project integration

Meta's current [calling guide][calls] explicitly covers **iPhone and Android**, connecting WhatsApp through Meta AI, and calling on the **Ray-Ban Meta, Oakley Meta, and Meta Glasses** families. It also has a separate Meta Ray-Ban Display section. The shared [video-view guide][view] says:

1. Pair glasses with Meta AI; in Meta AI, select the device, then **Device settings → glasses → Communication → Connect** next to WhatsApp.
2. Start a WhatsApp **video** call and tap **Glasses** to enable the glasses view.
3. **Double-press the physical capture button** to switch between glasses and phone cameras. This differs from double-tapping the touchpad, which the calling guide uses to end calls.
4. The phone can be locked while continuing to share the glasses view.

These guides do not provide an exhaustive video-call SKU/generation whitelist, consumer phone OS minimum, call resolution, frame rate, codec, bitrate, glasses-to-phone radio transport, or latency guarantee. **Do not substitute DAT's compatibility list for WhatsApp compatibility.** Confirm the user's exact model, phone OS, region, and installed versions before claiming a supported combination; Ray-Ban Stories and audio-only frames are not established camera sources by these sources.

WhatsApp's current [desktop download page][desktop] confirms Mac video calling, **macOS 11+**, linking to a primary phone account, and installation from either WhatsApp or the App Store. Thus “App Store only” is a project compatibility constraint in the attachment, not a general WhatsApp requirement. Use the native app for the attachment's window-capture implementation. The [calling help][wa-video] documents microphone/camera access, manual acceptance, and microphone/video settings; it does **not** document programmatic call-frame access.

### Reproducible personal setup

Use **two distinct WhatsApp accounts** for the first experiment: wearer account A on the paired phone, recipient account B linked to native WhatsApp on the Mac. Account B needs its own primary-phone registration/linking setup. This is a practical test arrangement; an official prohibition on self-calling was not verified. Linking the Mac to account A alone does not establish a callable second participant.

```text
glasses camera → phone-managed WhatsApp video call → Mac WhatsApp call window
                                                    ↓ periodic window screenshot
                                               JPEG → chess analysis

Mac speech → BlackHole output/input → WhatsApp microphone → call → glasses speakers
```

This depicts application endpoints, **not verified radio/network packet routing**. No Meta SDK or chess code runs on the glasses in this arrangement.

- Answer on the Mac, enable the glasses view, and keep the call window visible and unminimized for the baseline test.
- Allow the application actually running capture access under **Privacy & Security → Screen & System Audio Recording** ([Apple instructions][screen]); allow WhatsApp its microphone/camera permissions.
- The attachment's intended input is `src/macos.ts` window capture using `screencapture -x -o -l <windowId> -t jpg`, consumed by `CallWindow.grab()`. It samples the **rendered call UI**, not an original camera feed. Window dimensions, call controls, scaling and video compression can affect recognition. This is attachment-derived, not validation of reconstructed product source.
- Save one frame with all 64 squares visible; inspect it at actual captured resolution. Then verify speech as below. The attachment's `npx chesshacker test-call` is useful **once that CLI has been reconstructed and validated**; it is not a Meta-provided command.

## 2. BlackHole: exact audio direction

The [maintainer's documentation][blackhole] confirms Apple Silicon builds, macOS support, and this routing rule: select BlackHole as the sender's **output**, and as the receiving application's **input**, on corresponding channels.

On the user's Mac, following its installation instructions:

```sh
brew install blackhole-2ch
say -a '?'
say -a "BlackHole 2ch" "Chess practice test. Knight to f3."
```

Installation is maintainer-documented; the `say` invocation is the attachment's proposed smoke test and remains unexecuted. Confirm the device appears in `say -a '?'`; reopen audio apps or restart as the installer requests. In WhatsApp's call microphone settings, select **BlackHole 2ch**, unmute, and leave WhatsApp's speaker output on the normal Mac output. Confirm the phone call audio route is the glasses.

BlackHole is a **local virtual audio device**. It does not transmit to the glasses itself. Audio written to its output becomes microphone input for WhatsApp; WhatsApp transports it through the call. Success from `say` alone does not prove delivery or intelligibility. Noise suppression, gating, echo control, phone routing and call interruptions remain untested.

A Multi-Output Device is optional for local monitoring; direct `say` → BlackHole does not require one. If using it, follow the [official wiki][multi], match device sample rates and enable drift correction for devices other than the clock source. Avoid sending WhatsApp's received audio back into its own microphone. BlackHole's “zero additional driver latency” claim is **not** a zero-latency call guarantee.

## 3. Wearables Device Access Toolkit (DAT) alternative

Current official [setup][setup], [version matrix][versions] and SDK repositories describe a **developer preview**. The public repositories currently show **SDK 1.0.1**, substantially newer than early preview descriptions in the attachment.

| Requirement | Documented current status |
|---|---|
| Execution platform | Native **iOS 17.2+** or **Android 10+** app. No direct Mac camera SDK or USB/webcam interface is established by these docs. |
| Named hardware | Setup lists **Ray-Ban Meta Gen 1 and Gen 2, Ray-Ban Meta Optics, Meta Glasses, Meta Ray-Ban Display, Oakley Meta HSTN, Oakley Meta Vanguard**. Do not extend this list to unlisted generations or assume every capability exists on every listed device. |
| SDK 1.0.1 versions | Matrix lists Meta AI **V292** on iOS/Android and glasses firmware **V128** for Ray-Ban Meta, Meta Glasses, Display, HSTN and Vanguard. Optics has no separate matrix row; verify its mapping. |
| Build tools | iOS: Xcode **26.4+**, Swift **6.3+** in the [current sample][ios-sample]. Android: setup requires Kotlin **2.2+**; the [current sample][android-sample] specifies Android Studio Narwhal+, JDK 17+, Android SDK 36+. |
| Personal testing | Enable Meta AI Developer Mode: **Settings → App Info → tap App version five times → enable**. An unpublished app can register without publishing review. The iOS sample says no Meta credentials are needed in Developer Mode; Apple signing/team setup is still required. |
| Registration/permissions | Register the app through Meta AI, then request camera permission (“Allow once” or “Allow always”). Registration alone does not grant the camera. Developer Mode allows only **one registered third-party app** at once. [Permissions guide][permissions] |
| Sharing/distribution | Developer Center organization/project configuration and an invite-only **Beta** channel for testers; its Users tab supplies the current tester limit. Not unrestricted public distribution. The [iOS guide][ios-build] explicitly says App Store submission is currently unsupported due to ExternalAccessory/MFi/privacy-manifest requirements. Android public-store acceptance was not verified. [Release guide][release] |

### Capture and transport

The [streaming guide][streaming] documents creating a `DeviceSession`, adding a camera, observing frames and starting the stream. On iOS, `stream.videoFramePublisher` delivers frames convertible using `frame.makeUIImage()`. On Android, collect `stream.videoStream`. These are **phone-app frame callbacks**, not a ready-made RTMP URL or Mac webcam.

Requested sizes are **720×1280**, **504×896**, or **360×640**; supported requested rates are **2, 7, 15, 24, 30 fps**. Adaptive compression/quality changes mean the requested settings are not an image-quality guarantee. Test actual dimensions and board detail.

**Official documentation conflict:** the streaming guide (updated Oct 19) attributes camera bandwidth and adaptive quality to **Bluetooth Classic**. The newer [iOS integration guide][ios-build] (Oct 26) says Bluetooth LE provides discovery/session/control, while streaming requires the phone to join a **Wi-Fi network hosted by the glasses**, Local Network permission, Bonjour configuration and Hotspot Configuration capability. The official [sample plist][plist] and [entitlements][entitlements] corroborate the Wi-Fi requirements. Treat actual transport as version/platform dependent and unresolved; do not promise Bluetooth-only streaming or a simple shared-LAN relay. The Android integration guide describes Bluetooth permissions but does not settle this conflict.

For Mac analysis, **new code** must encode/sample phone frames, attach sequence/timing metadata, send them to the Mac or a relay, and return analysis results. DAT does not supply that link. Test simultaneous phone-to-Mac/backend connectivity while joined to glasses Wi-Fi; do not assume the phone remains on the Mac's LAN. Running analysis on the phone avoids that extra transport.

### Audio and display

Meta's [audio guide][audio] documents standard phone Bluetooth routing: **A2DP** for output-only speech/media (44.1/48 kHz stereo), **HFP** for microphone plus output (negotiated 8/16 kHz mono). For spoken chess hints without microphone capture, use phone TTS over A2DP and verify the active route. BlackHole is unnecessary here. On iOS, establish HFP **before starting the camera stream** if microphone capture is needed.

In-stream microphone audio is also documented, but is **beta/development only**, disabled by default and unavailable in production channels. It does not need HFP. The docs expose Android PCM bytes and iOS `pcmBuffer` Float32 samples with presentation timestamps; do not assume identical raw buffer formats across platforms.

**Display support is now documented:** [DAT's display API][display] supports Meta Ray-Ban Display via phone-authored component layouts sent to the glasses. It requires an explicit session and installation/update of the DAT glasses component. The guide specifies a **600×600** display and phone-owned application state. This does not establish spatially anchored chessboard overlays. Displayless models can receive audio but cannot show an in-lens board. The separate [Web Apps path][llms] runs in Display's browser but **cannot access the glasses camera**, so it does not replace DAT for recognition.

## 4. Remaining hardware gates and access limits

1. Record exact glasses model, phone/OS, Meta AI, firmware and WhatsApp versions. DAT's matrix warns that some capabilities are also server-gated and may return `CAPABILITY_DENIED` despite matching versions.
2. **WhatsApp:** capture 20 usable board frames and hear ten short move announcements. Measure delay with a visible stopwatch; check locked-phone operation, five-minute continuity, reconnection and noise suppression. No resolution or latency numbers have been measured here.
3. **DAT:** run the matching official CameraAccess sample first; save 20 frames, log dimensions/rate and verify one TTS reply. Then test any Mac relay, backgrounding, interruptions, heat and battery. The iOS sample ends the active session when backgrounded; the Android sample demonstrates recording through a foreground service. MockDeviceKit verifies app behavior, not the real camera/radio path.
4. Check [current known issues][issues]: it lists an HFP audio failure on iPhone 17/iOS 26 (workaround: iOS 27+), camera-capture recovery requiring a reboot after V128, and battery/paused-session limitations. Treat them as documented risks, not reproduced failures.

**Access status:** all cited Meta developer pages, public SDK files, WhatsApp desktop/calling pages and BlackHole docs were accessible. Meta/WhatsApp consumer help initially returned only JavaScript shells; their cited article text was successfully read after Chrome rendering. Ray-Ban's retail FAQ returned **403** and was not used as evidence. Authenticated developer enrollment, invitation flows, app-store acceptance and hardware behavior were not exercised.

[calls]: https://www.meta.com/help/ai-glasses/647079267216457/
[view]: https://www.meta.com/help/ai-glasses/2144534879236727/
[desktop]: https://www.whatsapp.com/download/desktop
[wa-video]: https://faq.whatsapp.com/1862285217468140/
[screen]: https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac
[blackhole]: https://github.com/ExistentialAudio/BlackHole#route-audio-between-applications
[multi]: https://github.com/ExistentialAudio/BlackHole/wiki/Multi-Output-Device
[setup]: https://wearables.developer.meta.com/docs/develop/dat/getting-started-toolkit/
[versions]: https://wearables.developer.meta.com/docs/develop/dat/version-dependencies/
[permissions]: https://wearables.developer.meta.com/docs/develop/dat/permissions-requests/
[release]: https://wearables.developer.meta.com/docs/develop/dat/set-up-release-channels/
[ios-build]: https://wearables.developer.meta.com/docs/develop/dat/build-integration-ios/
[streaming]: https://wearables.developer.meta.com/docs/develop/dat/streaming/
[audio]: https://wearables.developer.meta.com/docs/develop/dat/microphones-and-speakers/
[display]: https://wearables.developer.meta.com/docs/develop/dat/display-overview/
[llms]: https://wearables.developer.meta.com/llms.txt?product=all
[issues]: https://wearables.developer.meta.com/docs/develop/dat/knownissues/
[ios-sample]: https://github.com/facebook/meta-wearables-dat-ios/blob/bbae597cd1c748cd29b9375a1624a8d75b1c9e14/samples/CameraAccess/README.md
[android-sample]: https://github.com/facebook/meta-wearables-dat-android/blob/f4371bc9f90249d51eb07d7f8a61e8d829294f16/samples/CameraAccess/README.md
[plist]: https://github.com/facebook/meta-wearables-dat-ios/blob/bbae597cd1c748cd29b9375a1624a8d75b1c9e14/samples/CameraAccess/CameraAccess/Info.plist
[entitlements]: https://github.com/facebook/meta-wearables-dat-ios/blob/bbae597cd1c748cd29b9375a1624a8d75b1c9e14/samples/CameraAccess/CameraAccess/CameraAccess.entitlements
