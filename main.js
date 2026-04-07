const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { Client } = require('ssh2');

let mainWindow = null;
let sshClient = null;
let sftpSession = null;

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
  if (sshClient) sshClient.end();
  if (process.platform !== 'darwin') app.quit();
});

// ── Window controls ───────────────────────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow.minimize());
ipcMain.on('window:maximize', () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close', () => {
  if (sshClient) sshClient.end();
  mainWindow.close();
});
ipcMain.handle('window:is-maximized', () => mainWindow.isMaximized());

// ── SSH: Connect ──────────────────────────────────────────────────────────────
ipcMain.handle('ssh:connect', (_event, { host, port, username, password }) => {
  return new Promise((resolve) => {
    if (sshClient) {
      sshClient.end();
      sshClient = null;
      sftpSession = null;
    }

    const client = new Client();

    const timeout = setTimeout(() => {
      client.destroy();
      resolve({ success: false, error: 'Connection timed out after 15 seconds' });
    }, 15000);

    client.on('ready', () => {
      client.sftp((err, sftp) => {
        clearTimeout(timeout);
        if (err) {
          client.end();
          resolve({ success: false, error: `SFTP error: ${err.message}` });
          return;
        }
        sshClient = client;
        sftpSession = sftp;

        sftp.on('error', () => {
          sftpSession = null;
        });

        resolve({ success: true });
      });
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ success: false, error: err.message });
    });

    client.on('end', () => {
      sshClient = null;
      sftpSession = null;
    });

    try {
      client.connect({
        host,
        port: port || 22,
        username,
        password,
        readyTimeout: 15000,
      });
    } catch (err) {
      clearTimeout(timeout);
      resolve({ success: false, error: err.message });
    }
  });
});

// ── SSH: Disconnect ───────────────────────────────────────────────────────────
ipcMain.handle('ssh:disconnect', () => {
  if (sshClient) {
    sshClient.end();
    sshClient = null;
    sftpSession = null;
  }
  return { success: true };
});

// ── SSH: Read directory ───────────────────────────────────────────────────────
ipcMain.handle('ssh:readdir', (_event, { path: dirPath }) => {
  return new Promise((resolve) => {
    if (!sftpSession) {
      resolve({ success: false, error: 'Not connected' });
      return;
    }

    sftpSession.readdir(dirPath, (err, list) => {
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
          isDirectory: item.attrs.mode
            ? (item.attrs.mode & S_IFMT) === S_IFDIR
            : false,
          isSymlink: item.attrs.mode
            ? (item.attrs.mode & S_IFMT) === S_IFLNK
            : false,
          size: item.attrs.size || 0,
          mtime: item.attrs.mtime || 0,
          permissions: item.attrs.mode || 0,
        }));

      files.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      resolve({ success: true, files });
    });
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
