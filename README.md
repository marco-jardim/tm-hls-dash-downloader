# TM HLS/DASH Video Downloader

A **Tampermonkey** userscript that detects HLS (`.m3u8`) and DASH (`.mpd`) manifests requested by a page, parses their segments, and lets you **download the full video** via a simple in-page overlay.

> ⚠️ **Legal & ethical use:** This script is for saving content you created, content you have explicit permission to download, or content in the public domain. **It does not bypass DRM or decryption.** Respect site Terms of Service and copyright laws in your jurisdiction.

## Features
- Auto‑detects manifests by observing `XMLHttpRequest` and `fetch` network calls
- Parses **HLS** and **DASH** manifests into segment URLs
- Minimal **overlay UI** lists detected streams and shows a progress bar
- Downloads segments via `GM_xmlhttpRequest`/`GM_download` when available (falls back to `fetch` + Blob download)
- No exfiltration: runs entirely in your browser

## How it works (high level)
1. Hooks into `XMLHttpRequest.open` and `window.fetch` to watch for URLs ending in `.m3u8` or `.mpd`.
2. When a manifest is found, a lightweight parser extracts segment URLs.
3. Clicking **Download** fetches segments sequentially, buffers them in memory, and triggers a single download labeled as `video/mp4`.

> ℹ️ **Implementation note:** HLS segments are commonly MPEG‑TS. This script concatenates bytes and labels them `.mp4` for compatibility, which works in some players but is not a real remux. For best results with TS content, consider remuxing to MP4/MKV using external tools after download.

## Limitations
- **Master HLS playlists** (`#EXT-X-STREAM-INF`) are not resolved—only leaf playlists with explicit segments are supported.
- **Encrypted or DRM‑protected streams** (AES‑128/SAMPLE‑AES/Widevine/FairPlay/PlayReady) are **not supported**.
- **DASH** support relies on `media="..."` attributes with explicit segment paths; `SegmentTemplate` with index math is **not** implemented.
- Downloads are **buffered in RAM**; very long videos may be memory‑intensive.
- Cross‑origin requests rely on `GM_xmlhttpRequest`; without it, **CORS** may block downloads.
- Some players may refuse the concatenated output; if that happens, remux externally.

## Requirements
- Desktop browser (Chrome, Edge, Firefox) with the **Tampermonkey** extension.
- Permissions prompted by Tampermonkey when installing (cross‑origin requests and downloads).

## Install
### Quick (copy/paste)
1. Install **Tampermonkey** in your browser.
2. Open Tampermonkey ➜ **Create a new script**.
3. Replace the template with the contents of [`src/hls-dash-downloader.user.js`](src/hls-dash-downloader.user.js).
4. **Save**.

### Auto‑update (optional)
Auto-update is not configured in the script header. If you want Tampermonkey to check GitHub for updates automatically, add `@updateURL` (and optionally `@downloadURL`) pointing to the raw userscript, e.g. `https://raw.githubusercontent.com/marco-jardim/tm-hls-dash-downloader/main/src/hls-dash-downloader.user.js`.

## Usage
1. Visit a page that plays video via HLS or DASH.
2. When the page requests a manifest, a small panel titled **Detected Videos** appears (top‑right).
3. Click **Download** next to the stream you want. Watch the progress bar fill as segments are fetched.
4. When complete, a file will be saved with a safe version of the page title (ending in `.mp4`).

## Troubleshooting
- **Nothing appears**: ensure the site actually uses HLS/DASH and loads manifests via XHR/fetch (not via Service Worker, WebRTC, or native player without network calls).
- **Download stalls**: the site may gate segments by referrer/cookies/DRM. Try keeping the tab focused, or use sites where you have the right to download.
- **File won’t play**: try a player that can read TS‑in‑MP4, or remux with an external tool.
- **CORS errors** without Tampermonkey grants: ensure `GM_xmlhttpRequest`/`GM_download` are granted and `@connect *` is present.

## Project structure
```
tm-hls-dash-downloader/
├─ src/
│  └─ hls-dash-downloader.user.js
├─ docs/
│  ├─ getting-started.md
│  └─ faq.md
├─ .github/
│  ├─ ISSUE_TEMPLATE/
│  │  ├─ bug_report.md
│  │  └─ feature_request.md
│  └─ PULL_REQUEST_TEMPLATE.md
├─ .editorconfig
├─ .gitattributes
├─ .gitignore
├─ CHANGELOG.md
├─ CODE_OF_CONDUCT.md
├─ CONTRIBUTING.md
├─ LICENSE
└─ README.md
```

## Contributing
Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md).

## Security
Please report security issues as described in [SECURITY.md](SECURITY.md).

## License
[MIT](LICENSE) © 2025 Marco Jardim

---

### GitHub: create & push this repo
```bash
git init tm-hls-dash-downloader
cd tm-hls-dash-downloader
git add .
git commit -m "chore: initial commit (Tampermonkey HLS/DASH downloader)"
git branch -M main
git remote add origin git@github.com:marco-jardim/tm-hls-dash-downloader.git
git push -u origin main
```
