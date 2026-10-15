// ── State ──────────────────────────────────────────────────────────────────────
let currentPath   = '/';
let navHistory    = [];
let historyIndex  = -1;
let viewMode      = 'list';   // 'grid' | 'list'
let currentFiles  = [];
let connectionInfo = null;
let connectionChain = [];
let serverExitInProgress = false;
let isLoading     = false;

// Main-form history and per-source-server hop history. Passwords are never stored.
// Kept in memory for the session and mirrored to the app user-data file.
let lastDirectConnect = null;
const lastHopFromServer = new Map();
let formMemoryReady = false;
let formMemorySaveTimer = null;

// Windows Explorer type-ahead: letters accumulate for a short window.
// Repeating one letter walks every name that starts with it, then wraps.
const TYPE_AHEAD_MS = 1000;
let typeAheadQuery = '';
let typeAheadAt = 0;

// In-memory find query for this app session. Closing the bar or changing
// directory does not erase it, and it is not written to disk.
let findState = window.appSearch.createFindState();
let findEditorMatches = [];
let editorCharWidth = { key: '', width: 8 };

const $ = (id) => document.getElementById(id);

// ── Boot ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  bindWindowControls();
  bindExplorerControls();
  await loadPersistedFormMemory();
  applyLastDirectConnect();
  document.documentElement.dataset.formMemory = 'ready';
  bindConnectForm();
  window.addEventListener('beforeunload', flushFormMemoryFromForm);
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
    captureDirectConnectFromForm();
  });

  // Latest non-password main-form values replace the saved ones.
  [
    'input-host', 'input-username', 'input-port',
    'jump-host', 'jump-username', 'jump-port',
  ].forEach((id) => {
    $(id).addEventListener('input', captureDirectConnectFromForm);
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
  $('btn-exit').addEventListener('click', handleExit);
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
  document.addEventListener('contextmenu', (e) => {
    if (e.target && e.target.id === 'editor-text') return;
    e.preventDefault();
  });
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

  $('elevate-cancel').addEventListener('click', cancelElevatedSave);
  $('elevate-backdrop').addEventListener('click', (e) => { if (e.target === $('elevate-backdrop')) cancelElevatedSave(); });
  $('elevate-ok').addEventListener('click', runElevatedSave);
  $('elevate-user-input').addEventListener('input', refreshElevatePasswordLabel);
  $('elevate-user-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('elevate-pass-input').focus();
    }
  });
  $('elevate-pass-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runElevatedSave(); });

  $('editor-save').addEventListener('click', () => saveRemoteEditor({ exitAfter: false, force: false }));
  $('editor-exit').addEventListener('click', requestRemoteEditorExit);
  $('editor-save-exit').addEventListener('click', () => saveRemoteEditor({ exitAfter: true, force: false }));
  $('editor-discard-exit').addEventListener('click', discardRemoteEditor);
  $('editor-conflict-cancel').addEventListener('click', dismissRemoteConflict);
  $('editor-conflict-overwrite').addEventListener('click', () => {
    saveRemoteEditor({ exitAfter: remoteEditor.pendingExit, force: true });
  });
  $('editor-text').addEventListener('input', refreshRemoteEditorDirty);
  $('editor-text').addEventListener('scroll', () => {
    if (findState.open && findState.mode === 'editor') paintEditorFind(false);
  });
  window.addEventListener('resize', () => {
    if (findState.open && findState.mode === 'editor') paintEditorFind(false);
  });
  $('find-input').addEventListener('input', onFindInput);
  $('find-close').addEventListener('click', () => closeFindBar());
  $('find-next').addEventListener('click', () => stepFind(1));
  $('find-prev').addEventListener('click', () => stepFind(-1));
  // Capture phase, and before the editor handler, so Ctrl/Cmd+F and Escape
  // close or focus search without saving, exiting, or opening Chromium find.
  document.addEventListener('keydown', handleFindKeydown, true);
  document.addEventListener('keydown', handleRemoteEditorKeydown, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (remoteEditor.open) return;
      closePreview(); closeHopModal(); closeConfirm(); closeSudo(); closeRename();
    }
    if (handleFileListKey(e)) return;
    handleTypeAheadKey(e);
  });

  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('#file-container')) return;
    const item = focusedFileItem();
    clearFileSelection();
    if (item && !isFocusableControl(e.target)) item.blur();
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

  connectionChain = [{ host, username, port, jump }];
  connectionInfo = connectionChain[0];
  rememberDirectConnect({ host, username, port, jump });
  if (remoteEditor.open) closeRemoteEditor();
  clearDockerChrome();
  refreshConnectionChrome();

  navHistory   = [];
  historyIndex = -1;

  showScreen('explorer');

  const homeResult = await window.api.homedir();
  const homePath   = (homeResult.success && homeResult.path) ? homeResult.path : '/';
  await loadDirectory(homePath, true, true);
}

async function handleDisconnect() {
  leaveEditorThen(() => { void finishDisconnect(); });
}

async function finishDisconnect() {
  clearDockerChrome();
  await window.api.disconnect();
  resetToConnectScreen();
}

function connectionLabel(info) {
  if (!info) return '';
  if (info.jump) {
    return `${info.username}@${info.host} via ${info.jump.username}@${info.jump.host}`;
  }
  if (info.via) {
    return `${info.username}@${info.host} (via ${info.via})`;
  }
  return `${info.username}@${info.host}`;
}

function refreshConnectionChrome() {
  const exitBtn = $('btn-exit');
  const nested = connectionChain.length > 1;
  exitBtn.classList.toggle('hidden', !nested);
  if (nested) {
    const prev = connectionChain[connectionChain.length - 2];
    exitBtn.title = `Return to ${prev.username}@${prev.host}`;
  } else {
    exitBtn.title = 'Return to the previous server';
  }

  if (!connectionInfo) {
    $('titlebar-title').textContent = 'SSH Explorer';
    $('status-connection').textContent = 'Not connected';
    return;
  }

  const label = connectionLabel(connectionInfo);
  $('titlebar-title').textContent = `SSH Explorer — ${label}`;
  $('status-connection').textContent = `Connected: ${label}`;
}

function clearDockerChrome() {
  dockerMode = null;
  $('btn-docker').classList.remove('hidden');
  $('btn-docker-exit').classList.add('hidden');
  if (clipboardItem) {
    $('btn-paste').classList.remove('hidden');
    $('btn-paste-clear').classList.remove('hidden');
    $('paste-sep').classList.remove('hidden');
  }
}

function resetToConnectScreen(errorMessage) {
  connectionInfo = null;
  connectionChain = [];
  navHistory = [];
  historyIndex = -1;
  currentFiles = [];
  clearDockerChrome();
  if (remoteEditor.open) closeRemoteEditor();
  closeFindBar({ restoreEditorFocus: false, rerender: false });
  closePreview();
  closeHopModal();
  clearClipboard();
  $('file-container').innerHTML = '';
  $('status-items').textContent = '';
  setConnecting(false);
  applyLastDirectConnect();
  showScreen('connect');
  refreshConnectionChrome();
  if (errorMessage) showConnectError(errorMessage);
  else clearConnectError();
}

async function handleExit() {
  if (serverExitInProgress) return;
  if (remoteEditor.open) {
    if (remoteEditor.saving || elevateDialogOpen()) return;
    if (editorIsDirty()) {
      requestRemoteEditorExit();
      return;
    }
    closeRemoteEditor();
  }

  if (connectionChain.length <= 1) {
    await handleDisconnect();
    return;
  }

  serverExitInProgress = true;
  $('btn-exit').disabled = true;
  try {
    const result = await window.api.exit();
    if (!result || result.disconnected || !result.success) {
      resetToConnectScreen(result && result.error);
      return;
    }

    connectionChain.pop();
    connectionInfo = connectionChain[connectionChain.length - 1] || null;
    if (!connectionInfo) {
      resetToConnectScreen();
      return;
    }
    if (result.connection) {
      connectionInfo.host = result.connection.host || connectionInfo.host;
      connectionInfo.username = result.connection.username || connectionInfo.username;
      connectionInfo.port = result.connection.port || connectionInfo.port;
    }

    clearDockerChrome();
    closePreview();
    closeHopModal();
    clearClipboard();
    refreshConnectionChrome();

    navHistory = [];
    historyIndex = -1;
    closeFindBar({ restoreEditorFocus: false, rerender: false });
    const homeResult = await window.api.homedir();
    const homePath = (homeResult.success && homeResult.path) ? homeResult.path : '/';
    await loadDirectory(homePath, true, true);
  } finally {
    serverExitInProgress = false;
    $('btn-exit').disabled = false;
  }
}

function serverMemoryKey(info) {
  if (!info || !info.host || !info.username) return '';
  return `${info.username}@${info.host}:${info.port || 22}`;
}

function rememberDirectConnect({ host, username, port, jump }) {
  lastDirectConnect = {
    host,
    username,
    port: port || 22,
    jump: jump
      ? { host: jump.host, username: jump.username, port: jump.port || 22 }
      : null,
  };
  persistFormMemoryNow();
}

function captureDirectConnectFromForm() {
  if (!formMemoryReady) return;
  const useJump = $('chk-jump').checked;
  lastDirectConnect = {
    host: $('input-host').value.trim(),
    username: $('input-username').value.trim(),
    port: parseInt($('input-port').value, 10) || 22,
    jump: useJump
      ? {
          host: $('jump-host').value.trim(),
          username: $('jump-username').value.trim(),
          port: parseInt($('jump-port').value, 10) || 22,
        }
      : null,
  };
  schedulePersistFormMemory();
}

function formMemoryPayload() {
  const hops = {};
  for (const [key, value] of lastHopFromServer) {
    if (!value) continue;
    hops[key] = {
      host: value.host,
      username: value.username,
      port: value.port || 22,
    };
  }

  if (!lastDirectConnect) return { direct: null, hops };

  return {
    direct: {
      host: lastDirectConnect.host,
      username: lastDirectConnect.username,
      port: lastDirectConnect.port || 22,
      jump: lastDirectConnect.jump
        ? {
            host: lastDirectConnect.jump.host,
            username: lastDirectConnect.jump.username,
            port: lastDirectConnect.jump.port || 22,
          }
        : null,
    },
    hops,
  };
}

async function loadPersistedFormMemory() {
  let data = null;
  try {
    data = await window.api.loadFormMemory();
  } catch {
    data = null;
  }

  lastDirectConnect = data && data.direct ? data.direct : null;
  lastHopFromServer.clear();
  const hops = data && data.hops;
  if (hops && typeof hops === 'object') {
    for (const [key, value] of Object.entries(hops)) {
      lastHopFromServer.set(key, value);
    }
  }
  formMemoryReady = true;
}

function schedulePersistFormMemory() {
  if (!formMemoryReady) return;
  clearTimeout(formMemorySaveTimer);
  formMemorySaveTimer = setTimeout(() => {
    formMemorySaveTimer = null;
    window.api.saveFormMemory(formMemoryPayload()).catch(() => {});
  }, 150);
}

function persistFormMemoryNow() {
  if (!formMemoryReady) return;
  clearTimeout(formMemorySaveTimer);
  formMemorySaveTimer = null;
  try {
    window.api.flushFormMemory(formMemoryPayload());
  } catch {
    // The in-session values still apply if the file cannot be written.
  }
}

function flushFormMemoryFromForm() {
  if (!formMemoryReady) return;
  captureDirectConnectFromForm();
  persistFormMemoryNow();
}

function setJumpFieldsVisible(on) {
  $('chk-jump').checked = on;
  $('jump-section').classList.toggle('hidden', !on);
  $('password-optional').classList.toggle('hidden', !on);
}

function applyLastDirectConnect() {
  $('input-password').value = '';
  $('jump-password').value = '';

  const saved = lastDirectConnect;
  if (!saved) return;

  $('input-host').value = saved.host;
  $('input-username').value = saved.username;
  $('input-port').value = String(saved.port || 22);

  if (saved.jump) {
    setJumpFieldsVisible(true);
    $('jump-host').value = saved.jump.host;
    $('jump-username').value = saved.jump.username;
    $('jump-port').value = String(saved.jump.port || 22);
  } else {
    setJumpFieldsVisible(false);
    $('jump-host').value = '';
    $('jump-username').value = '';
    $('jump-port').value = '22';
  }
}

// ── Hop Modal ──────────────────────────────────────────────────────────────────
function openHopModal() {
  const remembered = connectionInfo
    ? lastHopFromServer.get(serverMemoryKey(connectionInfo))
    : null;

  $('hop-input-password').value = '';
  if (remembered) {
    $('hop-input-host').value = remembered.host;
    $('hop-input-username').value = remembered.username;
    $('hop-input-port').value = String(remembered.port || 22);
  } else {
    $('hop-input-host').value = '';
    $('hop-input-username').value = '';
    $('hop-input-port').value = '22';
  }
  $('hop-error').classList.add('hidden');
  $('hop-backdrop').classList.remove('hidden');
  const focusId = remembered ? 'hop-input-password' : 'hop-input-host';
  setTimeout(() => $(focusId).focus(), 50);
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

  leaveEditorThen(() => { void performHop(host, username, password, port); });
}

async function performHop(host, username, password, port) {
  const returnPath = dockerMode ? (preDockerPath || '/') : currentPath;
  const wasDocker = !!dockerMode;
  closeFindBar({ restoreEditorFocus: false });
  clearDockerChrome();
  closePreview();

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
    if (wasDocker) await loadDirectory(returnPath, true, true);
    return;
  }

  // Success — remember this hop for the server we left, then update UI.
  const sourceKey = serverMemoryKey(connectionInfo);
  if (sourceKey) {
    lastHopFromServer.set(sourceKey, { host, username, port: port || 22 });
    persistFormMemoryNow();
  }

  const prevLabel = connectionInfo
    ? `${connectionInfo.username}@${connectionInfo.host}`
    : 'previous server';
  connectionInfo = { host, username, port, via: prevLabel };
  connectionChain.push(connectionInfo);
  refreshConnectionChrome();

  closeHopModal();

  navHistory   = [];
  historyIndex = -1;
  const homeResult = await window.api.homedir();
  const homePath   = (homeResult.success && homeResult.path) ? homeResult.path : '/';
  await loadDirectory(homePath, true, true);
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
async function loadDirectory(dirPath, pushHistory = true, focusFirst = false) {
  if (isLoading) return;
  isLoading = true;

  if (dirPath !== currentPath) closeFindBar({ restoreEditorFocus: false });

  setLoading(true);
  hideFileError();
  $('empty-msg').classList.add('hidden');
  $('find-empty-msg').classList.add('hidden');

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
  renderBrowser();
  if (focusFirst) focusFirstFileItem();
}

function navigateHistory(delta) {
  const newIndex = historyIndex + delta;
  if (newIndex < 0 || newIndex >= navHistory.length) return;
  historyIndex = newIndex;
  loadDirectory(navHistory[newIndex], false, true);
}

function navigateUp() {
  if (currentPath === '/') return;
  const parts  = currentPath.replace(/\/$/, '').split('/');
  parts.pop();
  const parent = parts.join('/') || '/';
  loadDirectory(parent, true, true);
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
      span.addEventListener('click', () => loadDirectory(snapPath, true, true));
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
function renderBrowser() {
  const files = window.appSearch.directoryResults(findState, currentFiles);
  const filtering = window.appSearch.browserIsFiltered(findState);
  if (filtering) {
    findState.matchIndex = window.appSearch.clampMatchIndex(findState.matchIndex, files.length);
  }
  renderFiles(files, {
    query: filtering ? findState.query : '',
    currentIndex: filtering ? findState.matchIndex : -1,
  });
  if (findState.open && findState.mode === 'browser') updateFindCount(findState.matchIndex, filtering ? files.length : 0);
  updateItemStatus(files.length);
  syncFindButtons();
}

function updateItemStatus(shownCount) {
  if (window.appSearch.browserIsFiltered(findState)) {
    $('status-items').textContent = shownCount
      ? `${shownCount} matching item${shownCount === 1 ? '' : 's'}`
      : window.appSearch.NO_DIRECTORY_MATCHES;
    return;
  }
  const count = currentFiles.length;
  $('status-items').textContent = `${count} item${count !== 1 ? 's' : ''}`;
}

function renderFiles(files, findOpts) {
  resetTypeAhead();
  const query = findOpts && findOpts.query ? String(findOpts.query) : '';
  const currentIndex = findOpts && Number.isInteger(findOpts.currentIndex) ? findOpts.currentIndex : -1;
  const container      = $('file-container');
  container.innerHTML  = '';
  container.className  = viewMode === 'list' ? 'file-list' : 'file-grid';

  if (files.length === 0) {
    $('empty-msg').classList.toggle('hidden', !!query);
    $('find-empty-msg').classList.toggle('hidden', !query);
    return;
  }

  $('empty-msg').classList.add('hidden');
  $('find-empty-msg').classList.add('hidden');

  container.setAttribute('role', 'listbox');
  container.setAttribute('aria-label', 'Folder contents');

  files.forEach((file, index) => {
    const item         = document.createElement('div');
    item.className     = 'file-item';
    item.dataset.name  = file.name;
    item.dataset.isDir = file.isDirectory;
    // Focusable for Enter, arrows, and Tab, but not in the normal tab order.
    // Tab moves between rows only while one is already focused.
    item.tabIndex = -1;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', 'false');

    const icon     = getFileIcon(file.name, file.isDirectory, file.isSymlink);
    const sizeStr  = file.isDirectory ? '' : formatSize(file.size);
    const dateStr  = file.mtime ? formatDate(file.mtime * 1000) : '';
    const badgeHtml = file.linkedAs
      ? file.linkedAs.map((lnk) => `<span class="file-badge${isProdLink(lnk) ? ' file-badge-prod' : ''}">\u2192 ${escHtml(lnk)}</span>`).join('')
      : '';

    const nameHtml = fileNameHtml(file.name, query);
    const kindHtml = query
      ? (file.isDirectory
        ? '<span class="find-kind">Folder</span>'
        : '<span class="find-kind find-kind-file">File</span>')
      : '';
    item.setAttribute('aria-label', `${file.name}, ${file.isDirectory ? 'folder' : 'file'}`);
    if (index === currentIndex) item.classList.add('find-current');

    if (viewMode === 'list') {
      item.innerHTML = `
        <span class="fi-icon">${icon}</span>
        <span class="fi-name" title="${escHtml(file.name)}"><span class="fi-name-text">${nameHtml}</span>${kindHtml}${badgeHtml ? ' ' + badgeHtml : ''}</span>
        <span class="fi-size">${sizeStr}</span>
        <span class="fi-date">${dateStr}</span>
      `;
    } else {
      item.innerHTML = `
        <span class="fi-icon-large">${icon}</span>
        ${badgeHtml ? `<span class="fi-badges">${badgeHtml}</span>` : ''}
        ${kindHtml}
        <span class="fi-name-grid" title="${escHtml(file.name)}">${nameHtml}</span>
      `;
    }

    // isDirectory is true for real dirs AND symlinks-to-dirs (resolved in main)
    item.addEventListener('dblclick', () => activateFileItem(item));

    item.addEventListener('focusout', (e) => {
      const next = e.relatedTarget;
      // Keep the highlight when focus stays in the list, or when the window
      // itself blurs (relatedTarget is null) so Alt-Tab does not drop it.
      if (!next || (next.closest && next.closest('#file-container'))) return;
      item.classList.remove('selected');
      item.setAttribute('aria-selected', 'false');
    });

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

function focusFirstFileItem() {
  const first = $('file-container').querySelector('.file-item');
  if (first) selectFileItem(first, true);
}

function selectFileItem(item, reveal) {
  const container = $('file-container');
  container.querySelectorAll('.file-item.selected').forEach((el) => {
    el.classList.remove('selected');
    el.setAttribute('aria-selected', 'false');
  });
  item.classList.add('selected');
  item.setAttribute('aria-selected', 'true');
  item.focus({ preventScroll: true });
  if (reveal) item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function remoteChildPath(name) {
  return currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
}

function activateFileItem(item) {
  const file = currentFiles.find((f) => f.name === item.dataset.name);
  if (!file) return;
  const filePath = remoteChildPath(file.name);
  closeFindBar({ restoreEditorFocus: false });
  if (file.isDirectory) {
    loadDirectory(filePath, true, true);
    return;
  }
  if (file.isSymlink) return;
  // Known binary types stay on the preview. Container text files use the same
  // editor as server files, and the save path is chosen from the open target.
  if (isReadOnlyExtension(file.name)) {
    openPreview(filePath, file.name, file.size);
  } else {
    openRemoteEditor(filePath, file.name, file.size);
  }
}

function focusedFileItem() {
  const el = document.activeElement;
  if (!el || !el.classList || !el.classList.contains('file-item')) return null;
  if (!el.closest('#file-container')) return null;
  return el;
}

function nextFileItem(current, delta) {
  const container = $('file-container');
  const items = Array.from(container.querySelectorAll('.file-item'));
  const index = items.indexOf(current);
  if (index < 0) return null;

  if (viewMode !== 'grid') {
    const next = index + delta;
    if (next < 0 || next >= items.length) return null;
    return items[next];
  }

  const cur = current.getBoundingClientRect();
  const cx = cur.left + cur.width / 2;
  const cy = cur.top + cur.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const item of items) {
    if (item === current) continue;
    const rect = item.getBoundingClientRect();
    const dx = (rect.left + rect.width / 2) - cx;
    const dy = (rect.top + rect.height / 2) - cy;
    if (delta > 0 ? dy <= 2 : dy >= -2) continue;
    const score = Math.abs(dx) * 8 + Math.abs(dy);
    if (score < bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

function clearFileSelection() {
  const container = $('file-container');
  if (!container) return;
  container.querySelectorAll('.file-item.selected').forEach((el) => {
    el.classList.remove('selected');
    el.setAttribute('aria-selected', 'false');
  });
}

function isFocusableControl(el) {
  if (!el || !el.closest) return false;
  const stop = el.closest('button, a[href], input, select, textarea, [tabindex]');
  if (!stop || stop.disabled || stop.tabIndex < 0) return false;
  return true;
}

function moveFileFocus(item, delta) {
  const next = nextFileItem(item, delta);
  if (!next) return;
  hideCtxMenu();
  resetTypeAhead();
  selectFileItem(next, true);
}

function releaseFileFocus(item) {
  hideCtxMenu();
  resetTypeAhead();
  clearFileSelection();
  if (document.activeElement === item) item.blur();
}

function handleFileListKey(e) {
  const item = focusedFileItem();
  if (!item) return false;
  if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return false;
  if (!$('explorer-screen').classList.contains('active')) return false;
  if (isBlockingOverlayOpen()) return false;

  if (e.key === 'Enter') {
    e.preventDefault();
    hideCtxMenu();
    activateFileItem(item);
    return true;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    releaseFileFocus(item);
    return true;
  }

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveFileFocus(item, e.key === 'ArrowDown' ? 1 : -1);
    return true;
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    moveFileFocus(item, e.shiftKey ? -1 : 1);
    return true;
  }

  return false;
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
  return [
    'preview-backdrop', 'hop-backdrop', 'confirm-backdrop', 'rename-backdrop', 'sudo-backdrop',
    'elevate-backdrop', 'editor-backdrop', 'editor-confirm-backdrop', 'editor-conflict-backdrop',
  ].some((id) => !$(id).classList.contains('hidden'));
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
  renderBrowser();
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
  showPreviewChrome(fileName, fileSize);

  let result;
  try {
    result = dockerMode
      ? await window.api.dockerReadfile(dockerMode.id, filePath)
      : await window.api.readfile(filePath);
  } catch (err) {
    result = { success: false, error: (err && err.message) || 'Could not read file.' };
  }

  renderPreviewResult(fileName, result);
}

function showPreviewChrome(fileName, fileSize) {
  const backdrop = $('preview-backdrop');
  const icon     = $('preview-icon');
  const nameEl   = $('preview-filename');
  const sizeEl   = $('preview-size');
  const loading  = $('preview-loading');
  const errEl    = $('preview-error');
  const content  = $('preview-content');

  icon.textContent    = getFileIcon(fileName, false, false);
  nameEl.textContent  = fileName;
  sizeEl.textContent  = fileSize ? formatSize(fileSize) : '';
  content.innerHTML   = '';
  errEl.textContent   = '';

  loading.classList.remove('hidden');
  errEl.classList.add('hidden');
  content.classList.add('hidden');
  backdrop.classList.remove('hidden');
}

function renderPreviewResult(fileName, result) {
  const loading = $('preview-loading');
  const errEl   = $('preview-error');
  const content = $('preview-content');

  loading.classList.add('hidden');

  if (!result || !result.success) {
    errEl.textContent = dockerSafeError(result, 'Could not read file.');
    errEl.classList.remove('hidden');
    content.classList.add('hidden');
    return;
  }

  const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  content.innerHTML = renderFileContent(result.content, ext);
  content.classList.remove('hidden');
  errEl.classList.add('hidden');
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

// ── Remote text editor (SFTP host files and Docker container files) ───────────
const READ_ONLY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tif', 'tiff',
  'mp3', 'wav', 'flac', 'ogg', 'mp4', 'mkv', 'avi', 'mov', 'webm',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z', 'iso',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'exe', 'dll', 'so', 'dylib', 'bin', 'deb', 'rpm', 'apk', 'class', 'pyc', 'o', 'a',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
]);

function isReadOnlyExtension(name) {
  const base = String(name || '').split('/').pop();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return READ_ONLY_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

const remoteEditor = {
  gen: 0,
  open: false,
  loaded: false,
  saving: false,
  pendingExit: false,
  pendingLeave: null,
  path: '',
  baseline: '',
  newline: 'lf',
  mtime: null,
  size: null,
  sessionKey: '',
  targetKind: 'sftp',
  containerId: '',
  containerName: '',
  statusTimer: null,
};

function currentConnectionKey() {
  if (!connectionInfo) return '';
  return `${connectionInfo.username}@${connectionInfo.host}:${connectionInfo.port || 22}`;
}

function currentEditorTarget() {
  if (dockerMode && dockerMode.id) {
    return {
      kind: 'docker',
      containerId: dockerMode.id,
      containerName: dockerMode.name || '',
    };
  }
  return { kind: 'sftp', containerId: '', containerName: '' };
}

function currentSessionKey() {
  return window.editorState.editingSessionKey(currentConnectionKey(), currentEditorTarget());
}

function editorLocation(filePath) {
  if (remoteEditor.targetKind !== 'docker') return filePath;
  const name = remoteEditor.containerName || remoteEditor.containerId || 'container';
  return `${name}:${filePath}`;
}

function presentEditorError(result, fallback) {
  if (remoteEditor.targetKind === 'docker') return dockerSafeError(result, fallback);
  return (result && result.error) || fallback;
}

function captureCaret(el) {
  return {
    start: el.selectionStart,
    end: el.selectionEnd,
    scrollTop: el.scrollTop,
    scrollLeft: el.scrollLeft,
  };
}

function restoreCaret(el, caret) {
  if (!caret || !el) return;
  el.focus();
  const max = el.value.length;
  const start = Math.min(caret.start || 0, max);
  const end = Math.min(caret.end || 0, max);
  el.setSelectionRange(start, end);
  el.scrollTop = caret.scrollTop;
  el.scrollLeft = caret.scrollLeft;
}

function setConfirmError(msg) {
  const el = $('editor-confirm-error');
  if (!msg) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.textContent = msg;
  el.classList.remove('hidden');
}

function setRemoteEditorStatus(kind, message) {
  if (remoteEditor.statusTimer) {
    clearTimeout(remoteEditor.statusTimer);
    remoteEditor.statusTimer = null;
  }
  const el = $('editor-status');
  el.className = 'editor-status' + (kind ? ` editor-status-${kind}` : '');
  el.textContent = message || '';
  el.title = message || '';
  if (kind === 'ok' && message) {
    const gen = remoteEditor.gen;
    const shown = message;
    remoteEditor.statusTimer = setTimeout(() => {
      if (remoteEditor.gen !== gen) return;
      if (el.textContent === shown) {
        el.textContent = '';
        el.className = 'editor-status';
      }
    }, 2200);
  }
}

function setRemoteEditorSaving(on) {
  $('editor-save').disabled = on || !remoteEditor.loaded;
  $('editor-exit').disabled = on;
  $('editor-save-exit').disabled = on;
  $('editor-discard-exit').disabled = on;
  $('editor-conflict-overwrite').disabled = on;
  $('editor-text').readOnly = on;
  $('editor-save').textContent = on ? 'Saving…' : 'Save';
  $('editor-save-exit').textContent = on ? 'Saving…' : 'Save and exit';
  $('editor-conflict-overwrite').textContent = on ? 'Saving…' : 'Overwrite';
  $('editor-backdrop').setAttribute('aria-busy', on ? 'true' : 'false');
}

function fileNameHtml(name, query) {
  if (!query) return escHtml(name);
  return window.appSearch.splitHighlight(name, query).map((part) => {
    const text = escHtml(part.text);
    return part.match ? `<mark class="find-hit">${text}</mark>` : text;
  }).join('');
}

function findDialogOpen() {
  return [
    'preview-backdrop', 'hop-backdrop', 'confirm-backdrop', 'rename-backdrop', 'sudo-backdrop',
    'elevate-backdrop', 'editor-confirm-backdrop', 'editor-conflict-backdrop',
  ].some((id) => {
    const el = $(id);
    return el && !el.classList.contains('hidden');
  });
}

function handleFindKeydown(e) {
  if (!$('explorer-screen').classList.contains('active')) return;
  const action = window.appSearch.findBarKeyAction(e, {
    open: findState.open,
    inputFocused: document.activeElement === $('find-input'),
    platform: navigator.platform || '',
  });
  if (!action || findDialogOpen()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (action === 'open') openFindBar();
  else if (action === 'refocus') refocusFindInput();
  else if (action === 'close') closeFindBar();
  else if (action === 'next') stepFind(1);
  else if (action === 'prev') stepFind(-1);
}

function openFindBar() {
  const mode = remoteEditor.open ? 'editor' : 'browser';
  findState = window.appSearch.openFind(findState, mode);
  const input = $('find-input');
  input.value = findState.query;
  input.placeholder = mode === 'editor' ? 'Find in file' : 'Find in this folder';
  $('find-bar').classList.toggle('find-in-editor', mode === 'editor');
  $('find-bar').classList.remove('hidden');
  applyOpenFind();
  input.focus();
  input.select();
  if (findState.mode === 'editor') {
    requestAnimationFrame(() => {
      if (findState.open && findState.mode === 'editor') paintEditorFind(true);
    });
  }
}

function refocusFindInput() {
  const input = $('find-input');
  input.focus();
  input.select();
}

function closeFindBar(opts) {
  if (!findState.open) {
    $('find-bar').classList.add('hidden');
    return;
  }
  const input = $('find-input');
  if (input) findState = window.appSearch.setFindQuery(findState, input.value);
  const wasBrowser = findState.mode === 'browser';
  const restoreEditor = findState.mode === 'editor'
    && remoteEditor.open
    && remoteEditor.loaded
    && (!opts || opts.restoreEditorFocus !== false);
  findState = window.appSearch.closeFind(findState);
  findEditorMatches = [];
  $('find-bar').classList.remove('find-in-editor');
  $('find-bar').classList.add('hidden');
  clearEditorHighlights();
  syncFindButtons();
  if (wasBrowser && (!opts || opts.rerender !== false)) renderBrowser();
  if (restoreEditor) $('editor-text').focus();
}

function onFindInput() {
  if (!findState.open) return;
  findState = window.appSearch.setFindQuery(findState, $('find-input').value);
  applyOpenFind();
}

function applyOpenFind() {
  if (findState.mode === 'editor') refreshEditorFind({ jump: true });
  else renderBrowser();
}

function updateFindCount(index, count) {
  const label = window.appSearch.formatMatchStatus(index, count, findState.query);
  const el = $('find-count');
  el.textContent = label;
  el.classList.toggle('is-empty', label === window.appSearch.NO_MATCHES);
}

function syncFindButtons() {
  let count = 0;
  if (findState.open && findState.query) {
    count = findState.mode === 'editor'
      ? findEditorMatches.length
      : window.appSearch.filterDirectoryEntries(currentFiles, findState.query).length;
  }
  const enabled = findState.open && count > 0;
  $('find-prev').disabled = !enabled;
  $('find-next').disabled = !enabled;
}

function stepFind(direction) {
  if (!findState.open || !findState.query) return;
  if (findState.mode === 'editor') {
    const area = $('editor-text');
    findEditorMatches = window.appSearch.findTextMatches(area.value, findState.query);
    findState.matchIndex = window.appSearch.stepMatchIndex(findState.matchIndex, findEditorMatches.length, direction);
    paintEditorFind(true);
    return;
  }
  const files = window.appSearch.filterDirectoryEntries(currentFiles, findState.query);
  findState.matchIndex = window.appSearch.stepMatchIndex(findState.matchIndex, files.length, direction);
  renderBrowser();
  const current = $('file-container').querySelector('.file-item.find-current');
  if (current) current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function clearEditorHighlights() {
  const layer = $('editor-match-layer');
  if (layer) layer.replaceChildren();
}

function measureEditorCharWidth(style) {
  const key = `${style.fontFamily}|${style.fontSize}|${style.fontWeight}|${style.letterSpacing}`;
  if (editorCharWidth.key === key && editorCharWidth.width > 0) return editorCharWidth.width;
  const probe = document.createElement('span');
  probe.textContent = '0000000000';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'pre';
  probe.style.fontFamily = style.fontFamily;
  probe.style.fontSize = style.fontSize;
  probe.style.fontWeight = style.fontWeight;
  probe.style.letterSpacing = style.letterSpacing;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 10;
  probe.remove();
  const safe = width > 0 ? width : 8;
  editorCharWidth = { key, width: safe };
  return safe;
}

function editorFindView(area) {
  const style = getComputedStyle(area);
  const fontSize = parseFloat(style.fontSize) || 13;
  let lineHeight = parseFloat(style.lineHeight);
  if (!Number.isFinite(lineHeight)) lineHeight = fontSize * 1.55;
  const tabSize = parseInt(style.tabSize, 10);
  return {
    scrollTop: area.scrollTop,
    scrollLeft: area.scrollLeft,
    clientHeight: area.clientHeight,
    clientWidth: area.clientWidth,
    paddingTop: parseFloat(style.paddingTop) || 0,
    paddingLeft: parseFloat(style.paddingLeft) || 0,
    lineHeight,
    charWidth: measureEditorCharWidth(style),
    tabSize: Number.isFinite(tabSize) && tabSize > 0 ? tabSize : 2,
  };
}

function scrollEditorToMatch(area, match) {
  if (!match) return;
  const view = editorFindView(area);
  const pos = window.appSearch.matchVisualPosition(area.value, match.start, view.tabSize);
  const nextTop = window.appSearch.scrollOffsetForMatch(
    pos.line, view.scrollTop, view.clientHeight, view.paddingTop, view.lineHeight
  );
  const nextLeft = window.appSearch.scrollOffsetForColumn(
    pos.column, view.scrollLeft, view.clientWidth, view.paddingLeft, view.charWidth
  );
  if (nextTop !== area.scrollTop) area.scrollTop = nextTop;
  if (nextLeft !== area.scrollLeft) area.scrollLeft = nextLeft;
}

function paintEditorFind(shouldScroll) {
  const area = $('editor-text');
  const index = findState.matchIndex;
  updateFindCount(index, findEditorMatches.length);
  syncFindButtons();
  if (!area) return;
  if (shouldScroll && index >= 0 && findEditorMatches[index]) scrollEditorToMatch(area, findEditorMatches[index]);
  const layer = $('editor-match-layer');
  if (!layer) return;
  const boxes = window.appSearch.layoutMatchHighlights(area.value, findEditorMatches, index, editorFindView(area));
  layer.replaceChildren();
  boxes.forEach((box) => {
    const el = document.createElement('div');
    el.className = box.current ? 'editor-match current' : 'editor-match';
    el.style.top = `${box.top}px`;
    el.style.left = `${box.left}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    layer.appendChild(el);
  });
}

function refreshEditorFind(opts) {
  const area = $('editor-text');
  if (!findState.open || findState.mode !== 'editor' || !area || !remoteEditor.loaded) {
    findEditorMatches = [];
    if (findState.open && findState.mode === 'editor') {
      updateFindCount(-1, 0);
      syncFindButtons();
    }
    clearEditorHighlights();
    return;
  }
  const jump = !!(opts && opts.jump);
  const synced = jump
    ? {
      matches: window.appSearch.findTextMatches(area.value, findState.query),
      index: findState.query ? 0 : -1,
    }
    : window.appSearch.syncTextMatches(area.value, findState.query, {
      matches: findEditorMatches,
      index: findState.matchIndex,
    });
  findEditorMatches = synced.matches;
  findState.matchIndex = findState.query
    ? window.appSearch.clampMatchIndex(synced.index, findEditorMatches.length)
    : -1;
  paintEditorFind(jump);
}

function refreshRemoteEditorDirty() {
  const badge = $('editor-dirty');
  if (!remoteEditor.open || !remoteEditor.loaded) {
    badge.classList.add('hidden');
    return;
  }
  const dirty = window.editorState.hasUnsavedChanges($('editor-text').value, remoteEditor.baseline);
  badge.classList.toggle('hidden', !dirty);
  if (findState.open && findState.mode === 'editor') refreshEditorFind({ jump: false });
}

function showUnsavedDialog() {
  $('editor-confirm-backdrop').classList.remove('hidden');
  setTimeout(() => {
    if (!remoteEditor.open || remoteEditor.saving) return;
    if (!$('editor-conflict-backdrop').classList.contains('hidden')) return;
    $('editor-save-exit').focus();
  }, 0);
}

function dismissUnsavedDialog(opts) {
  if (!opts || opts.keepLeave !== true) remoteEditor.pendingLeave = null;
  $('editor-confirm-backdrop').classList.add('hidden');
  setConfirmError('');
  if (remoteEditor.open && remoteEditor.loaded && $('editor-conflict-backdrop').classList.contains('hidden') && !remoteEditor.saving) {
    $('editor-text').focus();
  }
}

function showRemoteConflict(message) {
  $('editor-conflict-msg').textContent = message;
  $('editor-conflict-backdrop').classList.remove('hidden');
  setTimeout(() => {
    if (!remoteEditor.open || remoteEditor.saving) return;
    $('editor-conflict-cancel').focus();
  }, 0);
}

function dismissRemoteConflict() {
  $('editor-conflict-backdrop').classList.add('hidden');
  if (!remoteEditor.open) return;
  if (!$('editor-confirm-backdrop').classList.contains('hidden')) {
    $('editor-save-exit').focus();
    return;
  }
  if (remoteEditor.loaded) $('editor-text').focus();
}

function closeRemoteEditor(opts) {
  closeFindBar({ restoreEditorFocus: false });
  const leave = opts && opts.runLeave ? remoteEditor.pendingLeave : null;
  remoteEditor.pendingLeave = null;
  remoteEditor.gen += 1;
  remoteEditor.open = false;
  remoteEditor.loaded = false;
  remoteEditor.saving = false;
  remoteEditor.pendingExit = false;
  remoteEditor.path = '';
  remoteEditor.baseline = '';
  remoteEditor.newline = 'lf';
  remoteEditor.mtime = null;
  remoteEditor.size = null;
  remoteEditor.sessionKey = '';
  remoteEditor.targetKind = 'sftp';
  remoteEditor.containerId = '';
  remoteEditor.containerName = '';
  if (remoteEditor.statusTimer) {
    clearTimeout(remoteEditor.statusTimer);
    remoteEditor.statusTimer = null;
  }
  $('editor-text').value = '';
  $('editor-text-wrap').classList.add('hidden');
  clearEditorHighlights();
  $('editor-loading').classList.add('hidden');
  $('editor-load-error').classList.add('hidden');
  $('editor-load-error').textContent = '';
  $('editor-backdrop').classList.add('hidden');
  $('editor-confirm-backdrop').classList.add('hidden');
  $('editor-conflict-backdrop').classList.add('hidden');
  closeElevate();
  $('editor-dirty').classList.add('hidden');
  setConfirmError('');
  const status = $('editor-status');
  status.textContent = '';
  status.title = '';
  status.className = 'editor-status';
  setRemoteEditorSaving(false);
  if (typeof leave === 'function') leave();
}

function editorIsDirty() {
  return remoteEditor.open
    && remoteEditor.loaded
    && window.editorState.hasUnsavedChanges($('editor-text').value, remoteEditor.baseline);
}

// Ask before dropping a dirty buffer, then run the navigation that was requested.
function leaveEditorThen(action) {
  if (remoteEditor.saving || elevateDialogOpen()) return;
  if (remoteEditor.pendingLeave) return;
  if (!remoteEditor.open) {
    action();
    return;
  }
  if (!$('editor-conflict-backdrop').classList.contains('hidden')) return;
  if (!editorIsDirty()) {
    closeRemoteEditor();
    action();
    return;
  }
  remoteEditor.pendingLeave = action;
  setConfirmError('');
  showUnsavedDialog();
}

function requestRemoteEditorExit() {
  if (!remoteEditor.open || remoteEditor.saving) return;
  if (elevateDialogOpen()) return;
  if (!editorIsDirty()) {
    closeRemoteEditor({ runLeave: true });
    return;
  }
  setConfirmError('');
  showUnsavedDialog();
}

function discardRemoteEditor() {
  if (remoteEditor.saving) return;
  closeRemoteEditor({ runLeave: true });
}

async function openRemoteEditor(filePath, fileName, fileSize) {
  closeFindBar({ restoreEditorFocus: false });
  const api = window.editorState;
  const target = currentEditorTarget();
  const gen = ++remoteEditor.gen;
  remoteEditor.open = true;
  remoteEditor.loaded = false;
  remoteEditor.saving = false;
  remoteEditor.pendingExit = false;
  remoteEditor.pendingLeave = null;
  remoteEditor.path = filePath;
  remoteEditor.baseline = '';
  remoteEditor.newline = 'lf';
  remoteEditor.mtime = null;
  remoteEditor.size = null;
  remoteEditor.targetKind = target.kind;
  remoteEditor.containerId = target.containerId || '';
  remoteEditor.containerName = target.containerName || '';
  remoteEditor.sessionKey = api.editingSessionKey(currentConnectionKey(), target);

  closePreview();
  $('editor-confirm-backdrop').classList.add('hidden');
  $('editor-conflict-backdrop').classList.add('hidden');
  setConfirmError('');
  setRemoteEditorStatus('', '');

  const location = editorLocation(filePath);
  $('editor-icon').textContent = getFileIcon(fileName, false, false);
  $('editor-filename').textContent = fileName;
  $('editor-filename').title = fileName;
  $('editor-path').textContent = location;
  $('editor-path').title = location;
  $('editor-dirty').classList.add('hidden');
  $('editor-text').value = '';
  $('editor-text-wrap').classList.add('hidden');
  clearEditorHighlights();
  $('editor-load-error').textContent = '';
  $('editor-load-error').classList.add('hidden');
  $('editor-loading').classList.remove('hidden');
  $('editor-backdrop').classList.remove('hidden');
  setRemoteEditorSaving(false);

  let result;
  try {
    result = remoteEditor.targetKind === 'docker'
      ? await window.api.dockerReadfile(remoteEditor.containerId, filePath)
      : await window.api.readfile(filePath);
  } catch (err) {
    result = { success: false, error: (err && err.message) || 'Could not read file.' };
  }

  if (!remoteEditor.open || gen !== remoteEditor.gen) return;

  if (api.isPreviewOnlyRead(result)) {
    closeRemoteEditor();
    showPreviewChrome(fileName, fileSize);
    renderPreviewResult(fileName, result);
    return;
  }

  $('editor-loading').classList.add('hidden');

  if (!result || !result.success || typeof result.content !== 'string') {
    $('editor-load-error').textContent = presentEditorError(result, 'Could not read file.');
    $('editor-load-error').classList.remove('hidden');
    $('editor-save').disabled = true;
    $('editor-exit').focus();
    return;
  }

  if (!Number.isFinite(result.mtime) || !Number.isFinite(result.size)) {
    $('editor-load-error').textContent = 'The file modification time is unavailable, so it cannot be edited safely.';
    $('editor-load-error').classList.remove('hidden');
    $('editor-save').disabled = true;
    $('editor-exit').focus();
    return;
  }

  remoteEditor.newline = api.classifyNewlines(result.content);
  const area = $('editor-text');
  area.value = api.toEditorText(result.content);
  remoteEditor.baseline = area.value;
  remoteEditor.mtime = result.mtime;
  remoteEditor.size = result.size;
  remoteEditor.loaded = true;
  $('editor-text-wrap').classList.remove('hidden');
  refreshRemoteEditorDirty();
  setRemoteEditorSaving(false);
  area.setSelectionRange(0, 0);
  area.focus();
}

let pendingElevateAction = null;

function elevateDialogOpen() {
  return !$('elevate-backdrop').classList.contains('hidden');
}

function refreshElevatePasswordLabel() {
  const name = $('elevate-user-input').value.trim() || 'this account';
  $('elevate-pass-label').textContent = `Password for ${name}`;
}

function closeElevate() {
  $('elevate-backdrop').classList.add('hidden');
  $('elevate-user-input').value = '';
  $('elevate-pass-input').value = '';
  $('elevate-user-input').disabled = false;
  $('elevate-pass-input').disabled = false;
  $('elevate-cancel').disabled = false;
  $('elevate-error').textContent = '';
  $('elevate-error').classList.add('hidden');
  $('elevate-ok').disabled = false;
  $('elevate-ok-text').textContent = 'Save';
  $('elevate-spinner').classList.add('hidden');
  pendingElevateAction = null;
}

function cancelElevatedSave() {
  if ($('elevate-ok').disabled) return;
  const wasOpen = elevateDialogOpen();
  closeElevate();
  if (!wasOpen || !remoteEditor.open) return;
  setRemoteEditorStatus('error', 'Not saved. Your changes are still in the editor.');
  if (remoteEditor.loaded && $('editor-conflict-backdrop').classList.contains('hidden')
      && $('editor-confirm-backdrop').classList.contains('hidden') && !remoteEditor.saving) {
    $('editor-text').focus();
  }
}

function openElevateModal(prompt, action) {
  pendingElevateAction = action;
  $('elevate-msg').textContent = prompt.message;
  $('elevate-user-input').value = prompt.username || 'root';
  $('elevate-pass-input').value = '';
  $('elevate-error').textContent = '';
  $('elevate-error').classList.add('hidden');
  $('elevate-ok').disabled = false;
  $('elevate-ok-text').textContent = 'Save';
  $('elevate-spinner').classList.add('hidden');
  refreshElevatePasswordLabel();
  $('elevate-backdrop').classList.remove('hidden');
  setTimeout(() => {
    if (!elevateDialogOpen()) return;
    $('elevate-pass-input').focus();
  }, 50);
}

async function runElevatedSave() {
  if (!pendingElevateAction) return;
  const username = $('elevate-user-input').value.trim();
  const password = $('elevate-pass-input').value;
  if (!window.editorState.isSafeAccountName(username)) {
    $('elevate-error').textContent = 'Enter the name of an account that can write this file.';
    $('elevate-error').classList.remove('hidden');
    $('elevate-user-input').focus();
    return;
  }
  if (!password) {
    $('elevate-error').textContent = `Enter the password for ${username}.`;
    $('elevate-error').classList.remove('hidden');
    $('elevate-pass-input').focus();
    return;
  }

  $('elevate-ok').disabled = true;
  $('elevate-cancel').disabled = true;
  $('elevate-user-input').disabled = true;
  $('elevate-pass-input').disabled = true;
  $('elevate-ok-text').textContent = 'Saving…';
  $('elevate-spinner').classList.remove('hidden');
  $('elevate-error').classList.add('hidden');

  let result;
  try {
    result = await pendingElevateAction(username, password);
  } catch (err) {
    result = { success: false, error: (err && err.message) || 'Save failed.' };
  }

  $('elevate-ok').disabled = false;
  $('elevate-cancel').disabled = false;
  $('elevate-user-input').disabled = false;
  $('elevate-pass-input').disabled = false;
  $('elevate-ok-text').textContent = 'Save';
  $('elevate-spinner').classList.add('hidden');

  if (result && (result.success || result.conflict)) {
    const saved = !!result.success;
    closeElevate();
    if (saved) loadDirectory(currentPath, false);
    return;
  }

  $('elevate-error').textContent = result && result.wrongPassword
    ? `Incorrect password for ${username}. The file was not changed.`
    : ((result && result.error) || 'The file was not changed.');
  $('elevate-error').classList.remove('hidden');
  $('elevate-pass-input').value = '';
  $('elevate-pass-input').focus();
}

function promptElevatedSave(force, info) {
  const prompt = window.editorState.elevationPrompt(info || {});
  openElevateModal(prompt, async (username, password) => {
    const api = window.editorState;
    const area = $('editor-text');
    if (!remoteEditor.open || !remoteEditor.loaded) {
      return { success: false, error: 'This file is not open for editing.' };
    }
    if (!api.sameEditingSession(remoteEditor.sessionKey, currentSessionKey())) {
      return { success: false, error: api.CONNECTION_LOST_MESSAGE };
    }

    if (remoteEditor.targetKind === 'docker') {
      return { success: false, error: 'Container files are not saved through another server account.' };
    }

    const text = area.value;
    remoteEditor.saving = true;
    setRemoteEditorSaving(true);
    let result;
    try {
      result = await window.api.writefileAs(
        remoteEditor.path,
        api.prepareForSave(text, remoteEditor.newline),
        username,
        password,
        {
          expectedMtime: remoteEditor.mtime,
          expectedSize: remoteEditor.size,
          force,
        }
      );
    } catch (err) {
      result = { success: false, error: (err && err.message) || 'Save failed.' };
    } finally {
      if (remoteEditor.open) {
        remoteEditor.saving = false;
        setRemoteEditorSaving(false);
      }
    }

    if (!remoteEditor.open) return result || { success: false, error: 'Save failed.' };

    if (result && result.conflict) {
      const msg = result.error || 'The remote file has changed since you opened or last saved it. It was not overwritten.';
      setRemoteEditorStatus('error', msg);
      showRemoteConflict(msg);
      return result;
    }
    if (!result || !result.success) return result || { success: false, error: 'Save failed.' };

    const applied = api.applySaveResult(remoteEditor.baseline, text, result);
    remoteEditor.baseline = applied.baseline;
    remoteEditor.mtime = applied.mtime;
    remoteEditor.size = applied.size;
    refreshRemoteEditorDirty();
    dismissUnsavedDialog({ keepLeave: true });
    dismissRemoteConflict();
    closeRemoteEditor({ runLeave: true });
    return result;
  });
}

async function saveRemoteEditor(opts) {
  const exitAfter = !!(opts && opts.exitAfter);
  const force = !!(opts && opts.force);
  if (!remoteEditor.open || remoteEditor.saving || elevateDialogOpen()) return;

  const api = window.editorState;
  const area = $('editor-text');
  remoteEditor.pendingExit = exitAfter;

  if (!remoteEditor.loaded) {
    setRemoteEditorStatus('error', 'This file is not open for editing.');
    return;
  }

  const text = area.value;
  if (api.saveAction(text, remoteEditor.baseline) === 'skip') {
    setRemoteEditorStatus('ok', 'No changes to save');
    refreshRemoteEditorDirty();
    if (exitAfter) closeRemoteEditor({ runLeave: true });
    else dismissUnsavedDialog();
    return;
  }

  if (!api.sameEditingSession(remoteEditor.sessionKey, currentSessionKey())) {
    const connectionKey = currentConnectionKey();
    const containerLeft = remoteEditor.targetKind === 'docker'
      && connectionKey
      && remoteEditor.sessionKey.startsWith(`${connectionKey}|docker:`);
    const blocked = containerLeft
      ? 'This container is no longer the one being browsed, so the file was not saved.'
      : api.CONNECTION_LOST_MESSAGE;
    setRemoteEditorStatus('error', blocked);
    if (exitAfter || !$('editor-confirm-backdrop').classList.contains('hidden')) {
      setConfirmError(blocked);
      showUnsavedDialog();
    }
    return;
  }

  const caret = captureCaret(area);
  const gen = remoteEditor.gen;
  const keepConfirm = exitAfter || !$('editor-confirm-backdrop').classList.contains('hidden');
  remoteEditor.saving = true;
  setRemoteEditorSaving(true);
  setRemoteEditorStatus('progress', 'Saving…');
  if (keepConfirm) setConfirmError('');

  try {
    const content = api.prepareForSave(text, remoteEditor.newline);
    const saveOptions = {
      expectedMtime: remoteEditor.mtime,
      expectedSize: remoteEditor.size,
      force,
    };
    const route = api.saveRoute(remoteEditor.targetKind);
    const result = route === 'docker-writefile'
      ? await window.api.dockerWritefile(remoteEditor.containerId, remoteEditor.path, content, saveOptions)
      : await window.api.writefile(remoteEditor.path, content, saveOptions);

    if (!remoteEditor.open || gen !== remoteEditor.gen) return;

    if (result && result.conflict) {
      const msg = presentEditorError(result, 'The remote file has changed since you opened or last saved it. It was not overwritten.');
      setRemoteEditorStatus('error', msg);
      if (keepConfirm) setConfirmError(msg);
      showRemoteConflict(msg);
      return;
    }

    if (result && result.needsElevation && remoteEditor.targetKind !== 'docker') {
      const prompt = window.editorState.elevationPrompt(result);
      setRemoteEditorStatus('error', `Permission denied. Enter the password for ${prompt.username} to save.`);
      promptElevatedSave(force, result);
      return;
    }

    const applied = api.applySaveResult(remoteEditor.baseline, text, result);
    if (!applied.saved) {
      const msg = presentEditorError(result, 'Save failed.');
      const shown = result && result.uncertain
        ? msg
        : (/not connected|connection was lost|connection lost/i.test(msg) ? api.CONNECTION_LOST_MESSAGE : msg);
      setRemoteEditorStatus('error', shown);
      dismissRemoteConflict();
      if (keepConfirm) {
        setConfirmError(shown);
        showUnsavedDialog();
      } else {
        restoreCaret(area, caret);
      }
      return;
    }

    remoteEditor.baseline = applied.baseline;
    remoteEditor.mtime = applied.mtime;
    remoteEditor.size = applied.size;
    refreshRemoteEditorDirty();
    const leaving = typeof remoteEditor.pendingLeave === 'function';
    dismissUnsavedDialog({ keepLeave: true });
    dismissRemoteConflict();
    closeRemoteEditor({ runLeave: true });
    if (!leaving) loadDirectory(currentPath, false);
  } catch (err) {
    if (!remoteEditor.open || gen !== remoteEditor.gen) return;
    const msg = (err && err.message) || 'Save failed.';
    setRemoteEditorStatus('error', msg);
    dismissRemoteConflict();
    if (keepConfirm) {
      setConfirmError(msg);
      showUnsavedDialog();
    } else {
      restoreCaret(area, caret);
    }
  } finally {
    if (remoteEditor.open && gen === remoteEditor.gen) {
      remoteEditor.saving = false;
      setRemoteEditorSaving(false);
    }
  }
}

function insertEditorTab(el) {
  const scrollTop = el.scrollTop;
  const scrollLeft = el.scrollLeft;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  if (typeof el.setRangeText === 'function') {
    el.setRangeText('\t', start, end, 'end');
  } else {
    el.value = el.value.slice(0, start) + '\t' + el.value.slice(end);
    el.setSelectionRange(start + 1, start + 1);
  }
  el.scrollTop = scrollTop;
  el.scrollLeft = scrollLeft;
}

function trapDialogTab(e, dialog) {
  const focusables = Array.from(dialog.querySelectorAll('button:not([disabled])'));
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !dialog.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

function handleRemoteEditorKeydown(e) {
  if (!remoteEditor.open) return;

  if (!$('elevate-backdrop').classList.contains('hidden')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelElevatedSave();
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 's') {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }

  if (!$('sudo-backdrop').classList.contains('hidden')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSudo();
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 's') {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }

  const confirmOpen = !$('editor-confirm-backdrop').classList.contains('hidden');
  const conflictOpen = !$('editor-conflict-backdrop').classList.contains('hidden');

  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 's') {
    e.preventDefault();
    e.stopPropagation();
    if (remoteEditor.saving || conflictOpen) return;
    saveRemoteEditor({ exitAfter: false, force: false });
    return;
  }

  if (e.key === 'Tab') {
    if (conflictOpen) {
      trapDialogTab(e, $('editor-conflict-backdrop'));
      return;
    }
    if (confirmOpen) {
      trapDialogTab(e, $('editor-confirm-backdrop'));
      return;
    }
    if (e.target === $('editor-text') && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      insertEditorTab($('editor-text'));
      refreshRemoteEditorDirty();
    }
    return;
  }

  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  if (remoteEditor.saving) return;
  if (conflictOpen) {
    dismissRemoteConflict();
    return;
  }
  if (confirmOpen) {
    dismissUnsavedDialog();
    return;
  }
  requestRemoteEditorExit();
}

$('editor-backdrop').addEventListener('dragover', (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
});
$('editor-backdrop').addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) e.preventDefault();
});

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
  leaveEditorThen(() => { void beginDockerMode(container); });
}

async function beginDockerMode(container) {
  if (!container || !container.id) return;
  closeFindBar({ restoreEditorFocus: false, rerender: false });
  if (!dockerMode) preDockerPath = currentPath;
  dockerMode = { id: container.id, name: container.name, image: container.image };

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
  await loadDirectory('/', true, true);
}

function exitDockerMode() {
  leaveEditorThen(() => {
    const returnPath = preDockerPath || '/';
    closeFindBar({ restoreEditorFocus: false, rerender: false });
    clearDockerChrome();
    closePreview();
    refreshConnectionChrome();
    navHistory = [];
    historyIndex = -1;
    loadDirectory(returnPath, true, true);
  });
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

function openSudoModal(itemName, actionLabel, action, verb) {
  pendingSudoAction = action;
  sudoActionLabel   = actionLabel;
  $('sudo-verb').textContent = verb || 'Deleting';
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

  let result;
  try {
    result = await pendingSudoAction(pass);
  } catch (err) {
    result = { success: false, error: (err && err.message) || 'Operation failed.' };
  }

  $('sudo-ok').disabled            = false;
  $('sudo-ok-text').textContent    = sudoActionLabel;
  $('sudo-spinner').classList.add('hidden');

  if (result && result.conflict) {
    closeSudo();
    return;
  }

  if (result && result.success) {
    closeSudo();
    loadDirectory(currentPath, false);
    return;
  }

  $('sudo-error').textContent = result && result.wrongPassword
    ? 'Incorrect sudo password. Try again.'
    : ((result && result.error) || 'Operation failed.');
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
