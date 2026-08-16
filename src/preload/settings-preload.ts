import { contextBridge, ipcRenderer } from 'electron';
import type { Settings } from '../main/settings';

export type { Settings };

const settingsBridge = {
  get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  set: (s: Settings): Promise<Settings> => ipcRenderer.invoke('settings:set', s)
};

export type SettingsBridge = typeof settingsBridge;

contextBridge.exposeInMainWorld('settingsBridge', settingsBridge);
