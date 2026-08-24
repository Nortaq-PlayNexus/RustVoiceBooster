const { contextBridge, ipcRenderer } = require('electron');

const RVB = {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // File dialogs
  openFile: () => ipcRenderer.invoke('open-file'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  getFolderAudio: (folder) => ipcRenderer.invoke('get-folder-audio', folder),
  readAudio: (filePath) => ipcRenderer.invoke('read-audio', filePath),
  saveRecording: (arrayBuffer, defaultName) =>
    ipcRenderer.invoke('save-recording', arrayBuffer, defaultName),
  getVersion: () => ipcRenderer.invoke('get-app-version'),

  // Virtual audio device (Voicemod-style) — direct exe -> virtual driver -> game mic
  checkVirtualCable: () => ipcRenderer.invoke('check-virtual-cable'),
  renameCableToRvb: (undo) => ipcRenderer.invoke('rename-cable-to-rvb', undo),
  installVirtualCable: () => ipcRenderer.invoke('install-virtual-cable'),
  getVirtualCableInfo: () => ipcRenderer.invoke('get-virtual-cable-info'),
  openSoundSettings: () => ipcRenderer.invoke('open-sound-settings'),
  // Native direct WASAPI stream (low-latency, bypasses setSinkId)
  cableNativeStatus: () => ipcRenderer.invoke('cable-native-status'),
  cableNativeStart: () => ipcRenderer.invoke('cable-native-start'),
  cableNativeStop: () => ipcRenderer.invoke('cable-native-stop'),
  cableNativePush: (ab) => ipcRenderer.invoke('cable-native-push', ab),
  createRvbClone: () => ipcRenderer.invoke('create-rvb-clone-device'),
};

contextBridge.exposeInMainWorld('RVB', RVB);
