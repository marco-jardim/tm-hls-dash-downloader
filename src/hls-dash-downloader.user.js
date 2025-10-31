// ==UserScript==
// @name         HLS/DASH Video Downloader
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Detects HLS (.m3u8) and DASH (.mpd) manifests on web pages, parses their segments and allows you to download the complete video with a simple UI overlay. The script hooks into XMLHttpRequest and fetch calls to find manifest files and uses GM_xmlhttpRequest/GM_download where available to fetch segments across origins.
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      *
// ==/UserScript==

(function() {
  'use strict';

  // Keep track of manifests we've already seen to avoid duplicate processing
  const manifestUrls = new Set();
  const videos = []; // detected videos: { id, manifestUrl, type, segments, title, progressBar }
  let idCounter = 1;

  // Parse HLS manifest into segment URLs
  async function parseHlsManifest(url) {
    const response = await GM_fetch(url);
    const text = await response.text();
    const root = url.slice(0, url.lastIndexOf('/') + 1);
    const segments = [];
    text.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const absolute = /^https?:\/\//i.test(trimmed) ? trimmed : root + trimmed;
      segments.push(absolute);
    });
    return segments;
  }

  // Parse DASH manifest into segment URLs by extracting media="..." attributes
  async function parseDashManifest(url) {
    const response = await GM_fetch(url);
    const text = await response.text();
    const root = url.slice(0, url.lastIndexOf('/') + 1);
    const segments = [];
    const regex = /media="([^"]+)"/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const seg = match[1];
      if (/init/i.test(seg)) continue; // skip initialization segments
      const absolute = /^https?:\/\//i.test(seg) ? seg : root + seg;
      segments.push(absolute);
    }
    return segments;
  }

  // Called when a new manifest URL is detected
  function handleManifest(url) {
    if (manifestUrls.has(url)) return;
    manifestUrls.add(url);
    const type = url.includes('.m3u8') ? 'hls' : (url.includes('.mpd') ? 'dash' : null);
    if (!type) return;
    const parser = type === 'hls' ? parseHlsManifest : parseDashManifest;
    parser(url).then(segments => {
      if (!segments || segments.length === 0) return;
      const title = document.title || ('Video ' + idCounter);
      const video = { id: idCounter++, manifestUrl: url, type, segments, title, progressBar: null };
      videos.push(video);
      updateUI();
    }).catch(err => {
      console.error('Failed to parse manifest', url, err);
    });
  }

  // Override XMLHttpRequest.open to detect manifest requests
  const origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    try {
      if (url && (url.match(/\.m3u8(\?|$)/i) || url.match(/\.mpd(\?|$)/i))) {
        handleManifest(url);
      }
    } catch (e) { console.error(e); }
    return origXHROpen.apply(this, arguments);
  };

  // Override fetch to detect manifest requests
  const origFetch = window.fetch;
  window.fetch = function(resource, init) {
    try {
      const url = typeof resource === 'string' ? resource : (resource && resource.url);
      if (url && (url.match(/\.m3u8(\?|$)/i) || url.match(/\.mpd(\?|$)/i))) {
        handleManifest(url);
      }
    } catch (e) { console.error(e); }
    return origFetch.apply(this, arguments);
  };

  // Build UI overlay to display detected videos and download buttons
  function createUI() {
    const container = document.createElement('div');
    container.id = 'gm-video-downloader';
    container.style.position = 'fixed';
    container.style.top = '10px';
    container.style.right = '10px';
    container.style.zIndex = '999999';
    container.style.width = '320px';
    container.style.maxHeight = '80vh';
    container.style.overflowY = 'auto';
    container.style.background = 'rgba(255, 255, 255, 0.95)';
    container.style.border = '1px solid #ccc';
    container.style.padding = '10px';
    container.style.fontFamily = 'Arial, sans-serif';
    container.style.fontSize = '13px';
    container.style.color = '#000';
    container.innerHTML = '<h3 style="margin-top:0;margin-bottom:8px;font-size:15px;">Detected Videos</h3><div id="gm-videos-list"></div>';
    document.body.appendChild(container);
  }

  // Update UI to reflect current videos list
  function updateUI() {
    const list = document.getElementById('gm-videos-list');
    if (!list) return;
    list.innerHTML = '';
    if (videos.length === 0) {
      list.textContent = 'No videos detected yet.';
      return;
    }
    videos.forEach(video => {
      const div = document.createElement('div');
      div.style.border = '1px solid #ddd';
      div.style.padding = '6px';
      div.style.marginBottom = '6px';
      // Title
      const titleEl = document.createElement('div');
      titleEl.textContent = video.title;
      titleEl.style.marginBottom = '4px';
      div.appendChild(titleEl);
      // Download button
      const btn = document.createElement('button');
      btn.textContent = 'Download';
      btn.style.padding = '4px 8px';
      btn.style.fontSize = '12px';
      btn.addEventListener('click', () => startDownload(video));
      div.appendChild(btn);
      // Progress bar
      const progressContainer = document.createElement('div');
      progressContainer.style.width = '100%';
      progressContainer.style.height = '6px';
      progressContainer.style.background = '#eee';
      progressContainer.style.marginTop = '4px';
      const progressBar = document.createElement('div');
      progressBar.style.height = '100%';
      progressBar.style.width = '0%';
      progressBar.style.background = '#4caf50';
      progressContainer.appendChild(progressBar);
      div.appendChild(progressContainer);
      video.progressBar = progressBar;
      list.appendChild(div);
    });
  }

  // Download segments and combine into a single blob
  async function startDownload(video) {
    const { segments, type, title } = video;
    const buffers = [];
    let downloaded = 0;
    for (const seg of segments) {
      try {
        const resp = await GM_fetch(seg, { method: 'GET' });
        const buf = await resp.arrayBuffer();
        buffers.push(buf);
        downloaded++;
        if (video.progressBar) {
          const progress = (downloaded / segments.length) * 100;
          video.progressBar.style.width = progress + '%';
        }
      } catch (err) {
        console.error('Failed to download segment', seg, err);
      }
    }
    // Always save the combined file as an MP4 container. Although HLS segments
    // are typically MPEG-TS, concatenating and labelling the file as .mp4
    // improves player compatibility in many cases.
    const mime = 'video/mp4';
    const blob = new Blob(buffers, { type: mime });
    const blobUrl = URL.createObjectURL(blob);
    // Always use .mp4 extension for the saved file
    const safeBase = title.replace(/[^a-z0-9\-_.]/gi, '_').slice(0, 80);
    const safeTitle = safeBase + '.mp4';
    if (typeof GM_download === 'function') {
      GM_download({ url: blobUrl, name: safeTitle });
    } else {
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = safeTitle;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(blobUrl);
      }, 1000);
    }
  }

  // Provide a fetch wrapper using GM_xmlhttpRequest for cross-origin requests, falling back to window.fetch
  function GM_fetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest(Object.assign({}, options, {
          method: options.method || 'GET',
          url: url,
          responseType: 'arraybuffer',
          onload: function(response) {
            // Construct a Response-like object
            const arrayBuffer = async () => response.response;
            const text = async () => new TextDecoder().decode(response.response);
            resolve({ ok: true, status: response.status, arrayBuffer, text });
          },
          onerror: function(err) { reject(err); }
        }));
      } else {
        fetch(url, options).then(resolve).catch(reject);
      }
    });
  }

  // Initialize UI when DOM is ready
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    createUI();
  } else {
    document.addEventListener('DOMContentLoaded', createUI);
  }
})();
