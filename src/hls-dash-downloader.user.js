// ==UserScript==
// @name         HLS/DASH Video Downloader
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Detects and downloads HLS (.m3u8) and DASH (.mpd) streams with a rich, draggable control panel.
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';

  let isTopWindow = true;
  let canAccessTop = true;
  try {
    isTopWindow = window.top === window.self;
  } catch (err) {
    isTopWindow = false;
    canAccessTop = false;
  }
  if (!isTopWindow && !canAccessTop) {
    return;
  }

  const CHILD_MANIFEST_MESSAGE = 'tm-hlsdash:manifest';
  const forwardedManifestUrls = new Set();

  const manifestUrls = new Set();
  const videos = [];
  const videoLookup = new Map();
  const directUrlLookup = new Map();
  const ignoredManifests = new Set();
  let idCounter = 1;

  const UI_STATE_KEY = 'tmHlsDashDownloaderUiState';
  const DEFAULT_STATE = {
    position: { x: null, y: null },
    collapsed: false,
    hidden: false
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
  const YT_MANIFEST_PATTERN = /manifest\.googlevideo\.com\/api\/manifest\/(dash|hls)/i;
  const YT_HOST_PATTERN = /(^|\.)youtube\.com$/i;
  const isYouTubeDomain = typeof location !== 'undefined' && location.hostname ? YT_HOST_PATTERN.test(location.hostname) : false;

  function isManifestUrl(url) {
    if (!url) return false;
    const lower = String(url).toLowerCase();
    if (lower.includes('.m3u8') || lower.includes('.mpd')) return true;
    if (YT_MANIFEST_PATTERN.test(lower)) return true;
    return false;
  }

  function inferManifestType(url) {
    if (!url) return null;
    const lower = String(url).toLowerCase();
    if (lower.includes('.m3u8')) return 'hls';
    if (lower.includes('.mpd')) return 'dash';
    if (YT_MANIFEST_PATTERN.test(lower)) {
      return lower.includes('/hls') ? 'hls' : 'dash';
    }
    const mimeMatch = lower.match(/[?&]mime=([^&]+)/);
    if (mimeMatch) {
      try {
        const mime = decodeURIComponent(mimeMatch[1]).toLowerCase();
        if (mime.includes('mpegurl') || mime.includes('hls')) return 'hls';
        if (mime.includes('dash') || mime.includes('mpd') || mime.includes('mp4')) return 'dash';
      } catch (err) {
        console.warn('Failed to decode mime from manifest URL', url, err);
      }
    }
    return null;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(UI_STATE_KEY);
      if (!raw) return { ...DEFAULT_STATE };
      const parsed = JSON.parse(raw);
      return {
        position: parsed.position || { ...DEFAULT_STATE.position },
        collapsed: Boolean(parsed.collapsed),
        hidden: Boolean(parsed.hidden)
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
      /* Force the panel to be in the root stacking context */
      html, body {
        position: relative !important;
      }

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
        z-index: 2147483647 !important;
        backdrop-filter: blur(6px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        user-select: none;
        isolation: isolate;
        will-change: transform;
        transform: translateZ(0);
        pointer-events: auto;
      }

      /* Ensure visibility in fullscreen mode */
      html:fullscreen .gm-downloader-panel,
      html:-webkit-full-screen .gm-downloader-panel,
      html:-moz-full-screen .gm-downloader-panel,
      html:-ms-fullscreen .gm-downloader-panel {
        z-index: 2147483647 !important;
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
      .gm-btn.gm-icon-btn {
        width: 30px;
        height: 30px;
        border-radius: 50%;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
      }
      .gm-btn.gm-icon-btn[data-role="download"] {
        background: rgba(102, 224, 255, 0.18);
      }
      .gm-btn.gm-icon-btn[data-role="cancel"] {
        background: rgba(255, 99, 71, 0.25);
      }
      .gm-btn.gm-icon-btn[data-role="dismiss"] {
        background: rgba(255, 255, 255, 0.12);
      }
      .gm-btn.gm-icon-btn[data-role="download"]:hover {
        background: rgba(102, 224, 255, 0.28);
      }
      .gm-btn.gm-icon-btn[data-role="cancel"]:hover {
        background: rgba(255, 99, 71, 0.35);
      }
      .gm-btn.gm-icon-btn[data-role="dismiss"]:hover {
        background: rgba(255, 255, 255, 0.2);
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
        z-index: 10;
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
    if (ui.container) {
      if (document.body && !document.body.contains(ui.container)) {
        document.body.appendChild(ui.container);
        updateUI();
      }
      return;
    }
    if (!document.body) return;

    if (uiState.hidden) {
      saveState({ hidden: false });
    }

    injectStyles();

    const container = document.createElement('div');
    container.id = 'gm-video-downloader';
    container.className = 'gm-downloader-panel';

    // Create header
    const header = document.createElement('div');
    header.className = 'gm-downloader-header';

    const titleBlock = document.createElement('div');
    titleBlock.className = 'gm-title-block';

    const title = document.createElement('span');
    title.className = 'gm-title';
    title.textContent = 'Stream Downloader';
    titleBlock.appendChild(title);

    const subtitle = document.createElement('span');
    subtitle.className = 'gm-subtitle';
    subtitle.textContent = 'HLS / DASH manifest watcher';
    titleBlock.appendChild(subtitle);

    const headerActions = document.createElement('div');
    headerActions.className = 'gm-header-actions';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'gm-btn gm-btn-icon';
    closeBtn.setAttribute('data-action', 'close-panel');
    closeBtn.title = 'Close panel';
    closeBtn.textContent = '✕';
    headerActions.appendChild(closeBtn);

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'gm-btn gm-btn-icon';
    refreshBtn.setAttribute('data-action', 'refresh');
    refreshBtn.title = 'Rescan for new manifests';
    refreshBtn.textContent = '⟳';
    headerActions.appendChild(refreshBtn);

    const aboutBtn = document.createElement('button');
    aboutBtn.className = 'gm-btn gm-btn-icon';
    aboutBtn.setAttribute('data-action', 'about');
    aboutBtn.title = 'About & help';
    aboutBtn.textContent = '?';
    headerActions.appendChild(aboutBtn);

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'gm-btn gm-btn-icon';
    collapseBtn.setAttribute('data-action', 'collapse');
    collapseBtn.title = 'Collapse panel';
    collapseBtn.textContent = '▾';
    headerActions.appendChild(collapseBtn);

    header.appendChild(titleBlock);
    header.appendChild(headerActions);

    // Create body
    const body = document.createElement('div');
    body.className = 'gm-downloader-body';

    const toolbar = document.createElement('div');
    toolbar.className = 'gm-toolbar';

    const toolbarLeft = document.createElement('div');
    toolbarLeft.className = 'gm-toolbar-left';

    const checkboxWrapper = document.createElement('label');
    checkboxWrapper.className = 'gm-checkbox-wrapper';

    const selectAllCheckbox = document.createElement('input');
    selectAllCheckbox.type = 'checkbox';
    selectAllCheckbox.id = 'gm-select-all';
    checkboxWrapper.appendChild(selectAllCheckbox);

    const selectAllLabel = document.createElement('span');
    selectAllLabel.textContent = 'Select all';
    checkboxWrapper.appendChild(selectAllLabel);

    toolbarLeft.appendChild(checkboxWrapper);

    const toolbarRight = document.createElement('div');
    toolbarRight.className = 'gm-toolbar-right';

    const downloadSelectedBtn = document.createElement('button');
    downloadSelectedBtn.className = 'gm-btn';
    downloadSelectedBtn.setAttribute('data-action', 'download-selected');
    downloadSelectedBtn.textContent = 'Download Selected';
    toolbarRight.appendChild(downloadSelectedBtn);

    const downloadAllBtn = document.createElement('button');
    downloadAllBtn.className = 'gm-btn';
    downloadAllBtn.setAttribute('data-action', 'download-all');
    downloadAllBtn.textContent = 'Download All';
    toolbarRight.appendChild(downloadAllBtn);

    toolbar.appendChild(toolbarLeft);
    toolbar.appendChild(toolbarRight);

    const summary = document.createElement('div');
    summary.className = 'gm-summary';
    summary.id = 'gm-downloader-stats';
    summary.textContent = 'Detecting streams…';

    const videosList = document.createElement('div');
    videosList.className = 'gm-videos-list';
    videosList.id = 'gm-videos-list';

    body.appendChild(toolbar);
    body.appendChild(summary);
    body.appendChild(videosList);

    // Create footer
    const footer = document.createElement('div');
    footer.className = 'gm-footer-actions';

    const batchStatus = document.createElement('span');
    batchStatus.className = 'gm-batch-status';
    batchStatus.id = 'gm-batch-status';
    footer.appendChild(batchStatus);

    const refreshLink = document.createElement('button');
    refreshLink.className = 'gm-link';
    refreshLink.setAttribute('data-action', 'refresh');
    refreshLink.textContent = 'Refresh detection';
    footer.appendChild(refreshLink);

    // Create about card
    const aboutCard = document.createElement('div');
    aboutCard.className = 'gm-about-card';

    const aboutTitle = document.createElement('div');
    aboutTitle.className = 'gm-about-title';
    aboutTitle.textContent = 'About this userscript';
    aboutCard.appendChild(aboutTitle);

    const aboutText1 = document.createElement('div');
    aboutText1.className = 'gm-about-text';
    const strong = document.createElement('strong');
    strong.textContent = 'HLS/DASH Video Downloader';
    aboutText1.appendChild(strong);
    aboutText1.appendChild(document.createTextNode(' watches network requests for streaming manifests and lets you download the main video track with a single click.'));
    aboutCard.appendChild(aboutText1);

    const aboutText2 = document.createElement('div');
    aboutText2.className = 'gm-about-text';
    aboutText2.textContent = 'Need help? Check the project README or report issues on the repository.';
    aboutCard.appendChild(aboutText2);

    const aboutText3 = document.createElement('div');
    aboutText3.className = 'gm-about-text';
    const repoLink = document.createElement('a');
    repoLink.href = 'https://github.com/marco-jardim/tm-hls-dash-downloader';
    repoLink.target = '_blank';
    repoLink.rel = 'noopener noreferrer';
    repoLink.style.color = '#8fd7ff';
    repoLink.textContent = 'Open repository ↗';
    aboutText3.appendChild(repoLink);
    aboutCard.appendChild(aboutText3);

    const aboutText4 = document.createElement('div');
    aboutText4.className = 'gm-about-text';
    aboutText4.textContent = 'Tip: drag this window, collapse it, or refresh detections if a video loads late.';
    aboutCard.appendChild(aboutText4);

    const aboutActionsDiv = document.createElement('div');
    aboutActionsDiv.style.display = 'flex';
    aboutActionsDiv.style.justifyContent = 'flex-end';
    const closeAboutBtn = document.createElement('button');
    closeAboutBtn.className = 'gm-btn';
    closeAboutBtn.setAttribute('data-action', 'close-about');
    closeAboutBtn.textContent = 'Close';
    aboutActionsDiv.appendChild(closeAboutBtn);
    aboutCard.appendChild(aboutActionsDiv);

    container.appendChild(header);
    container.appendChild(body);
    container.appendChild(footer);
    container.appendChild(aboutCard);
    document.body.appendChild(container);
    observePanelContainer(container);

    aboutCard.addEventListener('click', () => toggleAbout(false));

    ui.container = container;
    ui.body = body;
    ui.list = videosList;
    ui.stats = summary;
    ui.selectAll = selectAllCheckbox;
    ui.downloadSelected = downloadSelectedBtn;
    ui.downloadAll = downloadAllBtn;
    ui.collapseBtn = collapseBtn;
    ui.aboutPanel = aboutCard;
    ui.aboutToggle = aboutBtn;

    restorePosition();
    applyCollapsedState();

    header.addEventListener('mousedown', startDrag);
    document.addEventListener('mouseup', stopDrag);
    document.addEventListener('mousemove', onDrag);

    container.addEventListener('click', handlePanelClick, true);
    ui.selectAll.addEventListener('change', onSelectAllToggle);

    window.addEventListener('resize', ensureOnScreen);

    // Handle fullscreen changes
    const fullscreenEvents = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'];
    fullscreenEvents.forEach(eventName => {
      document.addEventListener(eventName, () => {
        requestAnimationFrame(() => {
          if (container && document.body && !document.body.contains(container)) {
            document.body.appendChild(container);
          }
          ensureOnScreen();
        });
      });
    });

    updateUI();
  }

  function destroyUI() {
    if (ui.panelObserver) {
      ui.panelObserver.disconnect();
      ui.panelObserver = null;
    }
    if (ui.panelCheckInterval) {
      clearInterval(ui.panelCheckInterval);
      ui.panelCheckInterval = null;
    }
    if (ui.container && ui.container.parentNode) {
      ui.container.parentNode.removeChild(ui.container);
    }
    ui.container = null;
    ui.body = null;
    ui.list = null;
    ui.stats = null;
    ui.selectAll = null;
    ui.downloadSelected = null;
    ui.downloadAll = null;
    ui.collapseBtn = null;
    ui.aboutPanel = null;
    ui.aboutToggle = null;
  }

  function observePanelContainer(container) {
    if (!document.body || !container) return;
    if (ui.panelObserver) {
      ui.panelObserver.disconnect();
    }
    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (Array.from(mutation.removedNodes || []).includes(container)) {
          requestAnimationFrame(() => {
            if (document.body && !document.body.contains(container)) {
              document.body.appendChild(container);
            }
          });
          break;
        }
      }
    });
    observer.observe(document.body, { childList: true });
    ui.panelObserver = observer;

    // Additional robustness: periodically check if panel is still in DOM
    if (ui.panelCheckInterval) {
      clearInterval(ui.panelCheckInterval);
    }
    ui.panelCheckInterval = setInterval(() => {
      if (uiState.hidden) return;
      if (container && document.body && !document.body.contains(container)) {
        document.body.appendChild(container);
      }
    }, 3000);
  }

  function ensureUIPresent() {
    if (!isTopWindow) return false;
    if (uiState.hidden) return false;
    if (!document.body) {
      if (!ensureUIPresent.bodyObserver && document.documentElement) {
        const observer = new MutationObserver(() => {
          if (document.body) {
            observer.disconnect();
            ensureUIPresent();
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        ensureUIPresent.bodyObserver = observer;
      }
      return false;
    }
    if (!ui.container || !document.body.contains(ui.container)) {
      createUI();
    }
    return Boolean(ui.container && document.body.contains(ui.container));
  }

  function restorePosition() {
    if (!ui.container) return;
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
    if (action === 'close-panel') {
      event.preventDefault();
      saveState({ hidden: true });
      destroyUI();
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
    if (action === 'cancel-download') {
      event.preventDefault();
      const id = event.target.getAttribute('data-id');
      const video = id ? videoLookup.get(id) : null;
      if (video) {
        cancelDownload(video);
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
    downloadBtn.className = 'gm-btn gm-icon-btn';
    downloadBtn.dataset.role = 'download';
    downloadBtn.setAttribute('data-action', 'download-single');
    downloadBtn.setAttribute('data-id', String(video.id));
    downloadBtn.setAttribute('aria-label', 'Download stream');
    downloadBtn.title = 'Download stream';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'gm-btn gm-icon-btn';
    cancelBtn.dataset.role = 'cancel';
    cancelBtn.setAttribute('data-action', 'cancel-download');
    cancelBtn.setAttribute('data-id', String(video.id));
    cancelBtn.setAttribute('aria-label', 'Cancel download');
    cancelBtn.title = 'Cancel download';

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'gm-btn gm-icon-btn';
    dismissBtn.dataset.role = 'dismiss';
    dismissBtn.setAttribute('data-action', 'dismiss-video');
    dismissBtn.setAttribute('data-id', String(video.id));
    dismissBtn.setAttribute('aria-label', 'Dismiss stream');
    dismissBtn.title = 'Dismiss stream';

    actions.appendChild(downloadBtn);
    actions.appendChild(cancelBtn);
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
      cancelBtn,
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
      const etaText = formatEta(video.remainingMs);
      return [segCount, percent, size, etaText ? `ETA ${etaText}` : null].filter(Boolean).join(' · ');
    }
    if (video.status === 'downloaded') {
      return `Completed ${video.completedAt ? timeAgo(video.completedAt) : 'recently'}`;
    }
    if (video.status === 'cancelled') {
      return 'Download cancelled';
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
    const downloadingVideos = visible.filter(v => v.status === 'downloading');
    const completed = visible.filter(v => v.status === 'downloaded').length;
    const statsParts = [
      `${visible.length} stream${visible.length > 1 ? 's' : ''} detected`,
      `${downloadingVideos.length} active`,
      `${completed} complete`
    ];
    if (downloadingVideos.length > 0) {
      const totalEtaMs = downloadingVideos.reduce((sum, v) => sum + (Number.isFinite(v.remainingMs) ? v.remainingMs : 0), 0);
      const etaText = formatEta(totalEtaMs);
      if (etaText) {
        statsParts.push(`ETA ${etaText}`);
      }
    }
    ui.stats.textContent = statsParts.join(' · ');
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
      video.elements.downloadBtn.textContent = video.status === 'downloading' ? '⏳' : '⭳';
      video.elements.downloadBtn.disabled = video.status === 'downloading';
      video.elements.downloadBtn.title = video.status === 'downloading' ? 'Downloading…' : 'Download stream';
    }
    if (video.elements.cancelBtn) {
      video.elements.cancelBtn.style.display = video.status === 'downloading' ? '' : 'none';
      video.elements.cancelBtn.disabled = video.status !== 'downloading';
      video.elements.cancelBtn.title = 'Cancel download';
    }
    const etaMs = computeVideoEta(video);
    video.remainingMs = etaMs;
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
    updateStats();
  }

  function computeVideoEta(video) {
    if (!video || video.status !== 'downloading') {
      return null;
    }
    if (!Number.isFinite(video.downloadStartTime)) {
      video.downloadStartTime = Date.now();
      return null;
    }
    const elapsedMs = Date.now() - video.downloadStartTime;
    if (elapsedMs <= 0) return null;

    let etaMs = null;

    if (Number.isFinite(video.downloadedSegments) && video.downloadedSegments > 0) {
      const remainingSegments = Math.max(0, (video.totalSegments || 0) - video.downloadedSegments);
      if (remainingSegments === 0) {
        etaMs = 0;
      } else {
        const avgSegmentMs = elapsedMs / video.downloadedSegments;
        if (Number.isFinite(avgSegmentMs) && avgSegmentMs > 0) {
          etaMs = avgSegmentMs * remainingSegments;
        }
      }
    }

    if (Number.isFinite(video.estimatedSizeBytes) && video.estimatedSizeBytes > 0 && video.downloadedBytes > 0) {
      const remainingBytes = Math.max(0, video.estimatedSizeBytes - video.downloadedBytes);
      if (remainingBytes === 0) {
        etaMs = etaMs != null ? Math.min(etaMs, 0) : 0;
      } else {
        const bytesPerMs = video.downloadedBytes / elapsedMs;
        if (bytesPerMs > 0) {
          const etaFromBytes = remainingBytes / bytesPerMs;
          etaMs = etaMs == null ? etaFromBytes : Math.min(etaMs, etaFromBytes);
        }
      }
    }

    if (etaMs == null) return null;
    return Math.max(0, etaMs);
  }

  function formatEta(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const totalSeconds = Math.ceil(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(' ');
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

  function decodeUnicodeEscapes(value) {
    if (typeof value !== 'string' || value.indexOf('\\u') === -1) {
      return value;
    }
    return value.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : match;
    });
  }

  function normalizeYouTubeUrl(url) {
    if (!url && url !== '') return null;
    let normalized = decodeUnicodeEscapes(String(url).trim());
    if (!normalized) return null;
    normalized = normalized.replace(/&amp;/gi, '&');
    if (normalized.startsWith('//')) {
      const protocol = (typeof location !== 'undefined' && location.protocol) ? location.protocol : 'https:';
      normalized = protocol + normalized;
    }
    return normalized;
  }

  function deduceMimeType(rawMime, url) {
    if (typeof rawMime === 'string' && rawMime.trim()) {
      const primary = rawMime.split(';')[0].trim().toLowerCase();
      if (primary) return primary;
    }
    const fromQuery = extractMimeFromQuery(url);
    if (fromQuery) return fromQuery;
    const ext = guessExtensionFromUrl(url);
    if (!ext) return null;
    if (ext === 'ts' || ext === 'm2ts') return 'video/mp2t';
    if (ext === 'mp4' || ext === 'm4s' || ext === 'm4v') return 'video/mp4';
    if (ext === 'webm') return 'video/webm';
    if (ext === 'm4a' || ext === 'aac') return 'audio/mp4';
    return null;
  }

  function extractMimeFromQuery(url) {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      const mime = parsed.searchParams.get('mime');
      if (mime) {
        const decoded = decodeURIComponent(mime).split(';')[0].trim().toLowerCase();
        if (decoded) return decoded;
      }
    } catch (err) {
      const match = String(url).match(/[?&]mime=([^&]+)/i);
      if (match && match[1]) {
        try {
          const decoded = decodeURIComponent(match[1]).split(';')[0].trim().toLowerCase();
          if (decoded) return decoded;
        } catch (decodeErr) {
          console.debug('Failed to decode mime query parameter', decodeErr);
        }
      }
    }
    return null;
  }

  function guessExtensionFromUrl(url) {
    if (!url) return '';
    const raw = String(url).split(/[?#]/)[0];
    const match = raw.match(/\.([a-z0-9]+)$/i);
    if (!match) return '';
    return match[1].toLowerCase();
  }

  function buildStreamingRequestOptions(url, overrides = {}) {
    const options = Object.assign({}, overrides);
    options.anonymous = false;
    const headers = Object.assign({}, overrides.headers);
    const host = extractHost(url);
    if (host && /(^|\.)googlevideo\.com$/i.test(host)) {
      if (!headers.Referer && typeof location !== 'undefined' && location.href) {
        headers.Referer = location.href;
      }
      if (!headers.Origin && typeof location !== 'undefined' && location.origin) {
        headers.Origin = location.origin;
      }
      options.preferNativeFetch = true;
    } else if (host && /(^|\.)?(dailymotion\.com|dmcdn\.(?:com|net))$/i.test(host)) {
      options.preferNativeFetch = true;
    }
    options.headers = headers;
    return options;
  }

  function buildVariantInfoFromFormat(format) {
    if (!format || typeof format !== 'object') return null;
    const info = {};
    if (format.qualityLabel) info.name = format.qualityLabel;
    if (Number.isFinite(format.width) && Number.isFinite(format.height)) {
      info.resolution = `${format.width}x${format.height}`;
    }
    const bitrate = format.bitrate || format.averageBitrate;
    if (Number.isFinite(bitrate)) {
      info.bandwidth = bitrate;
    }
    if (Number.isFinite(format.fps)) {
      info.frameRate = format.fps;
    }
    if (format.mimeType) {
      const codecMatch = /codecs="([^"]+)"/i.exec(format.mimeType);
      if (codecMatch && codecMatch[1]) {
        info.codecs = codecMatch[1];
      }
    }
    if (format.itag) {
      info.name = info.name ? `${info.name} · itag ${format.itag}` : `itag ${format.itag}`;
    }
    return Object.keys(info).length > 0 ? info : null;
  }

  function estimateSizeFromFormat(format, durationSeconds) {
    if (!format || typeof format !== 'object') return null;
    const contentLength = parseInt(format.contentLength || format.clen || '', 10);
    if (Number.isFinite(contentLength) && contentLength > 0) return contentLength;
    const bitrate = parseInt(format.averageBitrate || format.bitrate || '', 10);
    if (Number.isFinite(bitrate) && bitrate > 0 && Number.isFinite(durationSeconds)) {
      return Math.round((bitrate / 8) * durationSeconds);
    }
    return null;
  }

  function registerDirectStream(rawUrl, format, videoDetails) {
    const normalized = normalizeYouTubeUrl(rawUrl);
    if (!normalized) return;
    const existing = directUrlLookup.get(normalized);
    const lengthSeconds = format && format.approxDurationMs ? parseInt(format.approxDurationMs, 10) / 1000 :
      (videoDetails && Number.isFinite(parseFloat(videoDetails.lengthSeconds)) ? parseFloat(videoDetails.lengthSeconds) : null);
    const variantInfo = buildVariantInfoFromFormat(format);
    const estimatedSize = estimateSizeFromFormat(format, lengthSeconds);
    const host = extractHost(normalized);
    const titleHint = videoDetails && videoDetails.title ? videoDetails.title : null;
    const mimeType = deduceMimeType(format && format.mimeType, normalized);
    const baseDetails = {
      manifestUrl: normalized,
      type: 'direct',
      title: deriveTitle(normalized, titleHint),
      host,
      segments: [normalized],
      totalSegments: 1,
      totalDuration: Number.isFinite(lengthSeconds) ? lengthSeconds : null,
      variantInfo,
      estimatedSizeBytes: estimatedSize || null,
      mimeType,
      downloadedSegments: 0,
      downloadedBytes: 0,
      progressPercent: 0,
      status: 'idle',
      selected: true,
      dismissed: false,
      createdAt: new Date(),
      downloadController: null,
      cancelRequested: false,
      downloadStartTime: null,
      remainingMs: null
    };
    if (existing) {
      Object.assign(existing, baseDetails);
      updateVideoUI(existing);
      updateStats();
      syncSelectAllState();
      return;
    }
    const video = ensureVideoEntry({
      id: String(idCounter++),
      ...baseDetails
    });
    directUrlLookup.set(normalized, video);
    updateUI();
    if (!estimatedSize) {
      enrichMetadata(video).catch(err => console.warn('Metadata enrichment failed', err));
    }
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

  function shouldIgnoreManifest(url, segments, type) {
    const lower = url.toLowerCase();
    if (type === 'dash' && /googlevideo\.com/.test(lower)) {
      if (segments && segments.length > 1) {
        return false;
      }
    }
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

  function forwardManifestToTop(url) {
    if (!canAccessTop || !url) return;
    if (forwardedManifestUrls.has(url)) return;
    forwardedManifestUrls.add(url);
    try {
      window.top.postMessage({ type: CHILD_MANIFEST_MESSAGE, url }, '*');
    } catch (err) {
      console.debug('Failed to forward manifest to top window', err);
    }
  }

  function handleManifest(url) {
    if (manifestUrls.has(url) || ignoredManifests.has(url)) return;
    if (!isTopWindow) {
      forwardManifestToTop(url);
      return;
    }
    const type = inferManifestType(url);
    if (!type) return;
    manifestUrls.add(url);
    const parserPromise = type === 'hls' ? parseHlsManifest(url, new Set()) : parseDashManifest(url);
    parserPromise.then(result => {
      if (!result || !result.segments || result.segments.length === 0) return;
      if (result.segments.length <= 1) {
        ignoredManifests.add(url);
        return;
      }
      if (shouldIgnoreManifest(url, result.segments, type)) {
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
        mimeType: result.metadata.mimeType || null,
        downloadedSegments: 0,
        downloadedBytes: 0,
        progressPercent: 0,
        status: 'idle',
        selected: true,
        dismissed: false,
        createdAt: new Date(),
        downloadController: null,
        cancelRequested: false,
        downloadStartTime: null,
        remainingMs: null
      });
      updateUI();
      enrichMetadata(video).catch(err => console.warn('Metadata enrichment failed', err));
    }).catch(err => {
      console.error('Failed to parse manifest', url, err);
    });
  }

  if (isTopWindow) {
    window.addEventListener('message', event => {
      if (!event || !event.data || event.data.type !== CHILD_MANIFEST_MESSAGE) return;
      const { url } = event.data;
      if (typeof url === 'string') {
        handleManifest(url);
      }
    });
  }

  function setupYouTubeManifestHooks() {
    if (!isTopWindow) return;
    if (!isYouTubeDomain) return;
    if (setupYouTubeManifestHooks._initialized) return;
    setupYouTubeManifestHooks._initialized = true;

    ensureUIPresent();

    const processedObjects = new WeakSet();
    const processedRawResponses = new Set();
    let hasManifestUrls = false;

    function attemptHandleManifest(url) {
      const normalized = normalizeYouTubeUrl(url);
      if (!normalized) return;
      if (isManifestUrl(normalized)) {
        hasManifestUrls = true;
        handleManifest(normalized);
      }
    }

    function processStreamingData(streamingData, videoDetails) {
      if (!streamingData || typeof streamingData !== 'object') return;
      const candidates = [
        streamingData.dashManifestUrl,
        streamingData.dash_manifest_url,
        streamingData.hlsManifestUrl,
        streamingData.hls_manifest_url,
        streamingData.mssManifestUrl,
        streamingData.mss_manifest_url
      ];
      // Reset flag before checking
      const hadManifests = hasManifestUrls;
      candidates.forEach(attemptHandleManifest);

      // Only register direct formats if no manifest URLs are available
      // Direct YouTube URLs are signed and time-limited, not suitable for download
      if (!hasManifestUrls && !hadManifests) {
        registerYouTubeFormats(streamingData, videoDetails);
      }
    }

    function registerYouTubeFormats(streamingData, videoDetails) {
      if (!streamingData || typeof streamingData !== 'object') return;
      const pools = [];
      if (Array.isArray(streamingData.formats)) pools.push(streamingData.formats);
      if (Array.isArray(streamingData.adaptiveFormats)) pools.push(streamingData.adaptiveFormats);
      pools.forEach(list => {
        list.forEach(format => {
          if (!format || typeof format !== 'object') return;
          const rawUrl = format.url;
          if (!rawUrl) return;
          const mime = typeof format.mimeType === 'string' ? format.mimeType.toLowerCase() : '';
          if (mime && !mime.startsWith('video/')) return;
          registerDirectStream(rawUrl, format, videoDetails || null);
        });
      });
    }

    function processResponseObject(response, context = {}) {
      if (!response || typeof response !== 'object') return;
      if (processedObjects.has(response)) return;
      processedObjects.add(response);

      const videoDetails = response.videoDetails || context.videoDetails || null;

      processStreamingData(response.streamingData, videoDetails);

      const nestedKeys = ['playerResponse', 'player_response', 'player', 'response'];
      nestedKeys.forEach(key => {
        if (response[key] && typeof response[key] === 'object') {
          processResponseObject(response[key], { videoDetails });
        }
      });

      if (response.args && typeof response.args === 'object') {
        const { raw_player_response: rawPlayer, player_response: playerResponseString } = response.args;
        if (rawPlayer) processRawPlayerResponse(rawPlayer, { videoDetails });
        if (playerResponseString && playerResponseString !== rawPlayer) processRawPlayerResponse(playerResponseString, { videoDetails });
      }

      if (response.playerConfig && typeof response.playerConfig === 'object') {
        processResponseObject(response.playerConfig, { videoDetails });
      }
    }

    function processRawPlayerResponse(raw, context = {}) {
      if (!raw) return;
      if (typeof raw === 'string') {
        const normalized = decodeUnicodeEscapes(raw);
        if (!normalized || processedRawResponses.has(normalized)) return;
        processedRawResponses.add(normalized);
        try {
          const parsed = JSON.parse(normalized);
          processResponseObject(parsed, context);
        } catch (err) {
          console.debug('Failed to parse YouTube player response JSON', err);
        }
        return;
      }
      if (typeof raw === 'object') {
        processResponseObject(raw, context);
      }
    }

    function hookProperty(target, property, onSet) {
      if (!target) return;
      const descriptor = Object.getOwnPropertyDescriptor(target, property);
      if (descriptor && !descriptor.configurable) {
        try {
          onSet(target[property]);
        } catch (err) {
          console.debug(`Failed to read locked property ${property}`, err);
        }
        return;
      }
      let current = target[property];
      onSet(current);
      try {
        Object.defineProperty(target, property, {
          configurable: true,
          enumerable: true,
          get() {
            return current;
          },
          set(value) {
            current = value;
            try {
              onSet(value);
            } catch (err) {
              console.debug(`Error processing property ${property}`, err);
            }
          }
        });
      } catch (err) {
        console.debug(`Failed to hook property ${property}`, err);
        try {
          onSet(target[property]);
        } catch (innerErr) {
          console.debug(`Fallback processing failed for property ${property}`, innerErr);
        }
      }
    }

    hookProperty(window, 'ytInitialPlayerResponse', value => {
      processRawPlayerResponse(value);
    });

    hookProperty(window, 'ytplayer', value => {
      if (value && typeof value === 'object') {
        processResponseObject(value);
        hookProperty(value, 'config', configValue => {
          processResponseObject(configValue);
        });
      }
    });

    window.addEventListener('yt-navigate-finish', event => {
      try {
        ensureUIPresent();
        if (!event || !event.detail) return;
        const { detail } = event;
        if (detail.response) processResponseObject(detail.response);
        if (detail.playerResponse) processResponseObject(detail.playerResponse);
        if (detail.apiResponse) processResponseObject(detail.apiResponse);
      } catch (err) {
        console.debug('yt-navigate-finish processing failed', err);
      }
    }, true);

    const poll = () => {
      ensureUIPresent();
      try {
        processRawPlayerResponse(window.ytInitialPlayerResponse);
        if (window.ytplayer && typeof window.ytplayer === 'object') {
          processResponseObject(window.ytplayer);
        }
      } catch (err) {
        console.debug('YouTube manifest poll failed', err);
      }
    };
    const pollInterval = setInterval(poll, 4000);
    window.addEventListener('beforeunload', () => clearInterval(pollInterval), { once: true });
    poll();
  }

  if (isTopWindow) {
    setupYouTubeManifestHooks();
    const panelBootstrapInterval = setInterval(() => {
      if (uiState.hidden) return;
      if (ensureUIPresent()) {
        clearInterval(panelBootstrapInterval);
      }
    }, 1500);

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Show Downloader Panel', () => {
        saveState({ hidden: false });
        if (ensureUIPresent()) {
          updateUI();
          rescanResources();
        }
      });
    }

    if (typeof window !== 'undefined') {
      window.tmHlsDashDownloader = Object.assign({}, window.tmHlsDashDownloader, {
        showPanel() {
          saveState({ hidden: false });
          if (ensureUIPresent()) {
            updateUI();
            rescanResources();
          }
        }
      });
    }
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
        const response = await GM_fetch(url, buildStreamingRequestOptions(url, { method: 'HEAD' }));
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

  function cancelDownload(video) {
    if (!video || video.status !== 'downloading') return;
    video.cancelRequested = true;
    if (video.downloadController && typeof video.downloadController.abort === 'function') {
      try {
        video.downloadController.abort();
      } catch (err) {
        console.debug('Failed to abort download', err);
      }
    }
    updateStats();
  }

  async function startDownload(video) {
    if (!video || !video.segments || video.segments.length === 0) return;
    if (video.status === 'downloading') return;

    video.status = 'downloading';
    video.cancelRequested = false;
    video.downloadedSegments = 0;
    video.downloadedBytes = 0;
    video.progressPercent = 0;
    video.downloadStartTime = Date.now();
    video.remainingMs = null;
    video.completedAt = null;
    video.lastError = null;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    video.downloadController = controller;
    updateVideoUI(video);
    updateStats();

    const buffers = [];
    const total = video.totalSegments;

    try {
      for (let index = 0; index < total; index++) {
        if (video.cancelRequested) {
          if (typeof DOMException === 'function') {
            throw new DOMException('Aborted', 'AbortError');
          }
          const manualAbort = new Error('Aborted');
          manualAbort.name = 'AbortError';
          throw manualAbort;
        }
        const segment = video.segments[index];
        const segUrl = typeof segment === 'string' ? segment : segment.url;

        // Prepare fetch options with proper headers for YouTube
        const fetchOptions = buildStreamingRequestOptions(segUrl, {
          method: 'GET',
          responseType: 'arraybuffer',
          signal: controller ? controller.signal : undefined
        });
        if (video.type === 'direct' && video.segments.length === 1) {
          const requestHeaders = fetchOptions.headers || (fetchOptions.headers = {});
          if (!('Range' in requestHeaders) && !('range' in requestHeaders)) {
            requestHeaders.Range = 'bytes=0-';
          }
        }

        const response = await GM_fetch(segUrl, fetchOptions);
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
        updateStats();
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        video.status = 'cancelled';
        video.lastError = null;
      } else {
        video.status = 'error';
        video.lastError = err && err.message ? err.message : String(err);
        console.error('Failed to download segment', video.manifestUrl || video.title, err);
      }
      video.remainingMs = null;
      video.downloadStartTime = null;
      video.downloadController = null;
      updateVideoUI(video);
      updateStats();
      return;
    } finally {
      video.cancelRequested = false;
      video.downloadController = null;
    }

    const downloadFormat = inferDownloadFormat(video);
    const blob = new Blob(buffers, { type: downloadFormat.mimeType });
    const blobUrl = URL.createObjectURL(blob);
    const safeTitle = buildFileName(video.title, downloadFormat.extension);
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
      video.remainingMs = 0;
    } finally {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      video.downloadStartTime = null;
      updateVideoUI(video);
      updateStats();
    }
  }

  function inferDownloadFormat(video) {
    const fallback = { mimeType: 'video/mp4', extension: 'mp4' };
    if (!video) return fallback;
    const primaryUrl = getFirstSegmentUrl(video.segments) || video.manifestUrl;
    let mime = deduceMimeType(video.mimeType, primaryUrl || video.manifestUrl);

    if (!mime && video.type === 'hls') {
      const ext = guessExtensionFromUrl(primaryUrl);
      if (ext === 'ts' || ext === 'm2ts') {
        mime = 'video/mp2t';
      }
    }

    if (!mime && video.type === 'dash') {
      mime = 'video/mp4';
    }

    const extension = mimeToExtension(mime) || (() => {
      const ext = guessExtensionFromUrl(primaryUrl);
      if (ext) return ext;
      return fallback.extension;
    })();

    return {
      mimeType: mime || fallback.mimeType,
      extension: extension || fallback.extension
    };
  }

  function mimeToExtension(mime) {
    if (!mime) return '';
    const normalized = mime.split(';')[0].trim().toLowerCase();
    switch (normalized) {
      case 'video/mp2t':
        return 'ts';
      case 'video/webm':
        return 'webm';
      case 'audio/mp4':
        return 'm4a';
      case 'audio/aac':
        return 'aac';
      case 'video/mp4':
      case 'video/iso.segment':
      case 'application/mp4':
        return 'mp4';
      default:
        return '';
    }
  }

  function buildFileName(title, extension = 'mp4') {
    const safeBase = title.replace(/[^a-z0-9\-_.]/gi, '_').slice(0, 80) || 'video';
    const normalizedExt = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
    return `${safeBase}.${normalizedExt}`;
  }

  async function parseHlsManifest(url, visited = new Set()) {
    if (visited.has(url)) {
      return { segments: [], metadata: {} };
    }
    visited.add(url);

    let text;
    try {
      const response = await GM_fetch(url, buildStreamingRequestOptions(url, { method: 'GET', responseType: 'text' }));
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
    let currentMapUrl = null;
    let mapApplied = false;

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
      if (line.startsWith('#EXT-X-MAP')) {
        const attrs = parseAttributeList(line.split(':')[1] || '');
        if (attrs.URI) {
          currentMapUrl = makeAbsoluteUrl(attrs.URI, url);
          mapApplied = false;
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
      if (currentMapUrl && !mapApplied) {
        segments.push({ url: currentMapUrl, duration: 0, init: true });
        mapApplied = true;
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

    const firstSegmentUrl = getFirstSegmentUrl(segments);
    const metadataMime = deduceMimeType(null, firstSegmentUrl || url);

    return {
      segments,
      metadata: {
        totalDuration: totalDuration || null,
        nameHint: nameHint || null,
        variantInfo: null,
        mimeType: metadataMime || null
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
    const response = await GM_fetch(url, buildStreamingRequestOptions(url, { method: 'GET', responseType: 'text' }));
    const text = await response.text();
    try {
      const advanced = parseDashWithTemplates(url, text);
      if (advanced && advanced.segments && advanced.segments.length > 0) {
        return advanced;
      }
    } catch (err) {
      console.warn('Advanced DASH parsing failed, falling back to basic parser', err);
    }
    return parseDashFallback(url, text);
  }

  function parseDashWithTemplates(manifestUrl, manifestText) {
    if (typeof DOMParser === 'undefined') {
      throw new Error('DOMParser unavailable in this environment');
    }
    const parser = new DOMParser();
    const doc = parser.parseFromString(manifestText, 'application/xml');
    const errorNode = doc.getElementsByTagName('parsererror')[0];
    if (errorNode && errorNode.textContent) {
      throw new Error('Failed to parse DASH XML: ' + errorNode.textContent);
    }
    const mpd = doc.documentElement;
    if (!mpd || mpd.nodeName.toLowerCase() !== 'mpd') {
      throw new Error('No MPD element found');
    }

    const manifestBase = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
    const mpdBase = resolveDashBaseUrl(mpd, manifestBase);
    const periodNodes = getChildrenByTag(mpd, 'Period');
    const candidates = [];
    const mpdDurationIso = mpd.getAttribute('mediaPresentationDuration');
    const mpdDuration = mpdDurationIso ? parseIsoDuration(mpdDurationIso) : null;
    const fallbackNameHint = deriveDashName(manifestText) || null;

    for (const period of periodNodes) {
      const periodBase = resolveDashBaseUrl(period, mpdBase);
      const adaptationSets = getChildrenByTag(period, 'AdaptationSet');
      for (const adaptation of adaptationSets) {
        const adaptationBase = resolveDashBaseUrl(adaptation, periodBase);
        const representations = getChildrenByTag(adaptation, 'Representation');
        for (const representation of representations) {
          const templateInfo = resolveSegmentTemplateInfo(representation, adaptation);
          if (!templateInfo || !templateInfo.media) continue;

          const representationBase = resolveDashBaseUrl(representation, adaptationBase);
          const repId = representation.getAttribute('id') || null;
          const bandwidth = parseInt(representation.getAttribute('bandwidth') || '', 10) || null;
          const width = parseInt(representation.getAttribute('width') || '', 10) || null;
          const height = parseInt(representation.getAttribute('height') || '', 10) || null;
          const frameRate = representation.getAttribute('frameRate') || adaptation.getAttribute('frameRate') || null;
          const codecs = representation.getAttribute('codecs') || adaptation.getAttribute('codecs') || null;
          const mimeType = (representation.getAttribute('mimeType') || adaptation.getAttribute('mimeType') || '').toLowerCase();
          const contentType = (adaptation.getAttribute('contentType') || '').toLowerCase();
          const role = (adaptation.getAttribute('roles') || '').toLowerCase();
          const isVideo = contentType === 'video' || mimeType.startsWith('video/') || (height && height > 0);
          const isAudio = contentType === 'audio' || mimeType.startsWith('audio/') || role.includes('audio');

          const timelineResult = buildSegmentsFromTemplate(templateInfo, {
            baseUrl: representationBase,
            repId,
            bandwidth,
            mpdDuration,
            period,
            adaptation,
            representation
          });

          if (!timelineResult || timelineResult.segments.length === 0) {
            continue;
          }

          const variantInfo = {};
          if (repId) variantInfo.name = repId;
          if (width && height) variantInfo.resolution = `${width}x${height}`;
          if (!variantInfo.resolution && representation.getAttribute('sar')) {
            const sar = representation.getAttribute('sar');
            variantInfo.resolution = `${width || ''}x${height || ''} ${sar}`;
          }
          if (Number.isFinite(bandwidth)) variantInfo.bandwidth = bandwidth;
          if (frameRate) variantInfo.frameRate = frameRate;
          if (codecs) variantInfo.codecs = codecs;

          const preferredTypeScore = isVideo ? 3 : (isAudio ? 2 : 1);
          const resolutionScoreValue = (width && height) ? width * height : 0;
          const bandwidthScore = Number.isFinite(bandwidth) ? bandwidth : 0;
          const score = preferredTypeScore * 1e12 + resolutionScoreValue * 1e3 + bandwidthScore;

          let normalizedMime = mimeType.split(';')[0] || '';
          if (!normalizedMime) {
            normalizedMime = isAudio ? 'audio/mp4' : 'video/mp4';
          }

          candidates.push({
            score,
            result: {
              segments: timelineResult.segments,
              metadata: {
                totalDuration: timelineResult.totalDurationSeconds || mpdDuration || null,
                nameHint: repId || adaptation.getAttribute('id') || fallbackNameHint,
                variantInfo,
                mimeType: normalizedMime
              }
            }
          });
        }
      }
    }

    if (candidates.length === 0) {
      return { segments: [], metadata: {} };
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].result;
  }

  function resolveDashBaseUrl(node, fallbackBase) {
    const baseNode = getChildrenByTag(node, 'BaseURL')[0];
    if (baseNode && baseNode.textContent) {
      const raw = baseNode.textContent.trim();
      if (raw) {
        return makeAbsoluteUrl(raw, fallbackBase);
      }
    }
    return fallbackBase;
  }

  function getChildrenByTag(node, tagName) {
    const matches = [];
    if (!node || !node.childNodes) return matches;
    const lowered = tagName.toLowerCase();
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && child.nodeName.toLowerCase() === lowered) {
        matches.push(child);
      }
    }
    return matches;
  }

  function resolveSegmentTemplateInfo(representation, adaptation) {
    const templateNodes = [];
    const adaptationTemplate = getChildrenByTag(adaptation, 'SegmentTemplate')[0];
    if (adaptationTemplate) templateNodes.push(adaptationTemplate);
    const representationTemplate = getChildrenByTag(representation, 'SegmentTemplate')[0];
    if (representationTemplate) templateNodes.push(representationTemplate);
    if (templateNodes.length === 0) return null;

    const info = {
      media: null,
      initialization: null,
      startNumber: 1,
      timescale: 1,
      duration: null,
      presentationTimeOffset: 0,
      timelineNode: null
    };

    for (const node of templateNodes) {
      if (node.hasAttribute('media')) info.media = node.getAttribute('media');
      if (node.hasAttribute('initialization')) info.initialization = node.getAttribute('initialization');
      const initChild = getChildrenByTag(node, 'Initialization')[0];
      if (initChild && initChild.getAttribute('sourceURL')) {
        info.initialization = initChild.getAttribute('sourceURL');
      }
      if (node.hasAttribute('startNumber')) {
        const value = parseInt(node.getAttribute('startNumber') || '', 10);
        if (Number.isFinite(value)) info.startNumber = value;
      }
      if (node.hasAttribute('timescale')) {
        const value = parseInt(node.getAttribute('timescale') || '', 10);
        if (Number.isFinite(value) && value > 0) info.timescale = value;
      }
      if (node.hasAttribute('duration')) {
        const value = parseInt(node.getAttribute('duration') || '', 10);
        if (Number.isFinite(value) && value > 0) info.duration = value;
      }
      if (node.hasAttribute('presentationTimeOffset')) {
        const value = parseInt(node.getAttribute('presentationTimeOffset') || '', 10);
        if (Number.isFinite(value)) info.presentationTimeOffset = value;
      }
      const timeline = getChildrenByTag(node, 'SegmentTimeline')[0];
      if (timeline) info.timelineNode = timeline;
    }
    return info.media ? info : null;
  }

  function buildSegmentsFromTemplate(templateInfo, context) {
    const { media, initialization, startNumber, timescale, duration, presentationTimeOffset, timelineNode } = templateInfo;
    const segments = [];
    let totalDurationSeconds = 0;
    const MAX_SEGMENTS = 20000;
    const templateContextBase = {
      RepresentationID: context.repId || '',
      Bandwidth: Number.isFinite(context.bandwidth) ? context.bandwidth : '',
      Number: startNumber
    };

    if (initialization) {
      const initUrl = resolveTemplateUrl(initialization, context.baseUrl, templateContextBase);
      if (initUrl) {
        segments.push({ url: initUrl, duration: 0 });
      }
    }

    if (timelineNode) {
      let currentNumber = startNumber;
      let latestTime = 0;
      const segmentNodes = getChildrenByTag(timelineNode, 'S');
      outer: for (const segmentNode of segmentNodes) {
        const d = parseInt(segmentNode.getAttribute('d') || '', 10);
        if (!Number.isFinite(d) || d <= 0) continue;
        let r = parseInt(segmentNode.getAttribute('r') || '', 10);
        if (!Number.isFinite(r)) r = 0;
        let segmentTime;
        if (segmentNode.hasAttribute('t')) {
          const t = parseInt(segmentNode.getAttribute('t') || '', 10);
          segmentTime = Number.isFinite(t) ? t : latestTime;
        } else {
          segmentTime = latestTime;
        }
        if (!Number.isFinite(segmentTime)) segmentTime = 0;

        const repeatCount = r >= 0 ? r + 1 : MAX_SEGMENTS;
        for (let i = 0; i < repeatCount; i++) {
          if (segments.length >= MAX_SEGMENTS) break outer;

          const valueContext = Object.assign({}, templateContextBase, {
            Number: currentNumber,
            Time: Math.max(0, segmentTime - presentationTimeOffset)
          });
          const mediaUrl = resolveTemplateUrl(media, context.baseUrl, valueContext);
          if (mediaUrl) {
            const durationSeconds = d / timescale;
            segments.push({
              url: mediaUrl,
              duration: Number.isFinite(durationSeconds) ? durationSeconds : null
            });
            if (Number.isFinite(durationSeconds)) {
              totalDurationSeconds += durationSeconds;
            }
          }
          currentNumber += 1;
          segmentTime += d;
        }
        latestTime = segmentTime;
        if (r === -1) {
          break;
        }
      }
    } else if (duration && context.mpdDuration) {
      const segmentDurationSeconds = duration / timescale;
      if (segmentDurationSeconds > 0) {
        const approxCount = Math.min(
          Math.ceil(context.mpdDuration / segmentDurationSeconds),
          MAX_SEGMENTS - segments.length
        );
        let number = startNumber;
        for (let i = 0; i < approxCount; i++) {
          const valueContext = Object.assign({}, templateContextBase, {
            Number: number,
            Time: Math.max(0, Math.round(i * duration - presentationTimeOffset))
          });
          const mediaUrl = resolveTemplateUrl(media, context.baseUrl, valueContext);
          if (mediaUrl) {
            segments.push({ url: mediaUrl, duration: segmentDurationSeconds });
            totalDurationSeconds += segmentDurationSeconds;
          }
          number += 1;
        }
      }
    }

    return {
      segments,
      totalDurationSeconds
    };
  }

  function resolveTemplateUrl(template, baseUrl, context) {
    if (!template) return null;
    const safeTemplate = template.replace(/\$\$/g, '__DOLLAR__');
    const replaced = safeTemplate.replace(/\$([A-Za-z0-9]+)(%0?\d*d)?\$/g, (full, key, format) => {
      const rawValue = context[key] != null ? context[key] : '';
      if (format && typeof rawValue === 'number') {
        const widthMatch = /%0?(\d*)d/.exec(format);
        if (widthMatch) {
          const width = parseInt(widthMatch[1], 10);
          if (Number.isFinite(width) && width > 0) {
            return String(rawValue).padStart(width, '0');
          }
        }
      }
      return String(rawValue);
    }).replace(/__DOLLAR__/g, '$');
    return makeAbsoluteUrl(replaced, baseUrl);
  }

  function parseDashFallback(url, text) {
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
        nameHint,
        mimeType: 'video/mp4'
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
      if (url && isManifestUrl(url)) {
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
      if (url && isManifestUrl(url)) {
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
        if (entry.name && isManifestUrl(entry.name)) {
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
      const signal = options.signal;
      const preferNativeFetch = options.preferNativeFetch === true;
      if ('preferNativeFetch' in options) {
        delete options.preferNativeFetch;
      }
      const sendCredentials = options.anonymous === false;
      const headers = options.headers ? Object.assign({}, options.headers) : undefined;
      const useAnonymous = !sendCredentials;
      let aborted = false;
      let requestHandle = null;

      const abortError = () => {
        if (typeof DOMException === 'function') {
          return new DOMException('Aborted', 'AbortError');
        }
        const err = new Error('Aborted');
        err.name = 'AbortError';
        return err;
      };

      const cleanup = () => {
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
      };

      const onAbort = () => {
        if (aborted) return;
        aborted = true;
        if (requestHandle && typeof requestHandle.abort === 'function') {
          try {
            requestHandle.abort();
          } catch (err) {
            console.debug('Abort request failed', err);
          }
        }
        cleanup();
        reject(abortError());
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const resolveWith = response => {
        cleanup();
        resolve(response);
      };

      const rejectWith = err => {
        cleanup();
        reject(err);
      };

      const tryNativeFetch = async () => {
        if (typeof fetch !== 'function') return false;
        try {
          const fetchOptions = Object.assign({}, options, {
            method,
            credentials: sendCredentials ? 'include' : 'omit',
            mode: 'cors'
          });
          const refererHeader = headers && (headers.Referer || headers.referer);
          if (signal) fetchOptions.signal = signal;
          if (refererHeader) {
            fetchOptions.referrer = refererHeader;
          } else if (sendCredentials && typeof location !== 'undefined' && location.href) {
            fetchOptions.referrer = location.href;
          }
          const fetchHeaders = new Headers();
          if (headers) {
            Object.keys(headers).forEach(key => {
              if (!key) return;
              const lower = key.toLowerCase();
              if (lower === 'referer' || lower === 'origin') return;
              fetchHeaders.set(key, headers[key]);
            });
          }
          if ([...fetchHeaders.keys()].length > 0) {
            fetchOptions.headers = fetchHeaders;
          }
          const resp = await fetch(url, fetchOptions);
          if (aborted) return true;
          resolveWith({
            ok: resp.ok,
            status: resp.status,
            headers: resp.headers,
            arrayBuffer: () => resp.arrayBuffer(),
            text: () => resp.text()
          });
          return true;
        } catch (err) {
          if (aborted) return true;
          console.debug('Native fetch failed, falling back to GM_xmlhttpRequest', err);
          return false;
        }
      };

      const preferFetch = preferNativeFetch || sendCredentials;

      if (preferFetch) {
        tryNativeFetch().then(handled => {
          if (handled) return;
          proceedWithGM();
        });
        return;
      }

      proceedWithGM();

      function proceedWithGM() {
        if (typeof GM_xmlhttpRequest === 'function') {
          const gmOptions = {
            method,
            url,
            responseType,
            headers: headers || {},
            anonymous: useAnonymous,
            onload: function(response) {
              if (aborted) return;
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
              resolveWith({
                ok: response.status >= 200 && response.status < 300,
                status: response.status,
                headers,
                arrayBuffer,
                text
              });
            },
            onerror: function(err) {
              if (aborted) return;
              rejectWith(err);
            }
          };
          requestHandle = GM_xmlhttpRequest(gmOptions);
        } else {
          tryNativeFetch().then(handled => {
            if (handled) return;
            rejectWith(new Error('Fetch unavailable in this environment'));
          });
        }
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
    if (!ensureUIPresent()) return;
    rescanResources();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    onReady();
  } else {
    document.addEventListener('DOMContentLoaded', onReady);
  }
})();
