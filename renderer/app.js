// ── State ──────────────────────────────────────────────────────────────────────
let currentPath   = '/';
let navHistory    = [];
let historyIndex  = -1;
let viewMode      = 'grid';   // 'grid' | 'list'
let currentFiles  = [];
let connectionInfo = null;
let isLoading     = false;

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

  // Allow Enter in any field to submit
  ['input-host', 'input-username', 'input-port', 'input-password'].forEach((id) => {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('connect-form').dispatchEvent(new Event('submit'));
    });
  });
}

function bindExplorerControls() {
  $('btn-back').addEventListener('click',    () => navigateHistory(-1));
  $('btn-forward').addEventListener('click', () => navigateHistory(1));
  $('btn-up').addEventListener('click',      navigateUp);
  $('btn-refresh').addEventListener('click', () => loadDirectory(currentPath, false));
  $('btn-disconnect').addEventListener('click', handleDisconnect);
  $('btn-retry').addEventListener('click',   () => loadDirectory(currentPath, false));
  $('btn-view-grid').addEventListener('click', () => setViewMode('grid'));
  $('btn-view-list').addEventListener('click', () => setViewMode('list'));

  // Preview modal close
  $('preview-close').addEventListener('click', closePreview);
  $('preview-backdrop').addEventListener('click', (e) => {
    if (e.target === $('preview-backdrop')) closePreview();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePreview();
  });
}

// ── Connect ────────────────────────────────────────────────────────────────────
async function handleConnect() {
  const host     = $('input-host').value.trim();
  const username = $('input-username').value.trim();
  const password = $('input-password').value;
  const port     = parseInt($('input-port').value, 10) || 22;

  if (!host || !username || !password) {
    showConnectError('Please fill in host, username and password.');
    return;
  }

  setConnecting(true);
  clearConnectError();

  const result = await window.api.connect({ host, username, password, port });

  if (!result.success) {
    setConnecting(false);
    showConnectError(result.error || 'Connection failed.');
    return;
  }

  connectionInfo = { host, username, port };
  $('titlebar-title').textContent = `SSH Explorer — ${username}@${host}`;
  $('status-connection').textContent = `Connected: ${username}@${host}:${port}`;

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

  const result = await window.api.readdir(dirPath);

  setLoading(false);
  isLoading = false;

  if (!result.success) {
    showFileError(result.error || 'Failed to read directory.');
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

    const icon    = getFileIcon(file.name, file.isDirectory, file.isSymlink);
    const sizeStr = file.isDirectory ? '' : formatSize(file.size);
    const dateStr = file.mtime ? formatDate(file.mtime * 1000) : '';

    if (viewMode === 'list') {
      item.innerHTML = `
        <span class="fi-icon">${icon}</span>
        <span class="fi-name" title="${escHtml(file.name)}">${escHtml(file.name)}</span>
        <span class="fi-size">${sizeStr}</span>
        <span class="fi-date">${dateStr}</span>
      `;
    } else {
      item.innerHTML = `
        <span class="fi-icon-large">${icon}</span>
        <span class="fi-name-grid" title="${escHtml(file.name)}">${escHtml(file.name)}</span>
      `;
    }

    if (file.isDirectory) {
      item.addEventListener('dblclick', () => {
        const newPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
        loadDirectory(newPath);
      });
    } else {
      item.addEventListener('dblclick', () => {
        const filePath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
        openPreview(filePath, file.name, file.size);
      });
    }

    item.addEventListener('click', () => {
      container.querySelectorAll('.file-item.selected').forEach((el) => el.classList.remove('selected'));
      item.classList.add('selected');
    });

    container.appendChild(item);
  });
}

function setViewMode(mode) {
  viewMode = mode;
  $('btn-view-grid').classList.toggle('active', mode === 'grid');
  $('btn-view-list').classList.toggle('active', mode === 'list');
  renderFiles(currentFiles);
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

  const result = await window.api.readfile(filePath);

  loading.classList.add('hidden');

  if (!result.success) {
    errEl.textContent = result.error || 'Could not read file.';
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

// Close preview
function closePreview() {
  $('preview-backdrop').classList.add('hidden');
}
