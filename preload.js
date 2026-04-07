const { contextBridge, ipcRenderer } = require('electron');

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
  delete:     (path)  => ipcRenderer.invoke('ssh:delete', { path }),
  deleteSudo: (path, password) => ipcRenderer.invoke('ssh:delete-sudo', { path, password }),
  readdir:    (path)  => ipcRenderer.invoke('ssh:readdir', { path }),
  readfile:   (path)  => ipcRenderer.invoke('ssh:readfile', { path }),
  homedir:    ()      => ipcRenderer.invoke('ssh:homedir'),
});
