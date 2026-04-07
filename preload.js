const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window controls
  minimize:    ()     => ipcRenderer.send('window:minimize'),
  maximize:    ()     => ipcRenderer.send('window:maximize'),
  close:       ()     => ipcRenderer.send('window:close'),
  isMaximized: ()     => ipcRenderer.invoke('window:is-maximized'),

  // SSH / SFTP
  connect:    (opts)  => ipcRenderer.invoke('ssh:connect', opts),
  disconnect: ()      => ipcRenderer.invoke('ssh:disconnect'),
  hop:        (opts)  => ipcRenderer.invoke('ssh:hop', opts),
  rename:     (oldPath, newPath) => ipcRenderer.invoke('ssh:rename', { oldPath, newPath }),
  copy:       (srcPath, dstPath)           => ipcRenderer.invoke('ssh:copy',       { srcPath, dstPath }),
  copySudo:   (srcPath, dstPath, password) => ipcRenderer.invoke('ssh:copy-sudo',  { srcPath, dstPath, password }),
  delete:     (path)  => ipcRenderer.invoke('ssh:delete', { path }),
  deleteSudo: (path, password) => ipcRenderer.invoke('ssh:delete-sudo', { path, password }),
  readdir:    (path)  => ipcRenderer.invoke('ssh:readdir', { path }),
  readfile:   (path)  => ipcRenderer.invoke('ssh:readfile', { path }),
  upload:     (localPath, remotePath) => ipcRenderer.invoke('ssh:upload', { localPath, remotePath }),
  onUploadProgress: (cb) => ipcRenderer.on('upload:progress', (_e, data) => cb(data)),
  getFilePath: (file) => webUtils.getPathForFile(file),
  homedir:    ()      => ipcRenderer.invoke('ssh:homedir'),
});
