# Safe Feed - project state

Personal Android app (for one person): the real Facebook mobile site (m.facebook.com) inside a WebView, with
- Reels hidden
- every picture and video blurred until an on-phone check says "no woman's face"

No cloud, no paid service, nothing about pictures leaves the phone. Login happens on Facebook's own page
(the app never sees the password). The app does not copy Facebook's name or logo.

## How it works
- `app/src/main/assets/sg/filter.js` - runs inside the Facebook page (document-start). CSS blur by default,
  finds pictures/videos/avatars/background images, asks the app for a verdict, reveals clean ones, hides Reels.
- `Pipeline.java` - gets jobs from the page: `frame` = JPEG drawn by the page, `check` = the app downloads a
  Facebook-CDN picture itself (used when the page cannot read it because of CORS). Caches verdicts. Talks to the hidden page.
- `assets/ml/` (`index.html`, `ml.js`, `faceapi.js`, `models/`) - hidden 1x1 WebView page running
  @vladmandic/face-api (TinyFaceDetector + AgeGenderNet). Returns 0 = no woman, 1 = woman, 2 = error.
- `MainActivity.java` - the two WebViews, link routing (Reels blocked, outside links open in the browser),
  small bottom-left menu: reload / home / Status (counters + last problems, for screenshots).
- `tools/fetch-assets.js` - the build downloads the face library and the two small models
  (`npm pack @vladmandic/face-api@1.7.15`, jsDelivr as fallback).
- `tools/build.yml.txt` - copy of `.github/workflows/build.yml` (the workflow itself must live in `.github/workflows/`).

## Build and delivery
Upload `app.zip` to the repo -> the workflow unpacks it, builds a signed APK and publishes it on the
Releases page (`build-N`, file `SafeFeed.apk`). Install over the old version (signature stays the same).
The signing key is in `keystore/safefeed.jks` (public repo: fine for a personal app, but anyone could sign an APK with it).

## Rules (fail-safe)
- No answer / error / timeout = stays blurred. A picture is judged by its own size, never by how small it looks
  right now (carousels / zoom animations).
- Any face with a female score >= 0.20 blurs the whole picture (careful side). Faces need score >= 0.25.
  Big pictures get extra looks at 512 and 608 px (finds small faces).
- Small, nearly square pictures (profile photos, <= 256 px): if no face can be found at all they stay blurred.
- Videos: autoplay off, full-screen off (full-screen would skip the blur). Playing videos are sampled every ~0.4 s
  (video frames jump the checker queue), shown after 2 clean samples, and blurred again when no fresh clean answer
  arrives for 2.5 s. One woman's face blurs a video until its source changes.
- Reels: links, menu entries and headings called Reels are hidden (with their card), /reel pages are blocked in the
  app and in the page, and every tall video (height/width >= 1.6) is never shown at all.

## Status
- Version 2. Version 1 was built and installed by the user (blur was inconsistent, Reels still reachable).
  Version 2 fixes the leaks found by review (size rule, background shorthand, Reels cards, video latency) - not yet seen on the phone.
- Checked offline only: Java compiles against Android API stubs; `filter.js` and `ml.js` pass tests in desktop
  Chromium with a fake face library and fake app bridge.
- Unknown until the first real run: Facebook's current page structure, whether pictures can be read in the page
  or the app has to download them, speed on the phone, real accuracy of the gender guess.

## Next steps
- Run on the phone, read the Status screen, fix what breaks.
- Possible later: blur strength / threshold settings, option to treat children differently, persistent verdict cache.
