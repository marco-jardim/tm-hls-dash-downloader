// ==UserScript==
// @name         HLS/DASH Video Downloader
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Detects and downloads HLS (.m3u8) and DASH (.mpd) streams with a rich, draggable control panel.
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      *
// ==/UserScript==

(function() {
  'use strict';

  const manifestUrls = new Set();
  const videos = [];
  const videoLookup = new Map();
  const ignoredManifests = new Set();
  let idCounter = 1;

  const UI_STATE_KEY = 'tmHlsDashDownloaderUiState';
  const DEFAULT_STATE = {
    position: { x: null, y: null },
    collapsed: false
  };
  let uiState = loadState();

  const ui = {
    container: null,
    body: null,
    list: null,
    stats: null,
    selectAll: null,
    downloadSelected: null,
    downloadAll: null,
    collapseBtn: null,
    aboutPanel: null,
    aboutToggle: null
  };

  const BLACKLIST_TOKENS = ['subtitle', 'subtitles', 'caption', 'captions', 'spritemap', 'sprite', 'preview', 'thumbnail', 'thumb', 'ad-', '/ad/', 'ads.', 'audio_only'];
  const SEGMENT_BLACKLIST_EXT = ['.vtt', '.srt', '.jpg', '.jpeg', '.png', '.gif', '.webvtt'];
  const AUDIO_HINT_TOKENS = ['audio_only', '/audio/', 'audio-', 'onlyaudio'];
  const VIDEO_HINT_TOKENS = ['video', 'main', 'master', 'index', 'stream', 'prog', 'source'];

  function loadState() {
    try {
      const raw = localStorage.getItem(UI_STATE_KEY);
      if (!raw) return { ...DEFAULT_STATE };
      const parsed = JSON.parse(raw);
      return {
        position: parsed.position || { ...DEFAULT_STATE.position },
        collapsed: Boolean(parsed.collapsed)
      };
    } catch (err) {
      console.warn('Failed to load downloader UI state', err);
      return { ...DEFAULT_STATE };
    }
  }

  function saveState(partial) {
    uiState = { ...uiState, ...partial };
    try {
      localStorage.setItem(UI_STATE_KEY, JSON.stringify(uiState));
    } catch (err) {
      console.warn('Failed to persist downloader state', err);
    }
  }

  function injectStyles() {
    if (document.getElementById('gm-video-downloader-style')) return;
    const style = document.createElement('style');
    style.id = 'gm-video-downloader-style';
    style.textContent = `
      .gm-downloader-panel {
        position: fixed;
        top: 20px;
        right: 20px;
        width: 340px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        background: linear-gradient(160deg, rgba(23, 43, 77, 0.95), rgba(105, 123, 160, 0.92));
        color: #f1f5ff;
        border-radius: 14px;
        box-shadow: 0 18px 35px rgba(10, 15, 43, 0.45);
        font-family: 'Inter', 'Segoe UI', Arial, sans-serif;
        font-size: 13px;
        overflow: hidden;
        z-index: 999999;
        backdrop-filter: blur(6px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        user-select: none;
      }
      .gm-downloader-panel.collapsed .gm-downloader-body,
      .gm-downloader-panel.collapsed .gm-downloader-footer {
        display: none;
      }
      .gm-downloader-panel.collapsed {
        width: auto;
        max-width: 260px;
      }
      .gm-downloader-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 14px;
        cursor: grab;
        background: linear-gradient(140deg, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0.04));
      }
      .gm-downloader-header:active {
        cursor: grabbing;
      }
      .gm-title-block {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .gm-title {
        font-weight: 600;
        letter-spacing: 0.2px;
        font-size: 14px;
      }
      .gm-subtitle {
        font-size: 11px;
        opacity: 0.75;
      }
      .gm-header-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .gm-btn {
        border: none;
        border-radius: 8px;
        padding: 6px 10px;
        font-size: 12px;
        font-weight: 500;
        background: rgba(255, 255, 255, 0.14);
        color: inherit;
        cursor: pointer;
        transition: background 0.18s ease, transform 0.18s ease;
      }
      .gm-btn:hover {
        background: rgba(255, 255, 255, 0.24);
      }
      .gm-btn:active {
        transform: translateY(1px);
      }
      .gm-btn[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .gm-btn-icon {
        width: 28px;
        height: 28px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        background: rgba(255, 255, 255, 0.12);
      }
      .gm-downloader-body {
        padding: 12px 14px 6px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden auto;
      }
      .gm-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .gm-toolbar-left {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .gm-toolbar-right {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .gm-checkbox-wrapper {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: rgba(255, 255, 255, 0.08);
        padding: 4px 8px;
        border-radius: 6px;
      }
      .gm-checkbox-wrapper input {
        accent-color: #71caff;
      }
      .gm-summary {
        font-size: 12px;
        opacity: 0.85;
      }
      .gm-videos-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .gm-empty-state {
        font-size: 12px;
        opacity: 0.7;
        text-align: center;
        padding: 18px 10px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.08);
      }
      .gm-video-card {
        background: rgba(10, 19, 46, 0.4);
        border-radius: 12px;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.05);
      }
      .gm-video-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
      }
      .gm-video-main {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        flex: 1 1 auto;
      }
      .gm-video-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1 1 auto;
      }
      .gm-video-title {
        font-weight: 600;
        font-size: 13px;
        line-height: 1.3;
      }
      .gm-video-meta {
        font-size: 11px;
        opacity: 0.82;
        line-height: 1.4;
      }
      .gm-video-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .gm-progress-shell {
        height: 8px;
        border-radius: 6px;
        overflow: hidden;
        background: rgba(255, 255, 255, 0.12);
      }
      .gm-progress-bar {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #66e0ff, #8f9bff);
        transition: width 0.18s ease;
      }
      .gm-progress-text {
        font-size: 11px;
        opacity: 0.8;
        display: flex;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 4px;
      }
      .gm-footer-actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        padding: 8px 14px 14px;
        font-size: 11px;
        opacity: 0.75;
      }
      .gm-link {
        background: none;
        border: none;
        padding: 0;
        margin: 0;
        color: inherit;
        text-decoration: underline;
        cursor: pointer;
      }
      .gm-about-card {
        position: absolute;
        inset: 12px;
        background: rgba(8, 12, 30, 0.9);
        border-radius: 12px;
        padding: 16px;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
        display: none;
        flex-direction: column;
        gap: 10px;
        z-index: 1;
      }
      .gm-about-card.visible {
        display: flex;
      }
      .gm-about-title {
        font-weight: 600;
        font-size: 13px;
      }
      .gm-about-text {
        font-size: 11px;
        line-height: 1.5;
        opacity: 0.85;
      }
      .gm-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 6px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.12);
        font-size: 10px;
      }
      .gm-dismissed {
        opacity: 0.45;
      }
      .gm-batch-status {
        display: flex;
        gap: 6px;
      }
    `;
    document.head.appendChild(style);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function createUI() {
    injectStyles();

    const container = document.createElement('div');
    container.id = 'gm-video-downloader';
    container.className = 'gm-downloader-panel';

    const header = document.createElement('div');
    header.className = 'gm-downloader-header';
    header.innerHTML = `
      <div class="gm-title-block">
        <span class="gm-title">Stream Downloader</span>
        <span class="gm-subtitle">HLS / DASH manifest watcher</span>
      </div>
      <div class="gm-header-actions">
        <button class="gm-btn gm-btn-icon" data-action="refresh" title="Rescan for new manifests">⟳</button>
        <button class="gm-btn gm-btn-icon" data-action="about" title="About & help">?</button>
        <button class="gm-btn gm-btn-icon" data-action="collapse" title="Collapse panel">▾</button>
      </div>
    `;

    const body = document.createElement('div');
    body.className = 'gm-downloader-body';
    body.innerHTML = `
      <div class="gm-toolbar">
        <div class="gm-toolbar-left">
          <label class="gm-checkbox-wrapper">
            <input type="checkbox" id="gm-select-all" />
            <span>Select all</span>
          </label>
        </div>
        <div class="gm-toolbar-right">
          <button class="gm-btn" data-action="download-selected">Download Selected</button>
          <button class="gm-btn" data-action="download-all">Download All</button>
        </div>
      </div>
      <div class="gm-summary" id="gm-downloader-stats">Detecting streams…</div>
      <div class="gm-videos-list" id="gm-videos-list"></div>
    `;

    const footer = document.createElement('div');
    footer.className = 'gm-footer-actions';
    footer.innerHTML = `
      <span class="gm-batch-status" id="gm-batch-status"></span>
      <button class="gm-link" data-action="refresh">Refresh detection</button>
    `;

    const aboutCard = document.createElement('div');
    aboutCard.className = 'gm-about-card';
    aboutCard.innerHTML = `
      <div class="gm-about-title">About this userscript</div>
      <div class="gm-about-text">
        <strong>HLS/DASH Video Downloader</strong> watches network requests for streaming manifests
        and lets you download the main video track with a single click.
      </div>
      <div class="gm-about-text">
        Need help? Check the project README or report issues on the repository.
      </div>
      <div class="gm-about-text">
        <a href="https://github.com/marco-jardim/tm-hls-dash-downloader" target="_blank" rel="noopener noreferrer" style="color:#8fd7ff;">Open repository ↗</a>
      </div>
      <div class="gm-about-text">
        Tip: drag this window, collapse it, or refresh detections if a video loads late.
      </div>
      <div style="display:flex;justify-content:flex-end;">
        <button class="gm-btn" data-action="close-about">Close</button>
      </div>
    `;

    container.appendChild(header);
    container.appendChild(body);
    container.appendChild(footer);
    container.appendChild(aboutCard);
    document.body.appendChild(container);

    aboutCard.addEventListener('click', () => toggleAbout(false));

    ui.container = container;
    ui.body = body;
    ui.list = body.querySelector('#gm-videos-list');
    ui.stats = body.querySelector('#gm-downloader-stats');
    ui.selectAll = body.querySelector('#gm-select-all');
    ui.downloadSelected = body.querySelector('[data-action="download-selected"]');
    ui.downloadAll = body.querySelector('[data-action="download-all"]');
    ui.collapseBtn = header.querySelector('[data-action="collapse"]');
    ui.aboutPanel = aboutCard;
    ui.aboutToggle = header.querySelector('[data-action="about"]');

    restorePosition();
    applyCollapsedState();

    header.addEventListener('mousedown', startDrag);
    document.addEventListener('mouseup', stopDrag);
    document.addEventListener('mousemove', onDrag);

    container.addEventListener('click', handlePanelClick, true);
    ui.selectAll.addEventListener('change', onSelectAllToggle);

    window.addEventListener('resize', ensureOnScreen);
  }

  function restorePosition() {
    requestAnimationFrame(() => {
      const { position } = uiState;
      const rect = ui.container.getBoundingClientRect();
      const maxX = Math.max(window.innerWidth - rect.width - 12, 12);
      const maxY = Math.max(window.innerHeight - rect.height - 12, 12);
      if (position && typeof position.x === 'number' && typeof position.y === 'number') {
        ui.container.style.left = clamp(position.x, 12, maxX) + 'px';
        ui.container.style.top = clamp(position.y, 12, maxY) + 'px';
        ui.container.style.right = 'auto';
      } else {
        ui.container.style.top = '20px';
        const defaultLeft = clamp(window.innerWidth - rect.width - 32, 12, window.innerWidth - rect.width - 12);
        ui.container.style.left = defaultLeft + 'px';
        ui.container.style.right = 'auto';
      }
    });
  }

  function applyCollapsedState() {
    if (!ui.container) return;
    if (uiState.collapsed) {
      ui.container.classList.add('collapsed');
      ui.collapseBtn.textContent = '▴';
      ui.collapseBtn.title = 'Expand panel';
    } else {
      ui.container.classList.remove('collapsed');
      ui.collapseBtn.textContent = '▾';
      ui.collapseBtn.title = 'Collapse panel';
    }
  }

  let dragData = null;

  function startDrag(event) {
    if (!ui.container || event.button !== 0) return;
    const target = event.target;
    if (target.closest('.gm-btn')) return;
    const rect = ui.container.getBoundingClientRect();
    dragData = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
  }

  function onDrag(event) {
    if (!dragData || !ui.container) return;
    event.preventDefault();
    const rect = ui.container.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 12;
    const maxY = window.innerHeight - rect.height - 12;
    const nextX = clamp(event.clientX - dragData.offsetX, 12, Math.max(maxX, 12));
    const nextY = clamp(event.clientY - dragData.offsetY, 12, Math.max(maxY, 12));
    ui.container.style.left = nextX + 'px';
    ui.container.style.top = nextY + 'px';
  }

  function stopDrag() {
    if (!dragData || !ui.container) return;
    const rect = ui.container.getBoundingClientRect();
    saveState({ position: { x: rect.left, y: rect.top } });
    dragData = null;
  }

  function ensureOnScreen() {
    if (!ui.container) return;
    const rect = ui.container.getBoundingClientRect();
    const maxX = Math.max(window.innerWidth - rect.width - 12, 12);
    const maxY = Math.max(window.innerHeight - rect.height - 12, 12);
    const x = clamp(rect.left, 12, maxX);
    const y = clamp(rect.top, 12, maxY);
    ui.container.style.left = x + 'px';
    ui.container.style.top = y + 'px';
    saveState({ position: { x, y } });
  }

  function handlePanelClick(event) {
    if (!(event.target instanceof Element)) return;
    const action = event.target.getAttribute('data-action');
    if (!action) return;
    if (action === 'collapse') {
      event.preventDefault();
      saveState({ collapsed: !uiState.collapsed });
      applyCollapsedState();
      return;
    }
    if (action === 'about') {
      event.preventDefault();
      toggleAbout(true);
      return;
    }
    if (action === 'close-about') {
      event.preventDefault();
      toggleAbout(false);
      return;
    }
    if (action === 'refresh') {
      event.preventDefault();
      rescanResources();
      return;
    }
    if (action === 'download-selected') {
      event.preventDefault();
      queueBatchDownload(videos.filter(v => v.selected && !v.dismissed));
      return;
    }
    if (action === 'download-all') {
      event.preventDefault();
      queueBatchDownload(videos.filter(v => !v.dismissed));
      return;
    }
    if (action === 'download-single') {
      event.preventDefault();
      const id = event.target.getAttribute('data-id');
      const video = id ? videoLookup.get(id) : null;
      if (video) {
        startDownload(video);
      }
      return;
    }
    if (action === 'dismiss-video') {
      event.preventDefault();
      const id = event.target.getAttribute('data-id');
      const video = id ? videoLookup.get(id) : null;
      if (video) {
        video.dismissed = true;
        updateUI();
      }
      return;
    }
  }

  function toggleAbout(visible) {
    if (!ui.aboutPanel) return;
    if (visible) {
      ui.aboutPanel.classList.add('visible');
    } else {
      ui.aboutPanel.classList.remove('visible');
    }
  }

  function onSelectAllToggle(event) {
    const checked = Boolean(event.target.checked);
    videos.forEach(video => {
      if (!video.dismissed) {
        video.selected = checked;
        if (video.elements && video.elements.checkbox) {
          video.elements.checkbox.checked = checked;
        }
      }
    });
  }

  function updateUI() {
    if (!ui.list) return;
    ui.list.textContent = '';
    const visibleVideos = videos.filter(v => !v.dismissed);
    if (visibleVideos.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'gm-empty-state';
      if (ignoredManifests.size > 0) {
        empty.innerHTML = `No download-worthy streams detected.<br/>Hidden sources: ${ignoredManifests.size}. Use Refresh if needed.`;
      } else {
        empty.textContent = 'No videos detected yet. Start playback or refresh detection.';
      }
      ui.list.appendChild(empty);
    } else {
      visibleVideos.forEach(video => {
        const card = renderVideoCard(video);
        ui.list.appendChild(card);
      });
    }
    updateStats();
    syncSelectAllState();
  }

  function renderVideoCard(video) {
    const card = document.createElement('div');
    card.className = 'gm-video-card';
    card.dataset.id = String(video.id);

    const header = document.createElement('div');
    header.className = 'gm-video-header';

    const main = document.createElement('div');
    main.className = 'gm-video-main';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = video.selected;
    checkbox.addEventListener('change', () => {
      video.selected = checkbox.checked;
      syncSelectAllState();
    });

    const checkboxWrapper = document.createElement('label');
    checkboxWrapper.className = 'gm-checkbox-wrapper';
    checkboxWrapper.appendChild(checkbox);

    const info = document.createElement('div');
    info.className = 'gm-video-info';
    const titleEl = document.createElement('div');
    titleEl.className = 'gm-video-title';
    titleEl.textContent = video.title;
    info.appendChild(titleEl);

    const metaEl = document.createElement('div');
    metaEl.className = 'gm-video-meta';
    metaEl.textContent = buildMetaLine(video);
    info.appendChild(metaEl);

    main.appendChild(checkboxWrapper);
    main.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'gm-video-actions';

    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'gm-btn';
    downloadBtn.textContent = video.status === 'downloading' ? 'Downloading…' : 'Download';
    downloadBtn.disabled = video.status === 'downloading';
    downloadBtn.setAttribute('data-action', 'download-single');
    downloadBtn.setAttribute('data-id', String(video.id));

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'gm-btn';
    dismissBtn.style.background = 'rgba(255,255,255,0.08)';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.setAttribute('data-action', 'dismiss-video');
    dismissBtn.setAttribute('data-id', String(video.id));

    actions.appendChild(downloadBtn);
    actions.appendChild(dismissBtn);

    header.appendChild(main);
    header.appendChild(actions);

    const progressShell = document.createElement('div');
    progressShell.className = 'gm-progress-shell';
    const progressBar = document.createElement('div');
    progressBar.className = 'gm-progress-bar';
    progressBar.style.width = video.progressPercent ? video.progressPercent + '%' : '0%';
    progressShell.appendChild(progressBar);

    const progressText = document.createElement('div');
    progressText.className = 'gm-progress-text';
    progressText.textContent = buildProgressText(video);

    card.appendChild(header);
    card.appendChild(progressShell);
    card.appendChild(progressText);

    video.elements = {
      card,
      checkbox,
      downloadBtn,
      dismissBtn,
      metaEl,
      progressBar,
      progressText
    };

    if (video.status === 'downloaded') {
      card.classList.add('gm-dismissed');
    }

    return card;
  }

  function buildMetaLine(video) {
    const parts = [];
    parts.push(video.type.toUpperCase());
    if (video.host) parts.push(video.host);
    parts.push(`${video.totalSegments} segments`);
    if (typeof video.totalDuration === 'number') {
      parts.push(formatDuration(video.totalDuration));
    }
    if (typeof video.estimatedSizeBytes === 'number') {
      parts.push(`≈ ${formatBytes(video.estimatedSizeBytes)}`);
    }
    const variantDetails = formatVariantInfo(video.variantInfo);
    if (variantDetails) {
      parts.push(variantDetails);
    }
    return parts.join(' · ');
  }

  function buildProgressText(video) {
    if (video.status === 'downloading') {
      const segCount = `${video.downloadedSegments}/${video.totalSegments} segments`;
      const percent = `${Math.floor(video.progressPercent || 0)}%`;
      const size = video.downloadedBytes ? `${formatBytes(video.downloadedBytes)}${video.estimatedSizeBytes ? ' / ' + formatBytes(video.estimatedSizeBytes) : ''}` : '';
      return [segCount, percent, size].filter(Boolean).join(' · ');
    }
    if (video.status === 'downloaded') {
      return `Completed ${video.completedAt ? timeAgo(video.completedAt) : 'recently'}`;
    }
    if (video.status === 'error') {
      return `Download failed: ${video.lastError || 'unknown error'}`;
    }
    return 'Ready to download';
  }

  function updateStats() {
    if (!ui.stats) return;
    const visible = videos.filter(v => !v.dismissed);
    if (visible.length === 0) {
      ui.stats.textContent = 'Waiting for video streams…';
      return;
    }
    const downloading = visible.filter(v => v.status === 'downloading').length;
    const completed = visible.filter(v => v.status === 'downloaded').length;
    ui.stats.textContent = `${visible.length} stream${visible.length > 1 ? 's' : ''} detected · ${downloading} active · ${completed} complete`;
  }

  function syncSelectAllState() {
    if (!ui.selectAll) return;
    const selectable = videos.filter(v => !v.dismissed);
    if (selectable.length === 0) {
      ui.selectAll.checked = false;
      ui.selectAll.indeterminate = false;
      return;
    }
    const selectedCount = selectable.filter(v => v.selected).length;
    ui.selectAll.checked = selectedCount === selectable.length;
    ui.selectAll.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
  }

  function updateVideoUI(video) {
    if (!video.elements) return;
    if (video.elements.downloadBtn) {
      video.elements.downloadBtn.textContent = video.status === 'downloading' ? 'Downloading…' : 'Download';
      video.elements.downloadBtn.disabled = video.status === 'downloading';
    }
    if (video.elements.metaEl) {
      video.elements.metaEl.textContent = buildMetaLine(video);
    }
    if (video.elements.progressBar) {
      const width = Math.min(100, Math.max(0, video.progressPercent || 0));
      video.elements.progressBar.style.width = width + '%';
    }
    if (video.elements.progressText) {
      video.elements.progressText.textContent = buildProgressText(video);
    }
    if (video.elements.card) {
      video.elements.card.classList.toggle('gm-dismissed', video.status === 'downloaded');
    }
  }

  function formatBytes(bytes) {
    if (!bytes || !Number.isFinite(bytes)) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index++;
    }
    return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function formatDuration(seconds) {
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) {
      return `${h}h ${m}m`;
    }
    if (m > 0) {
      return `${m}m ${sec}s`;
    }
    return `${sec}s`;
  }

  function formatVariantInfo(info) {
    if (!info) return '';
    const parts = [];
    if (info.name) parts.push(info.name);
    if (info.resolution) parts.push(info.resolution);
    const bandwidth = info.bandwidth || info.averageBandwidth;
    if (Number.isFinite(bandwidth) && bandwidth > 0) {
      const kbps = Math.round(bandwidth / 1000);
      parts.push(`${kbps} kbps`);
    }
    if (info.frameRate) {
      parts.push(`${info.frameRate} fps`);
    }
    if (info.codecs && parts.length < 3) {
      parts.push(info.codecs);
    }
    return parts.join(' · ');
  }

  function timeAgo(date) {
    const diff = Date.now() - date.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  function shouldIgnoreManifest(url, segments) {
    const lower = url.toLowerCase();
    if (BLACKLIST_TOKENS.some(token => lower.includes(token))) {
      return true;
    }
    if (!segments || segments.length === 0) return true;
    const segUrl = getFirstSegmentUrl(segments);
    if (segUrl) {
      const lowerSeg = segUrl.toLowerCase();
      if (SEGMENT_BLACKLIST_EXT.some(ext => lowerSeg.endsWith(ext))) return true;
    }
    const audioish = AUDIO_HINT_TOKENS.some(token => lower.includes(token)) || (segUrl && AUDIO_HINT_TOKENS.some(token => segUrl.toLowerCase().includes(token)));
    const videoish = VIDEO_HINT_TOKENS.some(token => lower.includes(token)) || (segUrl && VIDEO_HINT_TOKENS.some(token => segUrl.toLowerCase().includes(token)));
    if (audioish && !videoish) {
      return true;
    }
    return false;
  }

  function getFirstSegmentUrl(segments) {
    for (const segment of segments) {
      if (!segment) continue;
      if (typeof segment === 'string') return segment;
      if (segment.url) return segment.url;
    }
    return '';
  }

  function ensureVideoEntry(details) {
    const existing = videoLookup.get(String(details.id));
    if (existing) {
      Object.assign(existing, details);
      updateVideoUI(existing);
      return existing;
    }
    videos.push(details);
    videoLookup.set(String(details.id), details);
    return details;
  }

  function handleManifest(url) {
    if (manifestUrls.has(url) || ignoredManifests.has(url)) return;
    manifestUrls.add(url);
    const lower = url.toLowerCase();
    const type = lower.includes('.m3u8') ? 'hls' : (lower.includes('.mpd') ? 'dash' : null);
    if (!type) return;
    const parserPromise = type === 'hls' ? parseHlsManifest(url, new Set()) : parseDashManifest(url);
    parserPromise.then(result => {
      if (!result || !result.segments || result.segments.length === 0) return;
      if (shouldIgnoreManifest(url, result.segments)) {
        ignoredManifests.add(url);
        return;
      }
      const title = deriveTitle(url, result.metadata && result.metadata.nameHint);
      const host = extractHost(url);
      const id = String(idCounter++);
      const video = ensureVideoEntry({
        id,
        manifestUrl: url,
        type,
        title,
        host,
        segments: result.segments,
        totalSegments: result.segments.length,
        totalDuration: result.metadata.totalDuration || null,
        variantInfo: result.metadata.variantInfo || null,
        estimatedSizeBytes: null,
        downloadedSegments: 0,
        downloadedBytes: 0,
        progressPercent: 0,
        status: 'idle',
        selected: true,
        dismissed: false,
        createdAt: new Date()
      });
      updateUI();
      enrichMetadata(video).catch(err => console.warn('Metadata enrichment failed', err));
    }).catch(err => {
      console.error('Failed to parse manifest', url, err);
    });
  }

  function deriveTitle(url, nameHint) {
    if (nameHint) return nameHint;
    const docTitle = document.title || '';
    if (docTitle) return docTitle;
    try {
      const parsed = new URL(url);
      return parsed.pathname.split('/').pop() || 'Video stream';
    } catch (err) {
      return 'Video stream';
    }
  }

  function extractHost(url) {
    try {
      const parsed = new URL(url);
      return parsed.host;
    } catch (err) {
      return null;
    }
  }

  async function enrichMetadata(video) {
    if (!video || !video.segments || video.segments.length === 0) return;
    try {
      const estimate = await estimateSize(video);
      if (estimate) {
        video.estimatedSizeBytes = estimate;
      }
    } catch (err) {
      console.warn('Size estimation failed', err);
    }
    updateVideoUI(video);
  }

  async function estimateSize(video) {
    const sampleCount = Math.min(3, video.segments.length);
    let total = 0;
    let successful = 0;
    for (let i = 0; i < sampleCount; i++) {
      const segIndex = Math.floor((i / sampleCount) * video.segments.length);
      const segment = video.segments[segIndex];
      const url = typeof segment === 'string' ? segment : segment.url;
      if (!url) continue;
      try {
        const response = await GM_fetch(url, { method: 'HEAD' });
        const lengthHeader = response && response.headers ? getHeader(response.headers, 'content-length') : null;
        const size = lengthHeader ? parseInt(lengthHeader, 10) : NaN;
        if (Number.isFinite(size) && size > 0) {
          total += size;
          successful++;
        }
      } catch (err) {
        console.debug('HEAD request failed for segment', err);
      }
    }
    if (successful === 0) return null;
    const avg = total / successful;
    return Math.round(avg * video.totalSegments);
  }

  function getHeader(headers, key) {
    if (!headers) return null;
    if (typeof headers.get === 'function') {
      const value = headers.get(key);
      return value != null ? value : headers.get(key.toLowerCase());
    }
    if (headers[key]) return headers[key];
    const lowerKey = key.toLowerCase();
    return headers[lowerKey] || null;
  }

  async function queueBatchDownload(list) {
    if (!list || list.length === 0) return;
    const queue = list.filter(video => video.status !== 'downloading');
    if (queue.length === 0) return;
    const statusEl = document.getElementById('gm-batch-status');
    if (statusEl) {
      statusEl.textContent = `Batch downloading ${queue.length} stream${queue.length > 1 ? 's' : ''}…`;
    }
    for (const video of queue) {
      // eslint-disable-next-line no-await-in-loop
      await startDownload(video);
    }
    if (statusEl) {
      statusEl.textContent = 'Batch complete';
      setTimeout(() => {
        statusEl.textContent = '';
      }, 3000);
    }
  }

  async function startDownload(video) {
    if (!video || !video.segments || video.segments.length === 0) return;
    if (video.status === 'downloading') return;
    video.status = 'downloading';
    video.downloadedSegments = 0;
    video.downloadedBytes = 0;
    video.progressPercent = 0;
    updateVideoUI(video);

    const buffers = [];
    const total = video.totalSegments;

    for (let index = 0; index < total; index++) {
      const segment = video.segments[index];
      const segUrl = typeof segment === 'string' ? segment : segment.url;
      try {
        const response = await GM_fetch(segUrl, { method: 'GET', responseType: 'arraybuffer' });
        if (!response || response.status >= 400) {
          throw new Error(`HTTP ${response ? response.status : 'unknown'}`);
        }
        const buf = await response.arrayBuffer();
        buffers.push(buf);
        video.downloadedSegments++;
        const bytes = buf.byteLength || 0;
        video.downloadedBytes += bytes;
        video.progressPercent = (video.downloadedSegments / total) * 100;
        updateVideoUI(video);
      } catch (err) {
        video.status = 'error';
        video.lastError = err && err.message ? err.message : String(err);
        console.error('Failed to download segment', segUrl, err);
        updateVideoUI(video);
        return;
      }
    }

    const blob = new Blob(buffers, { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    const safeTitle = buildFileName(video.title);
    try {
      if (typeof GM_download === 'function') {
        GM_download({ url: blobUrl, name: safeTitle });
      } else {
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = safeTitle;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
      video.status = 'downloaded';
      video.completedAt = new Date();
      video.progressPercent = 100;
    } finally {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      updateVideoUI(video);
    }
  }

  function buildFileName(title) {
    const safeBase = title.replace(/[^a-z0-9\-_.]/gi, '_').slice(0, 80) || 'video';
    return `${safeBase}.mp4`;
  }

  async function parseHlsManifest(url, visited = new Set()) {
    if (visited.has(url)) {
      return { segments: [], metadata: {} };
    }
    visited.add(url);

    let text;
    try {
      const response = await GM_fetch(url, { method: 'GET', responseType: 'text' });
      text = await response.text();
    } catch (err) {
      console.warn('Failed to fetch HLS manifest', url, err);
      return { segments: [], metadata: {} };
    }

    const segments = [];
    const variants = [];
    const lines = text.split(/\r?\n/);
    let pendingDuration = null;
    let totalDuration = 0;
    let nameHint = null;
    let pendingVariantAttrs = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-MEDIA')) {
        const attrs = parseAttributeList(line.split(':')[1] || '');
        if (!nameHint && attrs.NAME) {
          nameHint = attrs.NAME;
        }
        continue;
      }
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        pendingVariantAttrs = parseAttributeList(line.split(':')[1] || '');
        continue;
      }
      if (pendingVariantAttrs) {
        if (!line.startsWith('#')) {
          const absoluteVariant = makeAbsoluteUrl(line, url);
          variants.push({
            url: absoluteVariant,
            info: normalizeVariantInfo(pendingVariantAttrs)
          });
        }
        pendingVariantAttrs = null;
        continue;
      }
      if (line.startsWith('#EXTINF')) {
        const match = line.match(/#EXTINF:([^,]+)/);
        if (match) {
          const durationValue = parseFloat(match[1]);
          pendingDuration = Number.isFinite(durationValue) ? durationValue : null;
        }
        continue;
      }
      if (line.startsWith('#EXT-X-TARGETDURATION') || line.startsWith('#EXT-X-VERSION') || line.startsWith('#EXT-X-ENDLIST') || line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
        continue;
      }
      if (line.startsWith('#')) {
        continue;
      }
      const absoluteSegment = makeAbsoluteUrl(line, url);
      segments.push({ url: absoluteSegment, duration: pendingDuration });
      if (pendingDuration) totalDuration += pendingDuration;
      pendingDuration = null;
    }

    if (segments.length === 0 && variants.length > 0) {
      const chosen = pickBestVariant(variants);
      if (!chosen) {
        return {
          segments: [],
          metadata: {
            nameHint: nameHint || null,
            variantInfo: null
          }
        };
      }
      const nested = await parseHlsManifest(chosen.url, visited);
      const nestedMeta = Object.assign({}, nested.metadata || {});
      const mergedVariant = Object.assign({}, nestedMeta.variantInfo || {}, chosen.info || {});
      if (Object.keys(mergedVariant).length > 0) {
        nestedMeta.variantInfo = mergedVariant;
      }
      if (!nestedMeta.nameHint) {
        nestedMeta.nameHint = (chosen.info && chosen.info.name) || nameHint || null;
      }
      return {
        segments: nested.segments,
        metadata: nestedMeta
      };
    }

    return {
      segments,
      metadata: {
        totalDuration: totalDuration || null,
        nameHint: nameHint || null,
        variantInfo: null
      }
    };
  }

  function parseAttributeList(raw) {
    const attrs = {};
    if (!raw) return attrs;
    raw.split(',').forEach(entry => {
      const [key, value] = entry.split('=');
      if (!key || value == null) return;
      const cleanedKey = key.trim().toUpperCase();
      const cleanedValue = value.trim().replace(/^"|"$/g, '');
      if (cleanedKey) {
        attrs[cleanedKey] = cleanedValue;
      }
    });
    return attrs;
  }

  function normalizeVariantInfo(attrs) {
    const info = {};
    if (!attrs) return info;
    if (attrs.NAME) info.name = attrs.NAME;
    const bandwidth = parseInt(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'], 10);
    if (Number.isFinite(bandwidth)) info.bandwidth = bandwidth;
    const average = parseInt(attrs['AVERAGE-BANDWIDTH'], 10);
    if (Number.isFinite(average)) info.averageBandwidth = average;
    if (attrs.RESOLUTION) info.resolution = attrs.RESOLUTION;
    if (attrs['FRAME-RATE']) info.frameRate = attrs['FRAME-RATE'];
    if (attrs.CODECS) info.codecs = attrs.CODECS;
    if (attrs['VIDEO-RANGE']) info.videoRange = attrs['VIDEO-RANGE'];
    return info;
  }

  function pickBestVariant(variants) {
    if (!variants || variants.length === 0) return null;
    const ranked = variants.slice().sort((a, b) => {
      const bwA = (a.info && a.info.bandwidth) || 0;
      const bwB = (b.info && b.info.bandwidth) || 0;
      if (bwA !== bwB) return bwB - bwA;
      const resA = resolutionScore(a.info && a.info.resolution);
      const resB = resolutionScore(b.info && b.info.resolution);
      if (resA !== resB) return resB - resA;
      return 0;
    });
    return ranked[0];
  }

  function resolutionScore(resolution) {
    if (!resolution) return 0;
    const match = resolution.match(/(\d+)\s*[xX]\s*(\d+)/);
    if (!match) return 0;
    const width = parseInt(match[1], 10);
    const height = parseInt(match[2], 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;
    return width * height;
  }

  function makeAbsoluteUrl(ref, baseUrl) {
    try {
      return new URL(ref, baseUrl).href;
    } catch (err) {
      if (typeof ref === 'string' && ref.startsWith('//')) {
        const protocol = (typeof location !== 'undefined' && location.protocol) ? location.protocol : 'https:';
        return protocol + ref;
      }
      return ref;
    }
  }

  async function parseDashManifest(url) {
    const response = await GM_fetch(url, { method: 'GET', responseType: 'text' });
    const text = await response.text();
    const root = url.slice(0, url.lastIndexOf('/') + 1);
    const segments = [];
    const mediaRegex = /media="([^"]+)"/gi;
    const durationRegex = /duration="PT([0-9HMS\.]+)"/i;
    let match;
    while ((match = mediaRegex.exec(text)) !== null) {
      const seg = match[1];
      if (/init/i.test(seg)) continue;
      const absolute = /^https?:\/\//i.test(seg) ? seg : root + seg;
      segments.push({ url: absolute, duration: null });
    }
    const durationMatch = durationRegex.exec(text);
    const totalDuration = durationMatch ? parseIsoDuration(durationMatch[1]) : null;
    const nameHint = deriveDashName(text) || null;
    return {
      segments,
      metadata: {
        totalDuration,
        nameHint
      }
    };
  }

  function parseIsoDuration(iso) {
    if (!iso) return null;
    const regex = /(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
    const match = regex.exec(iso);
    if (!match) return null;
    const hours = match[1] ? parseInt(match[1], 10) : 0;
    const minutes = match[2] ? parseInt(match[2], 10) : 0;
    const seconds = match[3] ? parseFloat(match[3]) : 0;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function deriveDashName(manifestText) {
    const titleMatch = manifestText.match(/<Title>([^<]+)<\/Title>/i);
    if (titleMatch) return titleMatch[1];
    const repMatch = manifestText.match(/id="([^"]+)"/i);
    if (repMatch) return repMatch[1];
    return null;
  }

  const origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    try {
      if (url && (url.match(/\.m3u8(\?|$)/i) || url.match(/\.mpd(\?|$)/i))) {
        handleManifest(url);
      }
    } catch (err) {
      console.error(err);
    }
    return origXHROpen.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = function(resource, init) {
    try {
      const url = typeof resource === 'string' ? resource : (resource && resource.url);
      if (url && (url.match(/\.m3u8(\?|$)/i) || url.match(/\.mpd(\?|$)/i))) {
        handleManifest(url);
      }
    } catch (err) {
      console.error(err);
    }
    return origFetch.apply(this, arguments);
  };

  function rescanResources() {
    try {
      const resources = performance.getEntriesByType('resource') || [];
      resources.forEach(entry => {
        if (entry.name && (entry.name.includes('.m3u8') || entry.name.includes('.mpd'))) {
          handleManifest(entry.name);
        }
      });
    } catch (err) {
      console.warn('Resource performance scan failed', err);
    }
  }

  function GM_fetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      const method = (options.method || 'GET').toUpperCase();
      const responseType = options.responseType || (method === 'HEAD' ? 'text' : 'arraybuffer');
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest(Object.assign({}, options, {
          method,
          url,
          responseType,
          onload: function(response) {
            const headers = parseHeaders(response.responseHeaders || '');
            const arrayBuffer = async () => {
              if (method === 'HEAD') return new ArrayBuffer(0);
              if (response.response instanceof ArrayBuffer) return response.response;
              return new TextEncoder().encode(response.responseText || '').buffer;
            };
            const text = async () => {
              if (response.responseText != null) return response.responseText;
              if (response.response instanceof ArrayBuffer) {
                return new TextDecoder().decode(response.response);
              }
              return '';
            };
            resolve({
              ok: response.status >= 200 && response.status < 300,
              status: response.status,
              headers,
              arrayBuffer,
              text
            });
          },
          onerror: function(err) { reject(err); }
        }));
      } else {
        fetch(url, Object.assign({}, options, { method })).then(resp => {
          resolve({
            ok: resp.ok,
            status: resp.status,
            headers: resp.headers,
            arrayBuffer: () => resp.arrayBuffer(),
            text: () => resp.text()
          });
        }).catch(reject);
      }
    });
  }

  function parseHeaders(raw) {
    const headers = {};
    raw.split(/\r?\n/).forEach(line => {
      if (!line) return;
      const index = line.indexOf(':');
      if (index === -1) return;
      const key = line.slice(0, index).trim().toLowerCase();
      const value = line.slice(index + 1).trim();
      headers[key] = value;
    });
    return {
      get(name) {
        if (!name) return null;
        return headers[name.toLowerCase()] || null;
      }
    };
  }

  function onReady() {
    createUI();
    rescanResources();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    onReady();
  } else {
    document.addEventListener('DOMContentLoaded', onReady);
  }
})();
