const { app, BrowserWindow, ipcMain } = require('electron');
const crypto = require('crypto');
const path = require('path');
const { loadFormMemory, saveFormMemory } = require('./form-memory');
const { SshNav } = require('./ssh-nav');
const {
  assessRemoteChange,
  chooseWriteAccount,
  formatFileMode,
  parseAccountFacts,
  isSafeAccountName,
  passwordPromptCount,
  isSuAuthFailure,
  usefulTerminalError,
} = require('./renderer/editor-state');

let mainWindow   = null;
let sshClient    = null;   // logical server currently being browsed
let sftpSession  = null;

// SSH agent socket for key-based auth (no password needed on target)
const agentSocket = process.platform === 'win32'
  ? '\\\\.\\pipe\\openssh-ssh-agent'
  : (process.env.SSH_AUTH_SOCK || undefined);

const sshNav = new SshNav({
  agentSocket,
  onChange(client, sftp) {
    sshClient = client;
    sftpSession = sftp;
  },
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 800,
    minHeight: 550,
    frame: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('renderer/index.html');
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  sshNav.cleanup();
  if (process.platform !== 'darwin') app.quit();
});

// ── Window controls ───────────────────────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow.minimize());
ipcMain.on('window:maximize', () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close', () => {
  sshNav.cleanup();
  mainWindow.close();
});
ipcMain.handle('window:is-maximized', () => mainWindow.isMaximized());

// SSH form history. Passwords are stripped again here so they cannot be stored.
ipcMain.handle('form-memory:load', () => loadFormMemory(app.getPath('userData')));
ipcMain.handle('form-memory:save', (_event, data) => {
  saveFormMemory(app.getPath('userData'), data);
  return { success: true };
});
ipcMain.on('form-memory:flush', (event, data) => {
  try {
    saveFormMemory(app.getPath('userData'), data);
    event.returnValue = { success: true };
  } catch (err) {
    event.returnValue = { success: false, error: err.message };
  }
});

// ── SSH: Connect, hop, exit, disconnect ───────────────────────────────────────
// ssh-nav keeps the logical server stack. sshClient and sftpSession always
// refer to the server the user is browsing.
ipcMain.handle('ssh:connect', (_event, opts) => sshNav.connect(opts));
ipcMain.handle('ssh:hop', (_event, opts) => sshNav.hop(opts));
ipcMain.handle('ssh:exit', () => sshNav.exit());
ipcMain.handle('ssh:disconnect', () => sshNav.disconnect());

// ── SSH: Rename ───────────────────────────────────────────────────────────────
ipcMain.handle('ssh:rename', (_event, { oldPath, newPath }) => {
  return new Promise((resolve) => {
    if (!sftpSession) { resolve({ success: false, error: 'Not connected' }); return; }
    sftpSession.rename(oldPath, newPath, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// ── SSH: Copy ─────────────────────────────────────────────────────────────────
ipcMain.handle('ssh:copy', async (_event, { srcPath, dstPath }) => {
  const { code, stderr } = await runExec(`cp -rp ${escapeSh(srcPath)} ${escapeSh(dstPath)}`);
  if (code === 0) return { success: true };
  const isPermission = /Permission denied|Operation not permitted/i.test(stderr);
  return { success: false, needsSudo: isPermission, error: stderr.trim() || `Exit code ${code}` };
});

ipcMain.handle('ssh:copy-sudo', async (_event, { srcPath, dstPath, password }) => {
  const { code, stderr } = await runExec(`sudo -S cp -rp ${escapeSh(srcPath)} ${escapeSh(dstPath)}`, password);
  if (code === 0) return { success: true };
  const wrongPass = /incorrect password|Sorry|try again/i.test(stderr);
  return { success: false, wrongPassword: wrongPass, error: stderr.trim() || `Exit code ${code}` };
});

// ── SSH: Delete (try normal first, report if sudo needed) ─────────────────────
function runExec(cmd, stdinData, opts) {
  return new Promise((resolve) => {
    if (!sshClient) { resolve({ code: -1, stdout: '', stderr: 'Not connected' }); return; }
    const timeoutMs = opts && opts.timeoutMs;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    sshClient.exec(cmd, (err, stream) => {
      if (err) { finish({ code: -1, stdout: '', stderr: err.message }); return; }
      if (timeoutMs) {
        timer = setTimeout(() => {
          endChannel(stream);
          finish({ code: -1, stdout: '', stderr: 'The server did not answer in time.' });
        }, timeoutMs);
      }
      let stdout = '', stderr = '';
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      if (stdinData !== undefined) { stream.write(stdinData + '\n'); stream.end(); }
      stream.on('close', (code) => finish({ code, stdout, stderr }));
    });
  });
}

function endChannel(stream) {
  if (!stream) return;
  try { stream.end(); } catch { /* already closed */ }
  try {
    if (typeof stream.close === 'function') stream.close();
  } catch { /* already closed */ }
}

// su reads the target account's password from a terminal. A PTY is required;
// piping the password on stdin (the way sudo -S works) is ignored.
function runPty(cmd, password, timeoutMs = 30000) {
  return new Promise((resolve) => {
    if (!sshClient) {
      resolve({ code: -1, output: 'Not connected', promptCount: 0 });
      return;
    }
    const state = { output: '', prompts: 0, stream: null };
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      endChannel(state.stream);
      const output = state.output || 'Timed out while switching user to save the file.';
      finish({ code: -1, output, promptCount: state.prompts });
    }, timeoutMs);

    sshClient.exec(cmd, { pty: { term: 'vt100', cols: 80, rows: 24 } }, (err, channel) => {
      if (err) {
        finish({ code: -1, output: err.message, promptCount: 0 });
        return;
      }
      state.stream = channel;
      const take = (chunk) => {
        state.output += chunk.toString('utf8');
        const seen = passwordPromptCount(state.output);
        if (seen <= state.prompts) return;
        state.prompts = seen;
        if (state.prompts === 1 && password) {
          channel.write(`${password}\n`);
        } else if (state.prompts > 1) {
          // su asks again only after the password is rejected.
          endChannel(channel);
        }
      };
      channel.on('data', take);
      channel.stderr.on('data', take);
      channel.on('error', (streamErr) => {
        finish({
          code: -1,
          output: `${state.output}${streamErr.message}`,
          promptCount: state.prompts,
        });
      });
      channel.on('close', (code) => {
        finish({ code: code == null ? -1 : code, output: state.output, promptCount: state.prompts });
      });
    });
  });
}

function escapeSh(p) { return "'" + p.replace(/'/g, "'\\''") + "'"; }

ipcMain.handle('ssh:delete', async (_event, { path: targetPath }) => {
  const { code, stderr } = await runExec(`rm -rf ${escapeSh(targetPath)}`);
  if (code === 0) return { success: true };
  const isPermission = /Permission denied|Operation not permitted|cannot remove/i.test(stderr);
  return { success: false, needsSudo: isPermission, error: stderr.trim() || `Exit code ${code}` };
});

ipcMain.handle('ssh:delete-sudo', async (_event, { path: targetPath, password: sudoPass }) => {
  const { code, stderr } = await runExec(`sudo -S rm -rf ${escapeSh(targetPath)}`, sudoPass);
  if (code === 0) return { success: true };
  const wrongPass = /incorrect password|Sorry|try again/i.test(stderr);
  return { success: false, wrongPassword: wrongPass, error: stderr.trim() || `Exit code ${code}` };
});

// ── SSH: Read directory ───────────────────────────────────────────────────────
ipcMain.handle('ssh:readdir', (_event, { path: dirPath }) => {
  return new Promise((resolve) => {
    if (!sftpSession) {
      resolve({ success: false, error: 'Not connected' });
      return;
    }

    sftpSession.readdir(dirPath, async (err, list) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }

      const S_IFMT  = 0o170000;
      const S_IFDIR = 0o040000;
      const S_IFLNK = 0o120000;

      const files = list
        .filter((item) => item.filename !== '.' && item.filename !== '..')
        .map((item) => ({
          name: item.filename,
          isDirectory: item.attrs.mode ? (item.attrs.mode & S_IFMT) === S_IFDIR : false,
          isSymlink:   item.attrs.mode ? (item.attrs.mode & S_IFMT) === S_IFLNK : false,
          size:        item.attrs.size  || 0,
          mtime:       item.attrs.mtime || 0,
          permissions: item.attrs.mode  || 0,
        }));

      // ── Resolve symlinks ─────────────────────────────────────────────────
      const symlinks = files.filter((f) => f.isSymlink);

      if (symlinks.length > 0) {
        const sftp = sftpSession; // capture in case it changes

        await Promise.all(symlinks.map((sym) => {
          const fullPath = dirPath === '/' ? `/${sym.name}` : `${dirPath}/${sym.name}`;
          return new Promise((res) => {
            // stat() follows the symlink → tells us if the target is a directory
            sftp.stat(fullPath, (statErr, stats) => {
              if (!statErr && stats && stats.mode) {
                sym.isDirectory = (stats.mode & S_IFMT) === S_IFDIR;
              }
              // readlink() → gives us the raw target path
              sftp.readlink(fullPath, (rlErr, target) => {
                if (!rlErr && target) sym.symlinkTarget = target;
                res();
              });
            });
          });
        }));

        // Build map: target basename → [symlink names that point to it]
        const linkedAs = {};
        symlinks.forEach((sym) => {
          if (!sym.symlinkTarget) return;
          const targetName = sym.symlinkTarget.replace(/\/$/, '').split('/').pop();
          if (targetName) {
            if (!linkedAs[targetName]) linkedAs[targetName] = [];
            linkedAs[targetName].push(sym.name);
          }
        });

        // Annotate target folders with the symlink names pointing at them
        files.forEach((f) => {
          if (linkedAs[f.name]) f.linkedAs = linkedAs[f.name];
        });
      }

      files.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      resolve({ success: true, files });
    });
  });
});

// ── Docker helpers ────────────────────────────────────────────────────────────

// Parse `ls -la` output — works on GNU coreutils, busybox, Alpine, Debian, etc.
function parseLsLa(output) {
  const files = [];

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('total')) continue;

    // Split on whitespace — max 9 fields, remainder is the filename
    const parts = trimmed.split(/\s+/);
    if (parts.length < 9) continue;

    const perms = parts[0];
    const type  = perms[0]; // d=dir, l=link, -=file, c/b/p=special
    if (type === '?' || type === 'total') continue;

    const size = parseInt(parts[4]) || 0;
    // Date fields: month(5), day(6), time-or-year(7) → name starts at index 8
    const rawName = parts.slice(8).join(' ');
    if (rawName === '.' || rawName === '..') continue;

    const isDirectory = type === 'd';
    const isSymlink   = type === 'l';

    // Symlinks: "linkname -> target" — keep only the link name
    const name = isSymlink && rawName.includes(' -> ')
      ? rawName.split(' -> ')[0]
      : rawName;

    files.push({ name, isDirectory, isSymlink, size, mtime: 0 });
  }

  files.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return files;
}

// Shown when the remote host has no docker binary. Kept identical in the renderer.
const DOCKER_MISSING_MSG = 'No docker containers found or maybe no docker installed';

function isDockerMissingOutput(text) {
  return /\bdocker(?:\.exe)?:\s*(?:command\s+)?not found\b/i.test(String(text || ''));
}

function dockerMissingResult() {
  return { success: false, unavailable: true, error: DOCKER_MISSING_MSG };
}

function dockerError(stderr, fallback) {
  const raw = (stderr || '').trim();
  if (isDockerMissingOutput(raw)) return dockerMissingResult();
  return { success: false, error: raw || fallback };
}

// ── Docker: list containers ───────────────────────────────────────────────────
ipcMain.handle('ssh:docker-containers', async () => {
  try {
    if (!sshClient) return { success: false, error: 'Not connected' };

    const { code, stdout, stderr } = await runExec(
      'docker ps -a --format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}"'
    );
    const output = `${stderr}\n${stdout}`;
    // 127 is the shell's "command not found" status. Don't surface the raw bash line.
    if (isDockerMissingOutput(output) || code === 127) {
      return { success: true, containers: [], unavailable: true };
    }
    if (code !== 0) return dockerError(stderr, 'docker ps failed — is Docker installed?');

    const containers = stdout
      .trim()
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        const [id, name, image, ...statusParts] = line.split('\t');
        const status = statusParts.join('\t');
        return { id, name, image, status, running: /^up /i.test(status) };
      })
      .filter((c) => c.id && c.name);

    return { success: true, containers };
  } catch (err) {
    return { success: false, error: err.message || 'Failed to list containers' };
  }
});

// ── Docker: read directory ────────────────────────────────────────────────────
ipcMain.handle('ssh:docker-readdir', async (_event, { containerId, path: dirPath }) => {
  try {
    if (!containerId) return { success: false, error: 'No container selected' };

    // Use `ls -la` — available on every container (GNU, busybox/Alpine, etc.)
    // Pass through `sh -c` so special characters in path are handled safely.
    const cmd = `docker exec ${escapeSh(containerId)} /bin/sh -c ${escapeSh(`ls -la ${escapeSh(dirPath)}`)}`;
    let { code, stdout, stderr } = await runExec(cmd);
    if (isDockerMissingOutput(`${stderr}\n${stdout}`)) return dockerMissingResult();

    // Fallback: some containers have sh elsewhere or ls not at /bin/ls
    if (code !== 0 || !stdout.trim()) {
      const fallback = await runExec(`docker exec ${escapeSh(containerId)} ls -la ${escapeSh(dirPath)}`);
      if (isDockerMissingOutput(`${fallback.stderr}\n${fallback.stdout}`)) return dockerMissingResult();
      if (fallback.stdout.trim()) { stdout = fallback.stdout; code = fallback.code; stderr = fallback.stderr; }
    }

    if (!stdout.trim()) {
      return dockerError(stderr, 'Directory appears empty or command failed inside container.');
    }

    return { success: true, files: parseLsLa(stdout) };
  } catch (err) {
    return { success: false, error: err.message || 'Failed to read directory' };
  }
});

// ── Docker: read file ─────────────────────────────────────────────────────────
ipcMain.handle('ssh:docker-readfile', async (_event, { containerId, path: filePath }) => {
  try {
    if (!containerId) return { success: false, error: 'No container selected' };

    // Check size via wc -c (universally available, no need for stat)
    const sizeResult = await runExec(
      `docker exec ${escapeSh(containerId)} /bin/sh -c ${escapeSh(`wc -c < ${escapeSh(filePath)}`)}`
    );
    if (isDockerMissingOutput(`${sizeResult.stderr}\n${sizeResult.stdout}`)) return dockerMissingResult();

    const size = parseInt(sizeResult.stdout.trim()) || 0;
    if (size > 1024 * 1024) {
      return { success: false, error: `File is too large to preview (${(size / 1024 / 1024).toFixed(1)} MB). Limit is 1 MB.` };
    }

    const { code, stdout, stderr } = await runExec(
      `docker exec ${escapeSh(containerId)} cat ${escapeSh(filePath)}`
    );
    if (isDockerMissingOutput(`${stderr}\n${stdout}`)) return dockerMissingResult();
    if (code !== 0) return dockerError(stderr, 'Cannot read file');

    // Binary check
    if (stdout.includes('\x00')) return { success: false, error: 'Binary file — cannot preview.' };

    return { success: true, content: stdout, size };
  } catch (err) {
    return { success: false, error: err.message || 'Cannot read file' };
  }
});

// ── Docker: delete ────────────────────────────────────────────────────────────
ipcMain.handle('ssh:docker-delete', async (_event, { containerId, path: targetPath }) => {
  try {
    if (!containerId) return { success: false, error: 'No container selected' };
    const { code, stdout, stderr } = await runExec(
      `docker exec ${escapeSh(containerId)} rm -rf ${escapeSh(targetPath)}`
    );
    if (isDockerMissingOutput(`${stderr}\n${stdout}`)) return dockerMissingResult();
    if (code === 0) return { success: true };
    return dockerError(stderr, `Exit code ${code}`);
  } catch (err) {
    return { success: false, error: err.message || 'Delete failed' };
  }
});

// ── Docker: rename ────────────────────────────────────────────────────────────
ipcMain.handle('ssh:docker-rename', async (_event, { containerId, oldPath, newPath }) => {
  try {
    if (!containerId) return { success: false, error: 'No container selected' };
    const { code, stdout, stderr } = await runExec(
      `docker exec ${escapeSh(containerId)} mv ${escapeSh(oldPath)} ${escapeSh(newPath)}`
    );
    if (isDockerMissingOutput(`${stderr}\n${stdout}`)) return dockerMissingResult();
    if (code === 0) return { success: true };
    return dockerError(stderr, `Exit code ${code}`);
  } catch (err) {
    return { success: false, error: err.message || 'Rename failed' };
  }
});

// ── Docker: upload file (desktop → server temp → docker cp → container) ───────
ipcMain.handle('ssh:docker-upload', (_event, { localPath, containerId, containerDir }) => {
  return new Promise(async (resolve) => {
    try {
      if (!sftpSession) { resolve({ success: false, error: 'Not connected' }); return; }
      if (!containerId) { resolve({ success: false, error: 'No container selected' }); return; }

      const filename = require('path').basename(localPath);
      const tmpPath  = `/tmp/.ssh-explorer-${Date.now()}-${filename}`;

      // Step 1 — upload local file to server /tmp via SFTP (with progress)
      try {
        await new Promise((res, rej) => {
          sftpSession.fastPut(localPath, tmpPath, {
            step: (transferred, _chunk, total) => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('upload:progress', { localPath, transferred, total });
              }
            },
          }, (err) => err ? rej(err) : res());
        });
      } catch (err) {
        resolve({ success: false, error: `Upload to server failed: ${err.message}` });
        return;
      }

      // Step 2 — docker cp from server temp to container
      const dest = `${containerId}:${containerDir.replace(/\/$/, '')}/${filename}`;
      const { code, stdout, stderr } = await runExec(`docker cp ${escapeSh(tmpPath)} ${escapeSh(dest)}`);

      // Step 3 — clean up temp file regardless of outcome
      await runExec(`rm -f ${escapeSh(tmpPath)}`);

      if (isDockerMissingOutput(`${stderr}\n${stdout}`)) {
        resolve(dockerMissingResult());
      } else if (code !== 0) {
        resolve(dockerError(stderr, 'docker cp failed'));
      } else {
        resolve({ success: true });
      }
    } catch (err) {
      resolve({ success: false, error: err.message || 'Upload failed' });
    }
  });
});

// ── SSH: Upload file ──────────────────────────────────────────────────────────
ipcMain.handle('ssh:upload', (_event, { localPath, remotePath }) => {
  return new Promise((resolve) => {
    if (!sftpSession) { resolve({ success: false, error: 'Not connected' }); return; }

    sftpSession.fastPut(
      localPath,
      remotePath,
      {
        step: (transferred, _chunk, total) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('upload:progress', { localPath, transferred, total });
          }
        },
      },
      (err) => {
        if (err) resolve({ success: false, error: err.message });
        else      resolve({ success: true });
      }
    );
  });
});

// ── SSH: Read file contents ───────────────────────────────────────────────────
const MAX_PREVIEW_BYTES = 1024 * 1024; // 1 MB

function isValidUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch (err) {
    // Invalid UTF-8 throws TypeError. Any other failure should not block editing.
    return !(err && err.name === 'TypeError');
  }
}

function statRemote(sftp, filePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(filePath, (err, stats) => (err ? reject(err) : resolve(stats)));
  });
}

function isPermissionError(err) {
  const msg = typeof err === 'string' ? err : (err && err.message) || '';
  if (err && err.code === 3) return true;
  return /permission denied|operation not permitted|eacces/i.test(msg);
}

function openHandle(sftp, filePath, flags) {
  return new Promise((resolve, reject) => {
    sftp.open(filePath, flags, (err, handle) => (err ? reject(err) : resolve(handle)));
  });
}

function closeHandle(sftp, handle) {
  return new Promise((resolve) => {
    sftp.close(handle, () => resolve());
  });
}

function writeHandle(sftp, handle, buffer) {
  return new Promise((resolve, reject) => {
    if (!buffer.length) {
      resolve();
      return;
    }
    sftp.write(handle, buffer, 0, buffer.length, 0, (err) => (err ? reject(err) : resolve()));
  });
}

function setHandleSize(sftp, handle, size) {
  return new Promise((resolve, reject) => {
    sftp.fsetstat(handle, { size }, (err) => (err ? reject(err) : resolve()));
  });
}

// Write an existing file without O_CREAT. Create+truncate is rejected with
// "Permission denied" on files that are writable when the directory is not.
async function writeRemoteFile(sftp, filePath, buffer, previousSize) {
  const SSH_FXF_WRITE = 0x00000002;
  let handle = null;
  try {
    handle = await openHandle(sftp, filePath, SSH_FXF_WRITE);
  } catch (err) {
    if (isPermissionError(err)) {
      err.needsSudo = true;
      throw err;
    }
    await writeTruncating(sftp, filePath, buffer);
    return;
  }

  try {
    await writeHandle(sftp, handle, buffer);
    if (Number.isFinite(previousSize) && buffer.length < previousSize) {
      try {
        await setHandleSize(sftp, handle, buffer.length);
      } catch (err) {
        if (isPermissionError(err)) {
          err.needsSudo = true;
          throw err;
        }
        await closeHandle(sftp, handle);
        handle = null;
        await writeTruncating(sftp, filePath, buffer);
      }
    }
  } finally {
    if (handle) await closeHandle(sftp, handle);
  }
}

function writeTruncating(sftp, filePath, buffer) {
  return new Promise((resolve, reject) => {
    sftp.writeFile(filePath, buffer, { flag: 'w' }, (err) => {
      if (!err) {
        resolve();
        return;
      }
      if (isPermissionError(err)) err.needsSudo = true;
      reject(err);
    });
  });
}

function writeTempFile(sftp, tmpPath, buffer) {
  return new Promise((resolve, reject) => {
    sftp.writeFile(tmpPath, buffer, { flag: 'w', mode: 0o600 }, (err) => (err ? reject(err) : resolve()));
  });
}

function unlinkRemote(sftp, filePath) {
  return new Promise((resolve) => {
    if (!sftp) {
      resolve();
      return;
    }
    sftp.unlink(filePath, () => resolve());
  });
}

async function prepareRemoteWrite(sftp, payload) {
  const filePath = payload && payload.path;
  const content = payload && payload.content;
  if (typeof filePath !== 'string' || !filePath) {
    return { error: { success: false, error: 'A remote file path is required.' } };
  }
  if (typeof content !== 'string') {
    return { error: { success: false, error: 'File content must be text.' } };
  }
  if (content.includes('\0')) {
    return { error: { success: false, error: 'The text contains binary data and was not saved.' } };
  }

  const buffer = Buffer.from(content, 'utf8');
  if (buffer.length > MAX_PREVIEW_BYTES) {
    return { error: { success: false, error: 'File is too large to save. Limit is 1 MB.' } };
  }
  if (sftpSession !== sftp) {
    return { error: { success: false, error: 'Saving is unavailable because the connection was lost.' } };
  }

  const stats = await statRemote(sftp, filePath);
  if (sftpSession !== sftp) {
    return { error: { success: false, error: 'Saving is unavailable because the connection was lost.' } };
  }
  const S_IFMT = 0o170000;
  const S_IFREG = 0o100000;
  if (stats.mode && (stats.mode & S_IFMT) !== S_IFREG) {
    return { error: { success: false, error: 'Only regular files can be edited.' } };
  }

  const remoteMtime = typeof stats.mtime === 'number' ? stats.mtime : null;
  const remoteSize = typeof stats.size === 'number' ? stats.size : null;
  const change = assessRemoteChange({
    expectedMtime: payload.expectedMtime,
    expectedSize: payload.expectedSize,
    remoteMtime,
    remoteSize,
    force: payload.force === true,
  });
  if (change.conflict) {
    return {
      error: { success: false, conflict: true, error: change.error, mtime: remoteMtime, size: remoteSize },
    };
  }

  return { filePath, buffer, previousSize: remoteSize };
}

async function savedFileResult(sftp, filePath, fallbackSize) {
  let after = null;
  try {
    after = await statRemote(sftp, filePath);
  } catch {
    after = null;
  }
  return {
    success: true,
    mtime: after && typeof after.mtime === 'number' ? after.mtime : null,
    size: after && typeof after.size === 'number' ? after.size : fallbackSize,
  };
}

function saveFailure(err) {
  const msg = (err && err.message) || 'Save failed';
  if (!sftpSession || /no response from server|not connected|connection lost/i.test(msg)) {
    return { success: false, error: 'Saving is unavailable because the connection was lost.' };
  }
  // The SSH account cannot write. The editor asks for an account that can
  // and saves with su. This is not a sudo prompt.
  if (err && (err.needsSudo || isPermissionError(err))) {
    return { success: false, needsElevation: true, error: 'Permission denied' };
  }
  return { success: false, error: msg };
}

function accountFactsCommand(uid, gid) {
  const uidArg = Number.isInteger(uid) && uid >= 0 ? String(uid) : '-1';
  const gidArg = Number.isInteger(gid) && gid >= 0 ? String(gid) : '-1';
  return [
    'u=$(id -un 2>/dev/null || true)',
    'printf \'CURRENT %s\\n\' "$u"',
    'uidmin=$(awk \'$1=="UID_MIN" { print $2; exit }\' /etc/login.defs 2>/dev/null || true)',
    'printf \'UIDMIN %s\\n\' "$uidmin"',
    'if command -v getent >/dev/null 2>&1; then',
    `  pw=$(getent passwd ${uidArg} 2>/dev/null || true)`,
    `  gr=$(getent group ${gidArg} 2>/dev/null || true)`,
    'else',
    `  pw=$(awk -F: -v id=${uidArg} '$3==id { print; exit }' /etc/passwd 2>/dev/null || true)`,
    `  gr=$(awk -F: -v id=${gidArg} '$3==id { print; exit }' /etc/group 2>/dev/null || true)`,
    'fi',
    'printf \'PASSWD %s\\n\' "$pw"',
    'members=$(printf \'%s\' "$gr" | awk -F: \'{ print $4 }\')',
    'count=0',
    'oldifs=$IFS',
    'IFS=,',
    'for name in $members; do',
    '  [ -n "$name" ] || continue',
    '  count=$((count + 1))',
    '  [ "$count" -le 40 ] || break',
    '  if command -v getent >/dev/null 2>&1; then',
    '    ent=$(getent passwd "$name" 2>/dev/null || true)',
    '  else',
    '    ent=$(awk -F: -v n="$name" \'$1==n { print; exit }\' /etc/passwd 2>/dev/null || true)',
    '  fi',
    '  printf \'MEMBER %s\\n\' "$ent"',
    'done',
    'IFS=$oldifs',
  ].join('\n');
}

async function describeElevation(filePath) {
  const fallback = {
    writeUser: 'root',
    writeVia: 'root',
    ownerName: '',
    ownerUid: null,
    modeText: '',
    currentUser: '',
  };
  if (!sftpSession || !sshClient || typeof filePath !== 'string' || !filePath) return fallback;

  let stats = null;
  try {
    stats = await statRemote(sftpSession, filePath);
  } catch {
    stats = null;
  }
  const uid = stats && Number.isInteger(stats.uid) ? stats.uid : null;
  const gid = stats && Number.isInteger(stats.gid) ? stats.gid : null;
  const mode = stats && Number.isInteger(stats.mode) ? stats.mode : null;

  let facts = { currentUser: '', owner: null, groupMembers: [], uidMin: null };
  try {
    const { stdout } = await runExec(accountFactsCommand(uid, gid), undefined, { timeoutMs: 8000 });
    facts = parseAccountFacts(stdout);
  } catch {
    facts = { currentUser: '', owner: null, groupMembers: [], uidMin: null };
  }

  const choice = chooseWriteAccount({
    mode: mode == null ? 0 : mode,
    currentUser: facts.currentUser,
    owner: facts.owner,
    groupMembers: facts.groupMembers,
    uidMin: facts.uidMin,
  });
  return {
    writeUser: choice.username,
    writeVia: choice.via,
    ownerName: facts.owner && facts.owner.name || '',
    ownerUid: uid,
    modeText: mode == null ? '' : formatFileMode(mode),
    currentUser: facts.currentUser,
  };
}

function redactSecret(text, secret) {
  const raw = String(text || '');
  if (typeof secret !== 'string' || secret.length < 1) return raw;
  return raw.split(secret).join('');
}

// Overwrite the existing inode. dd (or a shell redirect) truncates in place,
// so the owner and mode stay as they are. The destination is never removed.
function buildInPlaceScript(tmpPath, destPath, marker) {
  const tmp = escapeSh(tmpPath);
  const dest = escapeSh(destPath);
  const mark = escapeSh(marker);
  return [
    'inode=$(stat -c %i -- ' + dest + ' 2>/dev/null || stat -f %i -- ' + dest + ' 2>/dev/null || true)',
    'if command -v dd >/dev/null 2>&1; then',
    '  dd if=' + tmp + ' of=' + dest,
    'else',
    '  cat ' + tmp + ' > ' + dest,
    'fi',
    'status=$?',
    'if [ "$status" -ne 0 ]; then exit "$status"; fi',
    'if [ -n "$inode" ]; then',
    '  now=$(stat -c %i -- ' + dest + ' 2>/dev/null || stat -f %i -- ' + dest + ' 2>/dev/null || true)',
    '  if [ -n "$now" ] && [ "$now" != "$inode" ]; then',
    '    echo "The file would have been replaced instead of updated in place." >&2',
    '    exit 1',
    '  fi',
    'fi',
    'printf \'%s\\n\' ' + mark,
    'exit 0',
  ].join('\n');
}

function suCommand(username, script, forceShell) {
  const user = escapeSh(username);
  const body = escapeSh(script);
  // Username comes before -c so both util-linux and BSD su pass -c to the
  // shell. This is the same authentication as `su -`: the target account's
  // password is read from the terminal, not from sudo.
  if (forceShell) return `su -s /bin/sh ${user} -c ${body}`;
  return `su ${user} -c ${body}`;
}

function suRejectedInvocation(result) {
  if (!result || result.promptCount > 0 || isSuAuthFailure(result.output)) return false;
  return /invalid option|unknown option|unrecognized option|illegal option|unrecognized flag/i.test(result.output || '');
}

async function runSuScript(username, password, script) {
  let result = await runPty(suCommand(username, script, true), password);
  if (suRejectedInvocation(result)) {
    result = await runPty(suCommand(username, script, false), password);
  }
  return result;
}

ipcMain.handle('ssh:readfile', (_event, { path: filePath }) => {
  return new Promise((resolve) => {
    if (!sftpSession) {
      resolve({ success: false, error: 'Not connected' });
      return;
    }

    // First stat the file to check size
    sftpSession.stat(filePath, (statErr, stats) => {
      if (statErr) {
        resolve({ success: false, error: statErr.message });
        return;
      }

      if (stats.size > MAX_PREVIEW_BYTES) {
        resolve({ success: false, error: `File is too large to preview (${(stats.size / 1024 / 1024).toFixed(1)} MB). Limit is 1 MB.` });
        return;
      }

      sftpSession.readFile(filePath, (err, data) => {
        if (err) {
          resolve({ success: false, error: err.message });
          return;
        }

        // Detect binary: check first 8 KB for null bytes
        const sample = data.slice(0, 8192);
        const hasBinary = sample.includes(0x00);

        if (hasBinary) {
          resolve({ success: false, error: 'Binary file — cannot preview.' });
          return;
        }

        resolve({
          success: true,
          content: data.toString('utf8'),
          size: stats.size,
          mtime: typeof stats.mtime === 'number' ? stats.mtime : null,
          utf8: isValidUtf8(data),
        });
      });
    });
  });
});

// ── SSH: Write file contents (regular SFTP files only) ───────────────────────
ipcMain.handle('ssh:writefile', async (_event, payload) => {
  const sftp = sftpSession;
  if (!sftp) {
    return { success: false, error: 'Saving is unavailable because the connection was lost.' };
  }

  try {
    const prepared = await prepareRemoteWrite(sftp, payload);
    if (prepared.error) return prepared.error;

    await writeRemoteFile(sftp, prepared.filePath, prepared.buffer, prepared.previousSize);
    return await savedFileResult(sftp, prepared.filePath, prepared.buffer.length);
  } catch (err) {
    const failure = saveFailure(err);
    if (!failure.needsElevation || !sftpSession) return failure;
    const extra = await describeElevation(payload && payload.path);
    return { ...failure, ...extra, needsElevation: true };
  }
});

// Permission was denied for the SSH account. Stage the new text, then su to
// the account that can write and overwrite the existing file in place.
ipcMain.handle('ssh:writefile-as', async (_event, payload) => {
  const sftp = sftpSession;
  if (!sftp || !sshClient) {
    return { success: false, error: 'Saving is unavailable because the connection was lost.' };
  }
  const username = payload && payload.username;
  const password = payload && payload.password;
  if (!isSafeAccountName(username)) {
    return { success: false, error: 'Enter the name of an account that can write this file.' };
  }
  if (typeof password !== 'string' || !password) {
    return { success: false, error: `A password for ${username} is required.` };
  }
  if (password.length > 1024 || /[\0\r\n]/.test(password)) {
    return { success: false, error: `The password for ${username} cannot be used.` };
  }

  let tmpPath = null;
  try {
    const prepared = await prepareRemoteWrite(sftp, payload);
    if (prepared.error) return prepared.error;

    tmpPath = `/tmp/.ssh-explorer-save-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    await writeTempFile(sftp, tmpPath, prepared.buffer);
    // Root can read a mode-600 staged file. Any other account needs it readable.
    // The staged file is removed as soon as the write finishes.
    if (username !== 'root') {
      await runExec(`chmod 644 ${escapeSh(tmpPath)}`, undefined, { timeoutMs: 8000 });
    }

    const marker = `BROWSME_SAVE_OK_${crypto.randomBytes(6).toString('hex')}`;
    const script = buildInPlaceScript(tmpPath, prepared.filePath, marker);
    const result = await runSuScript(username, password, script);
    if (!sftpSession || !sshClient) {
      return { success: false, error: 'Saving is unavailable because the connection was lost.' };
    }

    const raw = result.output || '';
    const saved = raw.includes(marker);
    const wrongPassword = !saved && (result.promptCount > 1 || isSuAuthFailure(raw));
    if (saved) {
      return await savedFileResult(sftp, prepared.filePath, prepared.buffer.length);
    }
    if (wrongPassword) {
      return { success: false, wrongPassword: true, error: `Incorrect password for ${username}.` };
    }
    const shown = redactSecret(raw, password);
    return {
      success: false,
      wrongPassword: false,
      error: usefulTerminalError(shown, marker),
    };
  } catch (err) {
    const failure = saveFailure(err);
    if (failure.needsElevation) {
      return { success: false, error: `${username} could not write this file. It was not changed.` };
    }
    return failure;
  } finally {
    if (tmpPath) await unlinkRemote(sftpSession, tmpPath);
  }
});

// ── SSH: Home directory ───────────────────────────────────────────────────────
ipcMain.handle('ssh:homedir', () => {
  return new Promise((resolve) => {
    if (!sshClient) {
      resolve({ success: false, error: 'Not connected' });
      return;
    }

    sshClient.exec('echo $HOME', (err, stream) => {
      if (err) {
        resolve({ success: true, path: '/' });
        return;
      }

      let data = '';
      stream.on('data', (chunk) => { data += chunk.toString(); });
      stream.stderr.on('data', () => {});
      stream.on('close', () => {
        const home = data.trim();
        resolve({ success: true, path: home || '/' });
      });
    });
  });
});
