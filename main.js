const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { Client } = require('ssh2');

let mainWindow   = null;
let jumpClient   = null;   // first-hop (bastion) — null when not used
let sshClient    = null;   // final target
let sftpSession  = null;

// SSH agent socket for key-based auth (no password needed on target)
const agentSocket = process.platform === 'win32'
  ? '\\\\.\\pipe\\openssh-ssh-agent'
  : (process.env.SSH_AUTH_SOCK || undefined);

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
  if (sshClient)  sshClient.end();
  if (jumpClient) jumpClient.end();
  if (process.platform !== 'darwin') app.quit();
});

// ── Window controls ───────────────────────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow.minimize());
ipcMain.on('window:maximize', () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close', () => {
  if (sshClient)  sshClient.end();
  if (jumpClient) jumpClient.end();
  mainWindow.close();
});
ipcMain.handle('window:is-maximized', () => mainWindow.isMaximized());

// ── Helpers ───────────────────────────────────────────────────────────────────
function cleanupConnections() {
  if (sshClient)  { sshClient.end();  sshClient  = null; }
  if (jumpClient) { jumpClient.end(); jumpClient = null; }
  sftpSession = null;
}

/** Open SFTP on an already-ready ssh2 Client and resolve. */
function openSftp(client, resolve) {
  client.sftp((err, sftp) => {
    if (err) {
      client.end();
      resolve({ success: false, error: `SFTP error: ${err.message}` });
      return;
    }
    sshClient   = client;
    sftpSession = sftp;
    sftp.on('error', () => { sftpSession = null; });
    resolve({ success: true });
  });
}

/** Build connect options — include agent when no password supplied. */
function buildConnectOpts(host, port, username, password, extra = {}) {
  const opts = { host, port: port || 22, username, readyTimeout: 15000, ...extra };
  if (password) {
    opts.password = password;
  } else {
    // No password: try local SSH agent (key-based auth)
    if (agentSocket) opts.agent = agentSocket;
  }
  return opts;
}

// ── SSH: Connect ──────────────────────────────────────────────────────────────
ipcMain.handle('ssh:connect', (_event, { host, port, username, password, jump }) => {
  return new Promise((resolve) => {
    cleanupConnections();

    // ── Direct connection (no jump host) ──────────────────────────────────────
    if (!jump) {
      const client  = new Client();
      const timeout = setTimeout(() => {
        client.destroy();
        resolve({ success: false, error: 'Connection timed out after 15 seconds' });
      }, 15000);

      client.on('ready', () => { clearTimeout(timeout); openSftp(client, resolve); });
      client.on('error', (err) => { clearTimeout(timeout); resolve({ success: false, error: err.message }); });
      client.on('end',   () => { sshClient = null; sftpSession = null; });

      try {
        client.connect(buildConnectOpts(host, port, username, password));
      } catch (err) {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
      }
      return;
    }

    // ── Jump-host connection ──────────────────────────────────────────────────
    // Step 1: connect to bastion
    const jClient  = new Client();
    const timeout  = setTimeout(() => {
      jClient.destroy();
      resolve({ success: false, error: 'Jump host connection timed out' });
    }, 15000);

    jClient.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ success: false, error: `Jump host: ${err.message}` });
    });

    jClient.on('ready', () => {
      clearTimeout(timeout);
      jumpClient = jClient;

      // Step 2: open a TCP channel through bastion to the target
      jClient.forwardOut('127.0.0.1', 0, host, port || 22, (err, stream) => {
        if (err) {
          cleanupConnections();
          resolve({ success: false, error: `Tunnel error: ${err.message}` });
          return;
        }

        // Step 3: SSH handshake with the target over the tunnel
        const tClient   = new Client();
        const tTimeout  = setTimeout(() => {
          tClient.destroy();
          cleanupConnections();
          resolve({ success: false, error: 'Target connection timed out' });
        }, 15000);

        tClient.on('ready', () => {
          clearTimeout(tTimeout);
          openSftp(tClient, resolve);
        });
        tClient.on('error', (err) => {
          clearTimeout(tTimeout);
          cleanupConnections();
          resolve({ success: false, error: `Target: ${err.message}` });
        });
        tClient.on('end', () => { sshClient = null; sftpSession = null; });

        try {
          tClient.connect(buildConnectOpts(host, port, username, password, { sock: stream }));
        } catch (err) {
          clearTimeout(tTimeout);
          cleanupConnections();
          resolve({ success: false, error: err.message });
        }
      });
    });

    try {
      jClient.connect(buildConnectOpts(jump.host, jump.port, jump.username, jump.password));
    } catch (err) {
      clearTimeout(timeout);
      resolve({ success: false, error: `Jump host: ${err.message}` });
    }
  });
});

// ── SSH: Disconnect ───────────────────────────────────────────────────────────
ipcMain.handle('ssh:disconnect', () => {
  cleanupConnections();
  return { success: true };
});

// ── SSH: Hop to another server through current connection ─────────────────────
ipcMain.handle('ssh:hop', (_event, { host, port, username, password }) => {
  return new Promise((resolve) => {
    if (!sshClient) {
      resolve({ success: false, error: 'Not connected to any server.' });
      return;
    }

    const hopFrom = sshClient;   // use current connection as the tunnel

    hopFrom.forwardOut('127.0.0.1', 0, host, port || 22, (fwdErr, stream) => {
      if (fwdErr) {
        resolve({ success: false, error: `Tunnel error: ${fwdErr.message}` });
        return;
      }

      const tClient  = new Client();
      const timeout  = setTimeout(() => {
        tClient.destroy();
        resolve({ success: false, error: 'Connection to target timed out.' });
      }, 15000);

      tClient.on('ready', () => {
        clearTimeout(timeout);
        // Promote current connection to jump slot, swap in the new target
        if (jumpClient) jumpClient.end();
        jumpClient  = hopFrom;
        sshClient   = null;
        sftpSession = null;
        openSftp(tClient, resolve);
      });

      tClient.on('error', (err) => {
        clearTimeout(timeout);
        // Connection failed — original sshClient/sftpSession unchanged
        resolve({ success: false, error: err.message });
      });

      try {
        tClient.connect(buildConnectOpts(host, port, username, password, { sock: stream }));
      } catch (err) {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
      }
    });
  });
});

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
function runExec(cmd, stdinData) {
  return new Promise((resolve) => {
    if (!sshClient) { resolve({ code: -1, stdout: '', stderr: 'Not connected' }); return; }
    sshClient.exec(cmd, (err, stream) => {
      if (err) { resolve({ code: -1, stdout: '', stderr: err.message }); return; }
      let stdout = '', stderr = '';
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      if (stdinData !== undefined) { stream.write(stdinData + '\n'); stream.end(); }
      stream.on('close', (code) => resolve({ code, stdout, stderr }));
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

        resolve({ success: true, content: data.toString('utf8'), size: stats.size });
      });
    });
  });
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
