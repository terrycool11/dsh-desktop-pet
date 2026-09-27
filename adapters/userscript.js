// ==UserScript==
// @name         DSH 桌宠
// @namespace    https://github.com/terrycool11/dsh-desktop-pet
// @version      1.0.0
// @description  在页面角落养一只会漂浮、能拖动的 Q 版桌宠，顺手显示 DeepSeek 余额 / 消耗 / Tokens
// @author       terrycool11
// @license      MIT
// @match        http://127.0.0.1:*/*
// @match        http://localhost:*/*
// @require      https://raw.githubusercontent.com/terrycool11/dsh-desktop-pet/main/src/pet.js
// @resource     dshPetChibi https://raw.githubusercontent.com/terrycool11/dsh-desktop-pet/main/assets/chibi-full.png
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_getResourceURL
// @grant        GM_xmlhttpRequest
// @connect      api.deepseek.com
// ==/UserScript==

/* 想让它出现在别的网站？把上面 @match 里的两条 host 规则换成「匹配全部站点」的通配写法即可（Tampermonkey 文档里叫 match all）。
   API Key 只存在油猴本地存储里，不会上传到任何地方。 */

(function () {
  'use strict';

  if (typeof DshPet === 'undefined') {
    console.warn('[桌宠] pet.js 没加载成功，检查 @require 是否可访问');
    return;
  }

  var KEY_API = 'dsh-pet-api-key';
  var KEY_STATE = 'dsh-pet-usage';
  var KEY_HIDE = 'dsh-pet-hidden';
  var POLL_MS = 60000;
  var ASSET_URL = 'https://raw.githubusercontent.com/terrycool11/dsh-desktop-pet/main/assets/chibi-full.png';

  function todayKey() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function store(key, val) { GM_setValue(key, JSON.stringify(val)); }
  function load(key, dflt) {
    try { var v = JSON.parse(GM_getValue(key, 'null')); return v === null ? dflt : v; }
    catch (e) { return dflt; }
  }

  var state = load(KEY_STATE, { day: null, daySpent: 0, last: null, balance: null, currency: 'CNY' });
  var runStart = null;
  var lastError = null;

  function fetchBalance(apiKey) {
    return new Promise(function (resolve) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://api.deepseek.com/user/balance',
        headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
        timeout: 15000,
        onload: function (r) {
          if (r.status < 200 || r.status >= 300) return resolve({ ok: false, error: 'HTTP ' + r.status });
          try { resolve({ ok: true, data: JSON.parse(r.responseText) }); }
          catch (e) { resolve({ ok: false, error: '返回内容不是 JSON' }); }
        },
        onerror: function () { resolve({ ok: false, error: '网络错误' }); },
        ontimeout: function () { resolve({ ok: false, error: '超时' }); }
      });
    });
  }

  async function sample() {
    var apiKey = GM_getValue(KEY_API, '');
    if (!apiKey) { lastError = '没设置 API Key'; return; }
    var res = await fetchBalance(apiKey);
    if (!res.ok) { lastError = res.error; return; }
    var info = (res.data.balance_infos || [])[0];
    if (!info) { lastError = '接口未返回余额'; return; }

    var cur = parseFloat(info.total_balance);
    var day = todayKey();
    if (state.day !== day) { state.day = day; state.daySpent = 0; }
    if (runStart === null) runStart = cur;
    if (state.last !== null && cur < state.last) {
      state.daySpent = Number((state.daySpent + (state.last - cur)).toFixed(6));
    }
    state.last = cur;
    state.balance = cur;
    state.currency = info.currency || 'CNY';
    lastError = null;
    store(KEY_STATE, state);
  }

  function snapshot() {
    var cur = state.balance;
    return {
      ok: !lastError,
      balance: cur,
      currency: state.currency,
      runSpent: (runStart !== null && cur !== null) ? Math.max(0, Number((runStart - cur).toFixed(6))) : null,
      daySpent: state.daySpent,
      error: lastError
    };
  }

  var asset = ASSET_URL;
  try { var local = GM_getResourceURL('dshPetChibi'); if (local) asset = local; } catch (e) { /* 没声明 @resource 就用网络图 */ }

  var pet = DshPet.create({
    asset: asset,
    width: 140,
    left: 10,
    bottom: 52,
    brand: 'DSH 桌宠',
    storageKey: 'dsh-pet-pos-userscript',
    provider: snapshot,
    refreshMs: POLL_MS
  });

  if (load(KEY_HIDE, false)) pet.el.style.display = 'none';

  sample().then(function () { pet.refresh(false); });
  setInterval(function () { sample().then(function () { pet.refresh(false); }); }, POLL_MS);

  /* ---------- 菜单 ---------- */
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('设置 API Key', function () {
      var cur = GM_getValue(KEY_API, '');
      var v = prompt('填入 DeepSeek API Key（sk- 开头，仅保存在本机）', cur ? cur.slice(0, 6) + '…' + cur.slice(-4) : '');
      if (v === null) return;
      v = v.trim().replace(/^["']|["']$/g, '');
      if (!v) { GM_deleteValue(KEY_API); alert('已清除 API Key'); return; }
      GM_setValue(KEY_API, v);
      sample().then(function () { pet.refresh(true); alert(lastError ? '保存了，但查询失败：' + lastError : '保存成功'); });
    });
    GM_registerMenuCommand('显示 / 隐藏桌宠', function () {
      var hidden = !load(KEY_HIDE, false);
      store(KEY_HIDE, hidden);
      pet.el.style.display = hidden ? 'none' : '';
    });
    GM_registerMenuCommand('复位桌宠位置', function () {
      try { localStorage.removeItem('dsh-pet-pos-userscript'); } catch (e) {}
      pet.el.style.top = 'auto'; pet.el.style.left = '10px'; pet.el.style.bottom = '52px';
    });
    GM_registerMenuCommand('立刻刷新余额', function () {
      sample().then(function () { pet.refresh(true); });
    });
    GM_registerMenuCommand('查看状态', function () {
      var s = snapshot();
      alert('余额：' + (s.balance === null ? '—' : s.balance + ' ' + s.currency) +
        '\n本次消耗：' + (s.runSpent === null ? '—' : s.runSpent) +
        '\n今日消耗：' + (s.daySpent || 0) +
        '\n错误：' + (s.error || '无'));
    });
  }
})();
