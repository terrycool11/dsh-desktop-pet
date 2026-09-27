/* ============================================================
   DSH 桌宠 · Electron preload 桥
   —— 放到你应用的 preload 里（或作为它的内容），配合 adapters/electron.js 使用
   暴露 window.dshPet，桌宠靠它拿余额数据和形象图片。
   ============================================================ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshPet', {
  /** 取用量快照：{ ok, balance, currency, runSpent, daySpent, ... } */
  stats: () => ipcRenderer.invoke('pet:stats'),
  /** 立刻重新采样余额（返回最新快照） */
  refresh: () => ipcRenderer.invoke('pet:refresh'),
  /** 形象图片，返回 data URL（避免 file:// 被页面拦） */
  asset: () => ipcRenderer.invoke('pet:asset')
});
