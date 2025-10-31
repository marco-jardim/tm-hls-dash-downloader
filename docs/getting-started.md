# Getting Started

This guide walks you through installing and using the userscript.

## Install Tampermonkey
1. Install the Tampermonkey extension for your browser (Chrome, Edge, Firefox).
2. Click the extension icon ➜ **Dashboard**.

## Add the userscript
1. Click **Create a new script**.
2. Paste the contents of `src/hls-dash-downloader.user.js`.
3. Click **File ➜ Save**.

## Try it
1. Open a page that plays HLS or DASH video.
2. When a manifest is requested, an overlay called **Detected Videos** appears.
3. Click **Download** to fetch and save the video.
