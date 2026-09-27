/* ============================================================
   DSH 桌宠 · Electron 适配器
   —— 把桌宠接进任意 Electron 应用：用量跟踪（主进程） + 注入骨架 + preload 桥
   用法见 README「方式二：Electron 应用」
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const BALANCE_POLL_MS = 60000;
const PET_JS = path.join(__dirname, '..', 'src', 'pet.js');
const DEFAULT_ASSET = path.join(__dirname, '..', 'assets', 'chibi-full.png');

/* ------------------------------------------------------------------
   1) 用量跟踪
   DeepSeek 开放平台只有「查余额」接口，没有用量查询接口，
   所以消耗金额靠采样余额的下降推算：
     本次消耗 = 本次运行首次采样余额 - 当前余额
     今日消耗 = 当天下滑量累加（持久化到 usage.json）
   注意：统计的是整个账号，同一把密钥的其它工具用量也会算进来。
   ------------------------------------------------------------------ */

function todayKey(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function createUsageTracker(opts) {
  const o = opts || {};
  const apiKey = o.apiKey;
  const storePath = o.storePath;
  const baseUrl = (o.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const pollMs = o.pollMs || BALANCE_POLL_MS;
  const timeoutMs = o.timeoutMs || 15000;

  const state = { day: null, daySpent: 0, last: null, balance: null, currency: 'CNY', updatedAt: null, samples: 0 };
  let runStartBalance = null;
  let lastError = null;
  let timer = null;

  function load() {
    if (!storePath) return;
    try {
      const txt = fs.readFileSync(storePath, 'utf8').replace(/^\uFEFF/, '');
      const u = JSON.parse(txt);
      if (u && typeof u === 'object') Object.assign(state, u);
    } catch (e) { /* 首次运行没有文件 */ }
  }
  function save() {
    if (!storePath) return;
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) { /* 只读磁盘等，忽略 */ }
  }

  function request(pathname) {
    return new Promise((resolve) => {
      let url;
      try { url = new URL(baseUrl + pathname); } catch (e) { return resolve({ ok: false, error: '接口地址无效' }); }
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
        timeout: timeoutMs
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return resolve({ ok: false, error: 'HTTP ' + res.statusCode + (body ? ' · ' + body.slice(0, 160) : '') });
          }
          try { resolve({ ok: true, data: JSON.parse(body) }); }
          catch (e) { resolve({ ok: false, error: '返回内容不是 JSON' }); }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', (e) => resolve({ ok: false, error: e.message || String(e) }));
      req.end();
    });
  }

  async function sample() {
    if (!apiKey) { lastError = '没有配置 API Key'; return { ok: false, error: lastError }; }
    const res = await request('/user/balance');
    if (!res.ok) { lastError = res.error; return { ok: false, error: lastError }; }
    const info = (res.data.balance_infos || [])[0];
    if (!info) { lastError = '接口未返回余额'; return { ok: false, error: lastError }; }

    const cur = parseFloat(info.total_balance);
    const day = todayKey();
    if (state.day !== day) { state.day = day; state.daySpent = 0; }
    if (runStartBalance === null) runStartBalance = cur;
    if (state.last !== null && cur < state.last) {
      state.daySpent = Number((state.daySpent + (state.last - cur)).toFixed(6));
    }
    state.last = cur;
    state.balance = cur;
    state.currency = info.currency || 'CNY';
    state.updatedAt = Date.now();
    state.samples = (state.samples || 0) + 1;
    lastError = null;
    save();
    return { ok: true };
  }

  function snapshot() {
    const cur = state.balance;
    return {
      ok: true,
      hasKey: !!apiKey,
      balance: cur,
      currency: state.currency,
      runSpent: (runStartBalance !== null && cur !== null)
        ? Math.max(0, Number((runStartBalance - cur).toFixed(6))) : null,
      daySpent: state.daySpent,
      day: state.day,
      updatedAt: state.updatedAt,
      samples: state.samples,
      error: lastError
    };
  }

  function start() {
    load();
    sample().catch(() => {});
    if (timer) clearInterval(timer);
    timer = setInterval(() => { sample().catch(() => {}); }, pollMs);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { start, stop, sample, snapshot };
}

/* ------------------------------------------------------------------
   2) IPC + 注入
   ------------------------------------------------------------------ */

function assetDataUrl(file) {
  const p = file || DEFAULT_ASSET;
  try {
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.webp' ? 'image/webp' : 'image/png';
    return 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64');
  } catch (e) { return ''; }
}

/**
 * 注册桌宠需要的 IPC（主进程调用一次）
 * @param {import('electron').IpcMain} ipcMain
 * @param {object} o { tracker, asset }
 */
function installIpc(ipcMain, o) {
  const tracker = o.tracker;
  ipcMain.handle('pet:stats', () => tracker.snapshot());
  ipcMain.handle('pet:refresh', async () => { await tracker.sample().catch(() => {}); return tracker.snapshot(); });
  ipcMain.handle('pet:asset', () => assetDataUrl(o.asset));
}

let petSource = null;
function readPetSource() {
  if (petSource === null) petSource = fs.readFileSync(PET_JS, 'utf8');
  return petSource;
}

/**
 * 组装要注入页面的脚本：pet.js + 一段启动代码（用 preload 桥拿数据）
 * @param {object} o { width, left, bottom, tip, brand, storageKey }
 */
function buildInjection(o) {
  const cfg = Object.assign({
    width: 140, left: 10, bottom: 52,
    tip: '拖动我可以换位置', brand: 'DSH 桌宠', storageKey: 'dsh-pet-pos'
  }, o || {});
  return readPetSource() + '\n;(' + bootstrap.toString() + ')(' + JSON.stringify(cfg) + ');';
}

// 在页面里执行：拿桥 → 建桌宠 → 保活
function bootstrap(cfg) {
  (async function () {
    var ID = 'dsh-pet-root';
    if (document.getElementById(ID)) return 'already';
    var bridge = window.dshPet;
    var asset = '';
    if (bridge && bridge.asset) { try { asset = await bridge.asset(); } catch (e) { asset = ''; } }
    var wrap = document.createElement('div');
    wrap.id = ID;
    document.body.appendChild(wrap);

    window.__dshPet = window.DshPet.create(Object.assign({}, cfg, {
      asset: asset,
      mount: wrap,
      provider: (bridge && bridge.stats) ? function () { return bridge.stats(); } : null,
      refreshMs: 30000
    }));

    // 退出前告别：主进程可以调它把台词显示进气泡，停一下再退
    window.__dshPetSay = function (text) {
      try { window.__dshPet.setLine(text, 0); window.__dshPet.show(); return true; } catch (e) { return false; }
    };
    window.__dshPetFarewell = function (text) {
      try { return window.__dshPet.farewell(text); } catch (e) { return ''; }
    };
    return 'ok';
  })().catch(function () { return 'error'; });
}

/**
 * 把桌宠注入一个 Electron 窗口，并在被清掉后自动补回
 * @param {import('electron').WebContents} webContents
 * @param {object} o 同 buildInjection
 * @returns {Function} 取消函数
 */
function attachPet(webContents, o) {
  const code = buildInjection(o);
  let alive = true;
  async function inject() {
    if (!alive || webContents.isDestroyed()) return;
    try { await webContents.executeJavaScript(code, true); } catch (e) { /* 页面切换中，忽略 */ }
  }
  async function ensure() {
    if (!alive || webContents.isDestroyed()) return;
    try {
      const exists = await webContents.executeJavaScript(
        "!!document.getElementById('dsh-pet-root')", true);
      if (!exists) await inject();
    } catch (e) { /* 忽略 */ }
  }
  webContents.on('did-finish-load', inject);
  webContents.on('did-navigate-in-page', inject);
  const keep = setInterval(ensure, 4000);
  inject();
  return function detach() {
    alive = false;
    clearInterval(keep);
    if (!webContents.isDestroyed()) {
      webContents.removeListener('did-finish-load', inject);
      webContents.removeListener('did-navigate-in-page', inject);
    }
  };
}

module.exports = { createUsageTracker, installIpc, attachPet, buildInjection, assetDataUrl, todayKey, BALANCE_POLL_MS };
