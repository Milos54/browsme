// ── State ──────────────────────────────────────────────────────────────────────
let currentPath   = '/';
let navHistory    = [];
let historyIndex  = -1;
let viewMode      = 'grid';   // 'grid' | 'list'
let currentFiles  = [];
let connectionInfo = null;
let isLoading     = false;

// Windows Explorer type-ahead: letters accumulate for a short window.
// Repeating one letter walks every name that starts with it, then wraps.
const TYPE_AHEAD_MS = 1000;
let typeAheadQuery = '';
let typeAheadAt = 0;

const $ = (id) => document.getElementById(id);

// ── Boot ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindWindowControls();
  bindConnectForm();
  bindExplorerControls();
});

function bindWindowControls() {
  $('btn-minimize').addEventListener('click', () => window.api.minimize());
  $('btn-maximize').addEventListener('click', () => window.api.maximize());
  $('btn-close').addEventListener('click',   () => window.api.close());
}

function bindConnectForm() {
  $('connect-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await handleConnect();
  });

  // Jump host toggle
  $('chk-jump').addEventListener('change', (e) => {
    const on = e.target.checked;
    $('jump-section').classList.toggle('hidden', !on);
    $('password-optional').classList.toggle('hidden', !on);
  });

  // Allow Enter in any field to submit
  const formFields = [
    'input-host', 'input-username', 'input-port', 'input-password',
    'jump-host', 'jump-username', 'jump-port', 'jump-password',
  ];
  formFields.forEach((id) => {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('connect-form').dispatchEvent(new Event('submit'));
    });
  });
}

// ── Upload ─────────────────────────────────────────────────────────────────────
// Register the progress listener once at startup
window.api.onUploadProgress(({ localPath, transferred, total }) => {
  updateUploadProgress(localPath, transferred, total);
});

function bindExplorerControls() {
  $('btn-back').addEventListener('click',    () => navigateHistory(-1));
  $('btn-forward').addEventListener('click', () => navigateHistory(1));
  $('btn-up').addEventListener('click',      navigateUp);
  $('btn-refresh').addEventListener('click', () => loadDirectory(currentPath, false));
  $('btn-disconnect').addEventListener('click', handleDisconnect);
  $('btn-retry').addEventListener('click',   () => loadDirectory(currentPath, false));
  $('btn-view-grid').addEventListener('click', () => setViewMode('grid'));
  $('btn-view-list').addEventListener('click', () => setViewMode('list'));
  $('btn-hop').addEventListener('click', openHopModal);

  // Docker
  $('btn-docker').addEventListener('click', toggleDockerDropdown);
  $('btn-docker-exit').addEventListener('click', exitDockerMode);
  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.docker-wrap');
    if (wrap && !wrap.contains(e.target)) closeDockerDropdown();
  });

  // Drag & drop upload
  const fileArea = $('file-area');
  let dragCounter = 0;

  fileArea.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) showDragOverlay(true);
  });
  fileArea.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  fileArea.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; showDragOverlay(false); }
  });
  fileArea.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    showDragOverlay(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleUpload(files);
  });

  $('upload-panel-close').addEventListener('click', () => {
    $('upload-panel').classList.add('hidden');
  });

  // Hop modal
  $('hop-form').addEventListener('submit', async (e) => { e.preventDefault(); await handleHop(); });
  $('hop-close').addEventListener('click', closeHopModal);
  $('hop-backdrop').addEventListener('click', (e) => { if (e.target === $('hop-backdrop')) closeHopModal(); });

  // Preview modal close
  $('preview-close').addEventListener('click', closePreview);
  $('preview-backdrop').addEventListener('click', (e) => {
    if (e.target === $('preview-backdrop')) closePreview();
  });

  // Context menu
  document.addEventListener('click',       hideCtxMenu);
  document.addEventListener('contextmenu', (e) => e.preventDefault()); // block default
  $('ctx-rename').addEventListener('click', () => { hideCtxMenu(); startRename(); });
  $('ctx-copy').addEventListener('click',   () => { hideCtxMenu(); copyToClipboard(); });
  $('ctx-delete').addEventListener('click', () => { hideCtxMenu(); startDelete(); });
  $('btn-paste').addEventListener('click',       runPaste);
  $('btn-paste-clear').addEventListener('click', clearClipboard);

  // Rename modal
  $('rename-cancel').addEventListener('click', closeRename);
  $('rename-backdrop').addEventListener('click', (e) => { if (e.target === $('rename-backdrop')) closeRename(); });
  $('rename-ok').addEventListener('click', runRename);
  $('rename-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runRename(); });

  // Confirm modal
  $('confirm-cancel').addEventListener('click', closeConfirm);
  $('confirm-backdrop').addEventListener('click', (e) => { if (e.target === $('confirm-backdrop')) closeConfirm(); });
  $('confirm-ok').addEventListener('click', runDelete);

  // Sudo modal
  $('sudo-cancel').addEventListener('click', closeSudo);
  $('sudo-backdrop').addEventListener('click', (e) => { if (e.target === $('sudo-backdrop')) closeSudo(); });
  $('sudo-ok').addEventListener('click', runSudoAction);
  $('sudo-pass-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSudoAction(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePreview(); closeHopModal(); closeConfirm(); closeSudo(); closeRename(); }
    handleTypeAheadKey(e);
  });
}

// ── Connect ────────────────────────────────────────────────────────────────────
async function handleConnect() {
  const host     = $('input-host').value.trim();
  const username = $('input-username').value.trim();
  const password = $('input-password').value;
  const port     = parseInt($('input-port').value, 10) || 22;
  const useJump  = $('chk-jump').checked;

  if (!host || !username) {
    showConnectError('Please fill in host and username.');
    return;
  }
  if (!password && !useJump) {
    showConnectError('Please fill in your password.');
    return;
  }

  let jump = null;
  if (useJump) {
    const jHost = $('jump-host').value.trim();
    const jUser = $('jump-username').value.trim();
    const jPass = $('jump-password').value;
    const jPort = parseInt($('jump-port').value, 10) || 22;
    if (!jHost || !jUser || !jPass) {
      showConnectError('Please fill in all jump host fields (host, username, password).');
      return;
    }
    jump = { host: jHost, username: jUser, password: jPass, port: jPort };
  }

  setConnecting(true);
  clearConnectError();

  const result = await window.api.connect({ host, username, password, port, jump });

  if (!result.success) {
    setConnecting(false);
    showConnectError(result.error || 'Connection failed.');
    return;
  }

  connectionInfo = { host, username, port, jump };
  const label = jump
    ? `${username}@${host} via ${jump.username}@${jump.host}`
    : `${username}@${host}`;
  $('titlebar-title').textContent     = `SSH Explorer — ${label}`;
  $('status-connection').textContent  = `Connected: ${label}`;

  navHistory   = [];
  historyIndex = -1;

  showScreen('explorer');

  const homeResult = await window.api.homedir();
  const homePath   = (homeResult.success && homeResult.path) ? homeResult.path : '/';
  await loadDirectory(homePath, true);
}

async function handleDisconnect() {
  await window.api.disconnect();
  connectionInfo = null;
  navHistory     = [];
  historyIndex   = -1;
  currentFiles   = [];
  $('titlebar-title').textContent = 'SSH Explorer';
  $('file-container').innerHTML   = '';
  $('status-items').textContent   = '';
  setConnecting(false);
  showScreen('connect');
}

// ── Hop Modal ──────────────────────────────────────────────────────────────────
function openHopModal() {
  $('hop-input-host').value     = '';
  $('hop-input-username').value = '';
  $('hop-input-password').value = '';
  $('hop-input-port').value     = '22';
  $('hop-error').classList.add('hidden');
  $('hop-backdrop').classList.remove('hidden');
  setTimeout(() => $('hop-input-host').focus(), 50);
}

function closeHopModal() {
  $('hop-backdrop').classList.add('hidden');
}

async function handleHop() {
  const host     = $('hop-input-host').value.trim();
  const username = $('hop-input-username').value.trim();
  const password = $('hop-input-password').value;
  const port     = parseInt($('hop-input-port').value, 10) || 22;

  if (!host || !username) {
    $('hop-error').textContent = 'Please fill in host and username.';
    $('hop-error').classList.remove('hidden');
    return;
  }

  // Show spinner
  $('btn-hop-connect').disabled  = true;
  $('hop-btn-text').textContent  = 'Connecting…';
  $('hop-spinner').classList.remove('hidden');
  $('hop-error').classList.add('hidden');

  const result = await window.api.hop({ host, username, password, port });

  $('btn-hop-connect').disabled = false;
  $('hop-btn-text').textContent = 'Connect';
  $('hop-spinner').classList.add('hidden');

  if (!result.success) {
    $('hop-error').textContent = result.error || 'Connection failed.';
    $('hop-error').classList.remove('hidden');
    return;
  }

  // Success — update UI
  const prevLabel = connectionInfo
    ? `${connectionInfo.username}@${connectionInfo.host}`
    : 'previous server';
  connectionInfo = { host, username, port, via: prevLabel };

  const label = `${username}@${host} (via ${prevLabel})`;
  $('titlebar-title').textContent    = `SSH Explorer — ${label}`;
  $('status-connection').textContent = `Connected: ${label}`;

  closeHopModal();

  navHistory   = [];
  historyIndex = -1;
  const homeResult = await window.api.homedir();
  const homePath   = (homeResult.success && homeResult.path) ? homeResult.path : '/';
  await loadDirectory(homePath, true);
}

function setConnecting(on) {
  $('btn-connect').disabled = on;
  $('connect-btn-text').textContent = on ? 'Connecting…' : 'Connect';
  $('connect-spinner').classList.toggle('hidden', !on);
}

function showConnectError(msg) {
  const el = $('connect-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearConnectError() {
  $('connect-error').classList.add('hidden');
}

// ── Navigation ─────────────────────────────────────────────────────────────────
async function loadDirectory(dirPath, pushHistory = true) {
  if (isLoading) return;
  isLoading = true;

  setLoading(true);
  hideFileError();
  $('empty-msg').classList.add('hidden');

  let result;
  try {
    result = dockerMode
      ? await window.api.dockerReaddir(dockerMode.id, dirPath)
      : await window.api.readdir(dirPath);
  } catch (err) {
    result = { success: false, error: (err && err.message) || 'Failed to read directory.' };
  }

  setLoading(false);
  isLoading = false;

  if (!result || !result.success) {
    showFileError(dockerSafeError(result, 'Failed to read directory.'));
    return;
  }

  if (pushHistory) {
    navHistory   = navHistory.slice(0, historyIndex + 1);
    navHistory.push(dirPath);
    historyIndex = navHistory.length - 1;
  }

  currentPath  = dirPath;
  currentFiles = result.files;

  updateBreadcrumb(dirPath);
  updateNavButtons();
  renderFiles(currentFiles);

  const count = currentFiles.length;
  $('status-items').textContent = `${count} item${count !== 1 ? 's' : ''}`;
}

function navigateHistory(delta) {
  const newIndex = historyIndex + delta;
  if (newIndex < 0 || newIndex >= navHistory.length) return;
  historyIndex = newIndex;
  loadDirectory(navHistory[newIndex], false);
}

function navigateUp() {
  if (currentPath === '/') return;
  const parts  = currentPath.replace(/\/$/, '').split('/');
  parts.pop();
  const parent = parts.join('/') || '/';
  loadDirectory(parent);
}

function updateNavButtons() {
  $('btn-back').disabled    = historyIndex <= 0;
  $('btn-forward').disabled = historyIndex >= navHistory.length - 1;
  $('btn-up').disabled      = currentPath === '/';
}

// ── Breadcrumb ─────────────────────────────────────────────────────────────────
function updateBreadcrumb(dirPath) {
  const bc    = $('breadcrumb');
  bc.innerHTML = '';

  const segments = dirPath === '/' ? [''] : dirPath.split('/');
  let accumulated = '';

  segments.forEach((part, i) => {
    const isLast    = i === segments.length - 1;
    accumulated     = i === 0 ? '/' : `${accumulated === '/' ? '' : accumulated}/${part}`;
    const snapPath  = accumulated;

    const span      = document.createElement('span');
    span.className  = 'bc-segment' + (isLast ? ' bc-active' : '');
    span.textContent = part === '' ? '/' : part;

    if (!isLast) {
      span.addEventListener('click', () => loadDirectory(snapPath));
    }

    bc.appendChild(span);

    if (!isLast) {
      const sep = document.createElement('span');
      sep.className   = 'bc-sep';
      sep.textContent = ' › ';
      bc.appendChild(sep);
    }
  });
}

// ── Render files ───────────────────────────────────────────────────────────────
function renderFiles(files) {
  resetTypeAhead();
  const container      = $('file-container');
  container.innerHTML  = '';
  container.className  = viewMode === 'list' ? 'file-list' : 'file-grid';

  if (files.length === 0) {
    $('empty-msg').classList.remove('hidden');
    return;
  }

  files.forEach((file) => {
    const item         = document.createElement('div');
    item.className     = 'file-item';
    item.dataset.name  = file.name;
    item.dataset.isDir = file.isDirectory;

    const icon     = getFileIcon(file.name, file.isDirectory, file.isSymlink);
    const sizeStr  = file.isDirectory ? '' : formatSize(file.size);
    const dateStr  = file.mtime ? formatDate(file.mtime * 1000) : '';
    const badgeHtml = file.linkedAs
      ? file.linkedAs.map((lnk) => `<span class="file-badge${isProdLink(lnk) ? ' file-badge-prod' : ''}">\u2192 ${escHtml(lnk)}</span>`).join('')
      : '';

    if (viewMode === 'list') {
      item.innerHTML = `
        <span class="fi-icon">${icon}</span>
        <span class="fi-name" title="${escHtml(file.name)}">${escHtml(file.name)}${badgeHtml ? ' ' + badgeHtml : ''}</span>
        <span class="fi-size">${sizeStr}</span>
        <span class="fi-date">${dateStr}</span>
      `;
    } else {
      item.innerHTML = `
        <span class="fi-icon-large">${icon}</span>
        ${badgeHtml ? `<span class="fi-badges">${badgeHtml}</span>` : ''}
        <span class="fi-name-grid" title="${escHtml(file.name)}">${escHtml(file.name)}</span>
      `;
    }

    if (file.isDirectory) {
      // isDirectory is true for real dirs AND symlinks-to-dirs (resolved in main)
      item.addEventListener('dblclick', () => {
        const newPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
        loadDirectory(newPath);
      });
    } else if (!file.isSymlink) {
      item.addEventListener('dblclick', () => {
        const filePath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
        openPreview(filePath, file.name, file.size);
      });
    }

    item.addEventListener('click', () => {
      resetTypeAhead();
      selectFileItem(item);
    });

    item.addEventListener('contextmenu', (e) => {
      e.stopPropagation();
      resetTypeAhead();
      selectFileItem(item);
      showCtxMenu(e.clientX, e.clientY, file);
    });

    container.appendChild(item);
  });
}

function resetTypeAhead() {
  typeAheadQuery = '';
  typeAheadAt = 0;
}

function selectFileItem(item, reveal) {
  const container = $('file-container');
  container.querySelectorAll('.file-item.selected').forEach((el) => el.classList.remove('selected'));
  item.classList.add('selected');
  if (reveal) item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function nameStartsWith(name, prefix) {
  return String(name).toLocaleLowerCase().startsWith(String(prefix).toLocaleLowerCase());
}

// Same rules as a Windows folder: a new letter jumps to the next name that
// starts with it (the first one when nothing is selected). Repeating that
// letter keeps walking those names and wraps. A different letter typed
// quickly narrows the prefix ("a" then "p" looks for "ap").
function resolveTypeAhead(names, selectedIndex, query, ch, withinTimeout) {
  const c = ch.toLocaleLowerCase();
  const repeat = withinTimeout
    && query.length > 0
    && [...query.toLocaleLowerCase()].every((q) => q === c);

  let prefix;
  let start;

  if (repeat) {
    prefix = c;
    start = selectedIndex + 1;
  } else if (withinTimeout && query) {
    prefix = query + c;
    if (selectedIndex >= 0 && nameStartsWith(names[selectedIndex], prefix)) {
      return { index: selectedIndex, query: prefix };
    }
    start = selectedIndex + 1;
  } else {
    prefix = c;
    start = selectedIndex + 1;
  }

  const count = names.length;
  if (!count) return { index: -1, query };

  for (let i = 0; i < count; i++) {
    const idx = (start + i) % count;
    if (nameStartsWith(names[idx], prefix)) return { index: idx, query: prefix };
  }

  if (withinTimeout && query && !repeat) return { index: -1, query };
  return { index: -1, query: prefix };
}

function isTextEntryTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function isBlockingOverlayOpen() {
  return ['preview-backdrop', 'hop-backdrop', 'confirm-backdrop', 'rename-backdrop', 'sudo-backdrop']
    .some((id) => !$(id).classList.contains('hidden'));
}

function handleTypeAheadKey(e) {
  if (e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key.length !== 1) return;
  if (!$('explorer-screen').classList.contains('active')) return;
  if (isTextEntryTarget(e.target)) return;
  if (isBlockingOverlayOpen()) return;

  const container = $('file-container');
  const items = Array.from(container.querySelectorAll('.file-item'));
  if (!items.length) return;

  e.preventDefault();

  const now = Date.now();
  const withinTimeout = typeAheadQuery.length > 0 && (now - typeAheadAt) <= TYPE_AHEAD_MS;
  const names = items.map((el) => el.dataset.name || '');
  const selected = container.querySelector('.file-item.selected');
  const selectedIndex = selected ? items.indexOf(selected) : -1;
  const result = resolveTypeAhead(names, selectedIndex, typeAheadQuery, e.key, withinTimeout);

  typeAheadQuery = result.query;
  typeAheadAt = now;

  if (result.index >= 0) {
    hideCtxMenu();
    selectFileItem(items[result.index], true);
  }
}

function setViewMode(mode) {
  viewMode = mode;
  $('btn-view-grid').classList.toggle('active', mode === 'grid');
  $('btn-view-list').classList.toggle('active', mode === 'list');
  renderFiles(currentFiles);
}

// Returns true if the symlink name looks production-related
function isProdLink(name) {
  return /^(prod|production|live|current|stable|release)$/i.test(name);
}

// ── File icons ─────────────────────────────────────────────────────────────────
function getFileIcon(name, isDir, isSymlink) {
  if (isDir)     return isSymlink ? '🔗' : '📁';
  if (isSymlink) return '🔗';

  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';

  const map = {
    // Images
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️', ico: '🖼️', bmp: '🖼️',
    // Code
    js: '📜', ts: '📜', jsx: '📜', tsx: '📜', py: '🐍', rb: '💎', go: '🔵',
    java: '☕', c: '⚙️', cpp: '⚙️', h: '⚙️', cs: '⚙️', php: '📜', rs: '🦀',
    // Web
    html: '🌐', htm: '🌐', css: '🎨',
    // Data
    json: '📋', xml: '📋', yaml: '📋', yml: '📋', csv: '📊', sql: '🗄️',
    // Docs
    txt: '📄', md: '📄', pdf: '📕', doc: '📘', docx: '📘',
    xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
    // Archives
    zip: '📦', tar: '📦', gz: '📦', bz2: '📦', rar: '📦', '7z': '📦', xz: '📦',
    // Scripts
    sh: '⚡', bash: '⚡', zsh: '⚡', fish: '⚡',
    // Executables
    exe: '⚙️', bin: '⚙️', deb: '📦', rpm: '📦', apk: '📦',
    // Config
    env: '⚙️', conf: '⚙️', config: '⚙️', ini: '⚙️', toml: '⚙️', lock: '🔒',
    // Media
    mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵',
    mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', webm: '🎬',
  };

  return map[ext] || '📄';
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(`${name}-screen`).classList.add('active');
}

function setLoading(on) {
  $('loading-overlay').classList.toggle('hidden', !on);
}

function showFileError(msg) {
  $('error-text').textContent = msg;
  $('error-overlay').classList.remove('hidden');
}

function hideFileError() {
  $('error-overlay').classList.add('hidden');
}

// ── File Preview ───────────────────────────────────────────────────────────────
async function openPreview(filePath, fileName, fileSize) {
  const backdrop = $('preview-backdrop');
  const icon     = $('preview-icon');
  const nameEl   = $('preview-filename');
  const sizeEl   = $('preview-size');
  const loading  = $('preview-loading');
  const errEl    = $('preview-error');
  const content  = $('preview-content');

  // Reset state
  icon.textContent    = getFileIcon(fileName, false, false);
  nameEl.textContent  = fileName;
  sizeEl.textContent  = fileSize ? formatSize(fileSize) : '';
  content.innerHTML   = '';
  errEl.textContent   = '';

  loading.classList.remove('hidden');
  errEl.classList.add('hidden');
  content.classList.add('hidden');
  backdrop.classList.remove('hidden');

  let result;
  try {
    result = dockerMode
      ? await window.api.dockerReadfile(dockerMode.id, filePath)
      : await window.api.readfile(filePath);
  } catch (err) {
    result = { success: false, error: (err && err.message) || 'Could not read file.' };
  }

  loading.classList.add('hidden');

  if (!result || !result.success) {
    errEl.textContent = dockerSafeError(result, 'Could not read file.');
    errEl.classList.remove('hidden');
    return;
  }

  const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  content.innerHTML = renderFileContent(result.content, ext);
  content.classList.remove('hidden');
}

function renderFileContent(raw, ext) {
  if (ext === 'json') {
    try {
      const pretty = JSON.stringify(JSON.parse(raw), null, 2);
      return highlightJson(pretty);
    } catch {
      // Not valid JSON — fall through to plain text
    }
  }
  return escHtml(raw);
}

function highlightJson(json) {
  // Escape HTML first, then apply colour spans
  const escaped = escHtml(json);
  return escaped.replace(
    /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      if (match.endsWith(':')) return `<span class="jk">${match}</span>`;    // key
      if (match.startsWith('"')) return `<span class="js">${match}</span>`;  // string value
      if (match === 'true' || match === 'false') return `<span class="jb">${match}</span>`; // bool
      if (match === 'null') return `<span class="jn">${match}</span>`;       // null
      return `<span class="ji">${match}</span>`;                             // number
    }
  );
}

// ── Rename ─────────────────────────────────────────────────────────────────────
function startRename() {
  if (!ctxTarget) return;
  $('rename-input').value = ctxTarget.name;
  $('rename-error').classList.add('hidden');
  $('rename-ok').disabled = false;
  $('rename-ok-text').textContent = 'Rename';
  $('rename-spinner').classList.add('hidden');
  $('rename-backdrop').classList.remove('hidden');
  // Select the name without extension for easy editing
  const input = $('rename-input');
  setTimeout(() => {
    input.focus();
    const dotIdx = ctxTarget.isDirectory ? -1 : ctxTarget.name.lastIndexOf('.');
    input.setSelectionRange(0, dotIdx > 0 ? dotIdx : ctxTarget.name.length);
  }, 50);
}

function closeRename() {
  $('rename-backdrop').classList.add('hidden');
}

async function runRename() {
  if (!ctxTarget) return;
  const newName = $('rename-input').value.trim();

  if (!newName) {
    $('rename-error').textContent = 'Name cannot be empty.';
    $('rename-error').classList.remove('hidden');
    return;
  }
  if (newName === ctxTarget.name) { closeRename(); return; }
  if (newName.includes('/')) {
    $('rename-error').textContent = 'Name cannot contain slashes.';
    $('rename-error').classList.remove('hidden');
    return;
  }

  $('rename-ok').disabled = true;
  $('rename-ok-text').textContent = 'Renaming…';
  $('rename-spinner').classList.remove('hidden');
  $('rename-error').classList.add('hidden');

  const dir     = currentPath === '/' ? '' : currentPath;
  const newPath = `${dir}/${newName}`;
  let result;
  try {
    result = dockerMode
      ? await window.api.dockerRename(dockerMode.id, ctxTarget.fullPath, newPath)
      : await window.api.rename(ctxTarget.fullPath, newPath);
  } catch (err) {
    result = { success: false, error: (err && err.message) || 'Rename failed.' };
  }

  $('rename-ok').disabled = false;
  $('rename-ok-text').textContent = 'Rename';
  $('rename-spinner').classList.add('hidden');

  if (!result || !result.success) {
    $('rename-error').textContent = dockerSafeError(result, 'Rename failed.');
    $('rename-error').classList.remove('hidden');
    return;
  }

  closeRename();
  loadDirectory(currentPath, false);
}

// ── Docker mode ────────────────────────────────────────────────────────────────
const DOCKER_MISSING_MSG = 'No docker containers found or maybe no docker installed';

let dockerMode      = null;   // null | { id, name, image }
let preDockerPath   = '/';    // SFTP path to return to after exiting container
let dockerDropdownOpen = false;
let dockerFetchGen = 0;

function isDockerUnavailable(result) {
  if (!result) return false;
  if (result.unavailable) return true;
  const text = typeof result === 'string' ? result : `${result.error || ''}\n${result.stderr || ''}`;
  return /\bdocker(?:\.exe)?:\s*(?:command\s+)?not found\b/i.test(text);
}

function dockerSafeError(result, fallback) {
  if (isDockerUnavailable(result)) return DOCKER_MISSING_MSG;
  if (result && result.error) return result.error;
  return fallback;
}

async function toggleDockerDropdown() {
  if (dockerDropdownOpen) { closeDockerDropdown(); return; }
  openDockerDropdown();
}

function openDockerDropdown() {
  dockerDropdownOpen = true;
  $('docker-dropdown').classList.remove('hidden');
  $('docker-list').innerHTML = '<div class="docker-loading">Loading…</div>';
  fetchContainers();
}

function closeDockerDropdown() {
  dockerDropdownOpen = false;
  $('docker-dropdown').classList.add('hidden');
}

async function fetchContainers() {
  const gen = ++dockerFetchGen;
  let result;
  try {
    result = await window.api.dockerContainers();
  } catch (err) {
    result = { success: false, error: (err && err.message) || 'Failed to list containers' };
  }

  // Dropdown was closed or a newer fetch started — don't overwrite it.
  if (!dockerDropdownOpen || gen !== dockerFetchGen) return;

  if (!result || isDockerUnavailable(result)) {
    $('docker-list').innerHTML = `<div class="docker-empty">${escHtml(DOCKER_MISSING_MSG)}</div>`;
    return;
  }
  if (!result.success) {
    $('docker-list').innerHTML = `<div class="docker-error">${escHtml(result.error || 'Failed to list containers')}</div>`;
    return;
  }
  if (!Array.isArray(result.containers) || result.containers.length === 0) {
    $('docker-list').innerHTML = '<div class="docker-empty">No containers found</div>';
    return;
  }

  $('docker-list').innerHTML = '';
  result.containers.forEach((c) => {
    const row = document.createElement('button');
    row.className = 'docker-row';
    row.innerHTML = `
      <span class="docker-status-dot ${c.running ? 'dot-running' : 'dot-stopped'}"></span>
      <span class="docker-row-info">
        <span class="docker-row-name">${escHtml(c.name)}</span>
        <span class="docker-row-image">${escHtml(c.image)}</span>
      </span>
      <span class="docker-row-status">${escHtml(c.status)}</span>
    `;
    row.addEventListener('click', () => {
      closeDockerDropdown();
      if (!c.running) {
        $('status-items').textContent = `⚠ Container "${c.name}" is not running`;
        setTimeout(() => $('status-items').textContent = '', 4000);
        return;
      }
      enterDockerMode(c);
    });
    $('docker-list').appendChild(row);
  });
}

async function enterDockerMode(container) {
  preDockerPath = currentPath;
  dockerMode    = { id: container.id, name: container.name, image: container.image };

  // Update UI
  $('btn-docker').classList.add('hidden');
  $('btn-docker-exit').classList.remove('hidden');
  $('btn-paste').classList.add('hidden');
  $('btn-paste-clear').classList.add('hidden');
  $('paste-sep').classList.add('hidden');

  const label = `${connectionInfo ? connectionInfo.username + '@' + connectionInfo.host + ' ' : ''}[🐳 ${container.name}]`;
  $('titlebar-title').textContent    = `SSH Explorer — ${label}`;
  $('status-connection').textContent = `🐳 ${container.name}  (${container.image})`;

  navHistory   = [];
  historyIndex = -1;
  await loadDirectory('/', true);
}

function exitDockerMode() {
  dockerMode = null;
  $('btn-docker').classList.remove('hidden');
  $('btn-docker-exit').classList.add('hidden');

  const info = connectionInfo;
  const connLabel = info ? `${info.username}@${info.host}` : '';
  $('titlebar-title').textContent    = `SSH Explorer — ${connLabel}`;
  $('status-connection').textContent = `Connected: ${connLabel}`;

  navHistory   = [];
  historyIndex = -1;
  loadDirectory(preDockerPath, true);
}

// ── Clipboard (server-side copy) ───────────────────────────────────────────────
let clipboardItem = null; // { name, fullPath }

function copyToClipboard() {
  if (!ctxTarget) return;
  clipboardItem = { name: ctxTarget.name, fullPath: ctxTarget.fullPath };
  $('paste-label').textContent  = clipboardItem.name;
  $('btn-paste').classList.remove('hidden');
  $('btn-paste-clear').classList.remove('hidden');
  $('paste-sep').classList.remove('hidden');
}

function clearClipboard() {
  clipboardItem = null;
  $('btn-paste').classList.add('hidden');
  $('btn-paste-clear').classList.add('hidden');
  $('paste-sep').classList.add('hidden');
}

async function runPaste() {
  if (!clipboardItem) return;

  // If pasting into the same directory, use "copy of " prefix to avoid collision
  const srcDir  = clipboardItem.fullPath.substring(0, clipboardItem.fullPath.lastIndexOf('/')) || '/';
  let destName  = clipboardItem.name;
  let destPath  = currentPath === '/' ? `/${destName}` : `${currentPath}/${destName}`;

  if (srcDir === currentPath) {
    destName = `copy of ${clipboardItem.name}`;
    destPath = currentPath === '/' ? `/${destName}` : `${currentPath}/${destName}`;
  }

  $('btn-paste').disabled = true;

  const result = await window.api.copy(clipboardItem.fullPath, destPath);

  $('btn-paste').disabled = false;

  if (result.success) {
    loadDirectory(currentPath, false);
    return;
  }

  if (result.needsSudo) {
    const src = clipboardItem.fullPath;
    const dst = destPath;
    openSudoModal(
      clipboardItem.name,
      'Copy with sudo',
      (pass) => window.api.copySudo(src, dst, pass)
    );
    return;
  }

  $('status-items').textContent = `⚠ ${result.error}`;
  setTimeout(() => loadDirectory(currentPath, false), 4000);
}

// ── Context Menu ───────────────────────────────────────────────────────────────
let ctxTarget = null; // { name, isDirectory, fullPath }

function showCtxMenu(x, y, file) {
  ctxTarget = {
    name: file.name,
    isDirectory: file.isDirectory,
    fullPath: currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`,
  };
  const menu = $('ctx-menu');
  menu.classList.remove('hidden');

  // Keep menu inside viewport
  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = 160, mh = 40;
  menu.style.left = (x + mw > vw ? vw - mw - 8 : x) + 'px';
  menu.style.top  = (y + mh > vh ? y - mh : y) + 'px';
}

function hideCtxMenu() {
  $('ctx-menu').classList.add('hidden');
}

// ── Delete flow ────────────────────────────────────────────────────────────────
function startDelete() {
  if (!ctxTarget) return;
  $('confirm-name').textContent = ctxTarget.name;
  $('confirm-ok-text').textContent = 'Delete';
  $('confirm-spinner').classList.add('hidden');
  $('confirm-ok').disabled = false;
  $('confirm-backdrop').classList.remove('hidden');
}

function closeConfirm() {
  $('confirm-backdrop').classList.add('hidden');
}

async function runDelete() {
  if (!ctxTarget) return;
  $('confirm-ok').disabled    = true;
  $('confirm-ok-text').textContent = 'Deleting…';
  $('confirm-spinner').classList.remove('hidden');

  let result;
  try {
    result = dockerMode
      ? await window.api.dockerDelete(dockerMode.id, ctxTarget.fullPath)
      : await window.api.delete(ctxTarget.fullPath);
  } catch (err) {
    result = { success: false, error: (err && err.message) || 'Delete failed.' };
  }

  $('confirm-ok').disabled         = false;
  $('confirm-ok-text').textContent = 'Delete';
  $('confirm-spinner').classList.add('hidden');
  closeConfirm();

  if (result && result.success) {
    loadDirectory(currentPath, false);
    return;
  }

  if (!dockerMode && result.needsSudo) {
    openSudoModal(
      ctxTarget.name,
      'Delete with sudo',
      (pass) => window.api.deleteSudo(ctxTarget.fullPath, pass)
    );
    return;
  }

  // Generic error — show briefly in status bar
  $('status-items').textContent = `⚠ ${dockerSafeError(result, 'Delete failed.')}`;
  setTimeout(() => {
    $('status-items').textContent = `${currentFiles.length} items`;
  }, 4000);
}

// Generic sudo modal — set pendingSudoAction before opening
let pendingSudoAction = null; // async (password) => { success, wrongPassword, error }
let sudoActionLabel   = 'Confirm';

function openSudoModal(itemName, actionLabel, action) {
  pendingSudoAction = action;
  sudoActionLabel   = actionLabel;
  $('sudo-item-name').textContent  = itemName || '';
  $('sudo-pass-input').value       = '';
  $('sudo-error').classList.add('hidden');
  $('sudo-ok').disabled            = false;
  $('sudo-ok-text').textContent    = actionLabel;
  $('sudo-spinner').classList.add('hidden');
  $('sudo-backdrop').classList.remove('hidden');
  setTimeout(() => $('sudo-pass-input').focus(), 50);
}

function closeSudo() {
  $('sudo-backdrop').classList.add('hidden');
  $('sudo-pass-input').value = '';
  pendingSudoAction = null;
}

async function runSudoAction() {
  if (!pendingSudoAction) return;
  const pass = $('sudo-pass-input').value;
  if (!pass) {
    $('sudo-error').textContent = 'Please enter the sudo password.';
    $('sudo-error').classList.remove('hidden');
    return;
  }

  $('sudo-ok').disabled            = true;
  $('sudo-ok-text').textContent    = 'Working…';
  $('sudo-spinner').classList.remove('hidden');
  $('sudo-error').classList.add('hidden');

  const result = await pendingSudoAction(pass);

  $('sudo-ok').disabled            = false;
  $('sudo-ok-text').textContent    = sudoActionLabel;
  $('sudo-spinner').classList.add('hidden');

  if (result.success) {
    closeSudo();
    loadDirectory(currentPath, false);
    return;
  }

  $('sudo-error').textContent = result.wrongPassword
    ? 'Incorrect sudo password. Try again.'
    : (result.error || 'Operation failed.');
  $('sudo-error').classList.remove('hidden');
  $('sudo-pass-input').value = '';
  $('sudo-pass-input').focus();
}

// ── Drag overlay ───────────────────────────────────────────────────────────────
function showDragOverlay(on) {
  $('drag-dest').textContent = dockerMode
    ? `🐳 ${dockerMode.name}:${currentPath}`
    : currentPath;
  $('drag-overlay').classList.toggle('hidden', !on);
}

// ── Upload ─────────────────────────────────────────────────────────────────────
const uploadJobs = new Map(); // localPath → { name, total, transferred, status, el }
let uploadDoneTimer = null;

async function handleUpload(files) {
  const panel = $('upload-panel');
  const list  = $('upload-list');

  // Register all jobs first so the panel shows immediately
  files.forEach((file) => {
    const localPath = window.api.getFilePath(file);
    if (!localPath) return;
    const row = document.createElement('div');
    row.className = 'upload-row';
    row.innerHTML = `
      <span class="up-name" title="${escHtml(file.name)}">${escHtml(file.name)}</span>
      <div class="up-bar-wrap"><div class="up-bar" style="width:0%"></div></div>
      <span class="up-pct">0%</span>
      <span class="up-status up-waiting">waiting</span>
    `;
    list.appendChild(row);
    uploadJobs.set(localPath, { name: file.name, total: file.size || 0, transferred: 0, status: 'waiting', el: row });
  });

  $('upload-panel-title').textContent = `Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`;
  panel.classList.remove('hidden');
  if (uploadDoneTimer) { clearTimeout(uploadDoneTimer); uploadDoneTimer = null; }

  // Upload sequentially
  for (const file of files) {
    const localPath  = window.api.getFilePath(file);
    if (!localPath) continue;
    const job = uploadJobs.get(localPath);

    setUploadStatus(job, 'uploading');

    // In docker mode: upload to server /tmp then docker cp into container
    // In normal mode: upload directly via SFTP
    const remotePath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
    let result;
    try {
      result = dockerMode
        ? await window.api.dockerUpload(localPath, dockerMode.id, currentPath)
        : await window.api.upload(localPath, remotePath);
    } catch (err) {
      result = { success: false, error: (err && err.message) || 'Upload failed.' };
    }

    if (result && result.success) {
      setUploadStatus(job, 'done');
      job.el.querySelector('.up-bar').style.width = '100%';
      job.el.querySelector('.up-pct').textContent = '100%';
    } else {
      setUploadStatus(job, 'error', dockerSafeError(result, 'Upload failed.'));
    }
  }

  // Refresh directory
  loadDirectory(currentPath, false);

  const allOk = [...uploadJobs.values()].every((j) => j.status === 'done');
  $('upload-panel-title').textContent = allOk ? 'Upload complete' : 'Upload finished (with errors)';

  if (allOk) {
    uploadDoneTimer = setTimeout(() => {
      $('upload-panel').classList.add('hidden');
      $('upload-list').innerHTML = '';
      uploadJobs.clear();
    }, 3000);
  }
}

function updateUploadProgress(localPath, transferred, total) {
  const job = uploadJobs.get(localPath);
  if (!job) return;
  job.transferred = transferred;
  job.total       = total || job.total;
  const pct       = job.total > 0 ? Math.round((transferred / job.total) * 100) : 0;
  job.el.querySelector('.up-bar').style.width  = `${pct}%`;
  job.el.querySelector('.up-pct').textContent  = `${pct}%`;
}

function setUploadStatus(job, status, errorMsg) {
  job.status = status;
  const statusEl  = job.el.querySelector('.up-status');
  statusEl.className = `up-status up-${status}`;
  statusEl.textContent = status === 'error' ? (errorMsg || 'error') : status;
}

// Close preview
function closePreview() {
  $('preview-backdrop').classList.add('hidden');
}
