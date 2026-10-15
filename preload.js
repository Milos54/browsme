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
  exit:       ()      => ipcRenderer.invoke('ssh:exit'),
  hop:        (opts)  => ipcRenderer.invoke('ssh:hop', opts),
  rename:     (oldPath, newPath) => ipcRenderer.invoke('ssh:rename', { oldPath, newPath }),

  // Docker
  dockerUpload:     (localPath, containerId, containerDir) => ipcRenderer.invoke('ssh:docker-upload', { localPath, containerId, containerDir }),
  dockerContainers: ()                          => ipcRenderer.invoke('ssh:docker-containers'),
  dockerReaddir:    (containerId, path)         => ipcRenderer.invoke('ssh:docker-readdir',  { containerId, path }),
  dockerReadfile:   (containerId, path)         => ipcRenderer.invoke('ssh:docker-readfile', { containerId, path }),
  dockerStat:       (containerId, path)         => ipcRenderer.invoke('ssh:docker-stat',     { containerId, path }),
  dockerWritefile:  (containerId, path, content, opts) => ipcRenderer.invoke('ssh:docker-writefile', {
    containerId,
    path,
    content,
    expectedMtime: opts && opts.expectedMtime,
    expectedSize: opts && opts.expectedSize,
    force: !!(opts && opts.force),
  }),
  dockerDelete:     (containerId, path)         => ipcRenderer.invoke('ssh:docker-delete',   { containerId, path }),
  dockerRename:     (containerId, old, newPath) => ipcRenderer.invoke('ssh:docker-rename',   { containerId, oldPath: old, newPath }),
  copy:       (srcPath, dstPath)           => ipcRenderer.invoke('ssh:copy',       { srcPath, dstPath }),
  copySudo:   (srcPath, dstPath, password) => ipcRenderer.invoke('ssh:copy-sudo',  { srcPath, dstPath, password }),
  delete:     (path)  => ipcRenderer.invoke('ssh:delete', { path }),
  deleteSudo: (path, password) => ipcRenderer.invoke('ssh:delete-sudo', { path, password }),
  readdir:    (path)  => ipcRenderer.invoke('ssh:readdir', { path }),
  readfile:   (path)  => ipcRenderer.invoke('ssh:readfile', { path }),
  writefile:  (path, content, opts) => ipcRenderer.invoke('ssh:writefile', {
    path,
    content,
    expectedMtime: opts && opts.expectedMtime,
    expectedSize: opts && opts.expectedSize,
    force: !!(opts && opts.force),
  }),
  writefileAs: (path, content, username, password, opts) => ipcRenderer.invoke('ssh:writefile-as', {
    path,
    content,
    username,
    password,
    expectedMtime: opts && opts.expectedMtime,
    expectedSize: opts && opts.expectedSize,
    force: !!(opts && opts.force),
  }),
  upload:     (localPath, remotePath) => ipcRenderer.invoke('ssh:upload', { localPath, remotePath }),
  onUploadProgress: (cb) => ipcRenderer.on('upload:progress', (_e, data) => cb(data)),
  getFilePath: (file) => webUtils.getPathForFile(file),
  homedir:    ()      => ipcRenderer.invoke('ssh:homedir'),

  // Non-secret SSH form history in the app user-data directory.
  loadFormMemory: () => ipcRenderer.invoke('form-memory:load'),
  saveFormMemory: (data) => ipcRenderer.invoke('form-memory:save', data),
  flushFormMemory: (data) => ipcRenderer.sendSync('form-memory:flush', data),
});
