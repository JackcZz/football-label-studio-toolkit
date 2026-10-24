/*
 * LS 帧检助手 · content script（content.js）v1.6
 * 挂在 Label Studio 页面上的侧栏：点哪帧就看哪帧的标注信息 + 前后帧对照。
 * v1.6 修复/新增：
 *   1. 常驻标志移到左上角且可拖拽（不再挡右下角提交按钮）；面板默认回右上角；
 *   2. 数据新鲜度：当前帧一律直连平台拉取（去掉跨页缓存），平台侧任何写入自动失效缓存；
 *      本地修正层带时间戳，平台数据更新则平台优先——你改过的数据不会再拿旧账；
 *   3. 写入后不再整页刷新：只重拉当前帧重渲染，并尽力触发 LS 预览自行刷新；
 *   4. 跳转/翻帧优先点 LS 列表行（SPA 不重置），整页跳转后自动滚动到目标帧并高亮。
 * v1.5：前后 1-10 帧证据窗口、本地修正层、点击画布定位、独立查看窗、rAF 跟手叠加层。
 * 数据策略：只按需请求单个任务接口（每帧 1+2×窗口数，单次数 KB 级），绝不批量下载。
 */
(function () {
  'use strict';
  var CORE = window.LSFI_CORE;
  /* 算法构建哨兵：core.js 可能被页面缓存成旧版（面板显示新版本号、算法跑旧逻辑，
   * number 类型等新解析全失效）。构建号不达标就在面板挂红条提示 F5。 */
  var NEED_CORE_BUILD = 3;
  function coreBuildOk() { return !!(CORE && CORE.CORE_BUILD && CORE.CORE_BUILD >= NEED_CORE_BUILD); }
  var APIW = window.LSFI_API;
  console.log('[帧检助手] content script 已启动（v1.5），core.js 加载：' + !!CORE + '，api.js 加载：' + !!APIW);
  if (!CORE || !APIW) {
    console.error('[帧检助手] core.js / api.js 未加载，请检查 manifest.json 的 js 顺序');
    return;
  }

  var API = location.origin + '/api';
  var MAX_CACHE = 400;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* ---------------- 诊断信息（一键复制给开发者排查） ---------------- */
  var diag = { boot: Date.now(), listHits: 0, taskLoads: 0, errors: [] };
  // 本地时间戳（诊断标题用，和事件日志保持一致）
  function localStamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function diagLog(msg) {
    var t = new Date().toTimeString().slice(0, 8);
    diag.errors.push(t + ' ' + msg);
    if (diag.errors.length > 30) diag.errors.shift();
  }

  /* ============================================================
   * 任务清单登记：拦截页面自身对 /api/projects/<id>/tasks 的请求，
   * 把「帧号 → task id」登记下来（零额外请求，只用 LS 已加载的数据）。
   * task id 是全平台全局分配且与帧序无关，禁止用 id±1 推前后帧。
   * ============================================================ */
  var taskRegistry = {};
  var listUrlTemplate = null;
  var idToFrame = {};        // task id -> 帧号（跳转时找列表行用）
  var annToTask = {};        // annotation id -> task id（平台写入时定位缓存）
  var taskStore = {};        // taskId -> 完整 task（来自页面自身的列表请求，免额外 API）
  var submittedMap = {};     // pid:frame -> bool（是否已提交，对应左列表 0/1 列）
  var dirtyMap = {};         // pid:frame -> 时间戳（刚被改过，10 分钟内一律直连平台重拉）
  var LIST_RE = /\/api\/projects\/(\d+)\/tasks(\?|$)/;
  var WRITE_RE = /\/api\/(annotations|tasks|drafts)(\/|$)/;
  var WRITE_METHODS = { POST: 1, PATCH: 1, PUT: 1, DELETE: 1 };

  function ingestTaskList(url, json) {
    var m = url.match(LIST_RE);
    if (!m) return;
    if (!listUrlTemplate) listUrlTemplate = String(url);
    var arr = Array.isArray(json) ? json : (json && Array.isArray(json.tasks) ? json.tasks : (json && Array.isArray(json.results) ? json.results : null));
    if (!arr) return;
    var n = 0;
    for (var i = 0; i < arr.length; i++) {
      var t = arr[i];
      if (t && t.id != null && t.data && t.data.frame != null) {
        taskRegistry[m[1] + ':' + t.data.frame] = t.id;
        idToFrame[t.id] = t.data.frame;
        // 提交状态：列表数据里 annotations 非空即已提交（对应左列表 0/1 列）
        submittedMap[m[1] + ':' + t.data.frame] = !!(t.annotations && t.annotations.length);
        // 页面列表请求自带的完整 task（含标注/预测）存下来，优先复用，免额外请求
        // 但"刚被改过"的帧不缓存，避免拿旧数据算建议
        if (((t.predictions && t.predictions.length) || (t.annotations && t.annotations.length) || (t.drafts && t.drafts.length)) && !isDirty(m[1] + ':' + t.data.frame)) {
          if (Object.keys(taskStore).length > 3000) taskStore = {};
          taskStore[t.id] = t;
          (t.annotations || []).forEach(function (a) { if (a.id != null) annToTask[a.id] = t.id; });
        }
        n++;
      }
    }
    if (n) {
      console.log('[帧检助手] 任务清单登记 +' + n + ' 条（帧号→task id，来源：页面自身请求）');
      diag.listHits++;
      diagLog('清单拦截 +' + n + ' 条（累计 ' + diag.listHits + ' 次）');
    }
  }

  // 平台侧发生写入（用户在 LS 里提交/更新）→ 失效缓存与本地修正，保证拿最新数据
  // ours=true 表示是插件自己的请求（已自行处理刷新），跳过
  function onPlatformWrite(url, method, ours) {
    if (ours) return;
    if (!WRITE_METHODS[String(method || 'GET').toUpperCase()]) return;
    if (!WRITE_RE.test(url)) return;
    var hit = {};
    var m = url.match(/\/api\/annotations\/(\d+)/);
    if (m && annToTask[m[1]]) hit[annToTask[m[1]]] = 1;
    var m2 = url.match(/\/api\/tasks\/(\d+)/);
    if (m2) hit[m2[1]] = 1;
    if (ctx.id) hit[ctx.id] = 1;
    var n = 0;
    Object.keys(hit).forEach(function (id) {
      if (mem.delete(id)) n++;
      if (taskStore[id]) { delete taskStore[id]; n++; }
    });
    // 当前帧的本地修正若被平台新数据取代，去掉本地层
    var pid = APIW.projectIdFromPath();
    var fr = (ctx.task && ctx.task.data) ? ctx.task.data.frame : null;
    if (pid && fr != null && localFix[pid + ':' + fr]) {
      delete localFix[pid + ':' + fr];
      saveLocalFix();
    }
    // 平台上发生过写入 → 页面列表带来的 task 副本全部作废（下次一律直连平台）
    taskStore = {};
    console.log('[帧检助手] 检测到平台写入，缓存已失效（' + Object.keys(hit).join(',') + '）');
    // 写的是当前帧 → 防抖重载，让面板马上看到最新数据
    if (hit[ctx.id]) scheduleReload(700);
  }

  // LS 自己拉取某个 task 详情（用户点开/重复点某帧、LS 自行刷新预览）→
  // 缓存副本可能过期：删掉；若正是当前帧 → 防抖重载（解决"重复点同一帧不刷新"）
  var reloadTimer = null;
  var lastLoadAt = 0;
  function scheduleReload(delay) {
    // 刚加载过（1 秒内）就不重复调度，避免连点造成重复请求
    if (Date.now() - lastLoadAt < 900) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(function () { reloadTimer = null; loadCurrent(false); }, delay || 600);
  }
  function onLsTaskFetch(url) {
    var m = url.match(/\/api\/tasks\/(\d+)(\?|$)/);
    if (!m) return;
    var id = m[1];
    if (taskStore[id]) delete taskStore[id];
    if (id !== ctx.id && mem.has(id)) mem.delete(id);
    if (String(id) === String(ctx.id)) {
      console.log('[帧检助手] LS 重新拉取当前 task，刷新面板数据');
      scheduleReload(600);
    }
  }

  try {
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function () {
        var args = arguments;
        try {
          var u0 = (args[0] && args[0].url) || String(args[0] || '');
          var m0 = (args[1] && args[1].method) || 'GET';
          var mine = !!(args[1] && args[1].headers && (args[1].headers['X-LSFI'] || args[1].headers['x-lsfi']));
          onPlatformWrite(u0, m0, mine);
          if (!mine) onLsTaskFetch(u0);
        } catch (e) { }
        return origFetch.apply(this, args).then(function (res) {
          try {
            var u = res.url || (args[0] && args[0].url) || String(args[0] || '');
            if (LIST_RE.test(u)) {
              res.clone().json().then(function (j) { ingestTaskList(u, j); }).catch(function () { });
            }
          } catch (e) { }
          return res;
        });
      };
    }
  } catch (e) { console.warn('[帧检助手] fetch 拦截失败', e); }

  try {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._lsfiUrl = url;
      this._lsfiMethod = method;
      try {
        onPlatformWrite(String(url), method, false);
        onLsTaskFetch(String(url));
      } catch (e) { }
      return origOpen.apply(this, arguments);
    };
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', function () {
        try {
          if (this._lsfiUrl && LIST_RE.test(this._lsfiUrl) && this.responseText) {
            ingestTaskList(this._lsfiUrl, JSON.parse(this.responseText));
          }
        } catch (e) { }
      });
      return origSend.apply(this, arguments);
    };
  } catch (e) { console.warn('[帧检助手] XHR 拦截失败', e); }

  function lookupNeighbors(pid, frame) {
    return {
      prev: taskRegistry[pid + ':' + (Number(frame) - 1)] || null,
      next: taskRegistry[pid + ':' + (Number(frame) + 1)] || null
    };
  }

  /* ---------------- 本地修正层（确认写入后，后续帧优先用它当证据） ---------------- */
  var localFix = {}; // key: pid:frame -> {result, ts}
  var LOCAL_CAP = 300;
  function loadLocalFix() {
    if (!sess) return;
    try {
      sess.get('localFix', function (o) {
        if (o && o.localFix) {
          localFix = o.localFix || {};
          console.log('[帧检助手] 载入本地修正层 ' + Object.keys(localFix).length + ' 帧');
        }
      });
    } catch (e) { }
  }
  function saveLocalFix() {
    if (!sess) return;
    if (Object.keys(localFix).length > LOCAL_CAP) return; // 超限只保留内存，不落盘
    try { sess.set({ localFix: localFix }); } catch (e) { }
  }

  /* ---------------- 修改历史（退回用：存每帧修改前的原始数据） ---------------- */
  var editHistory = {}; // key: pid:frame -> {orig, ts, created, annotationId, applied}
  var HISTORY_CAP = 100;
  function loadHistory() {
    if (!sess) return;
    try {
      sess.get('editHistory', function (o) {
        if (o && o.editHistory) {
          editHistory = o.editHistory || {};
          console.log('[帧检助手] 载入修改历史 ' + Object.keys(editHistory).length + ' 帧');
        }
      });
    } catch (e) { }
  }
  function saveHistory() {
    if (!sess) return;
    if (Object.keys(editHistory).length > HISTORY_CAP) return;
    try { sess.set({ editHistory: editHistory }); } catch (e) { }
  }

  /* ---------------- 原始数据基线（本地持久存档：队别/号码/位置/大小，不含图片） ----------------
   * 每帧第一次被打开时，把平台上的原始框数据存进 chrome.storage.local（跨会话保留），
   * 供退回参考、导出备份、以及核对平台数据是否被外部改动。 */
  var baseline = {}; // 'pid:frame' -> {b: [[rid,label,num,x,y,w,h],...], ts}
  var BASE_CAP = 3000;
  var baselineLoaded = false, baselineDirty = false, baselineTimer = null;

  function baselineStorageKey(pid) { return 'lsfi_base_' + pid; }
  function loadBaseline() {
    var pid = APIW.projectIdFromPath();
    if (!pid || baselineLoaded) return Promise.resolve();
    baselineLoaded = true;
    return new Promise(function (res) {
      try {
        chrome.storage.local.get(baselineStorageKey(pid), function (o) {
          var v = o && o[baselineStorageKey(pid)];
          if (v) {
            baseline = v;
            console.log('[帧检助手] 载入原始数据基线 ' + Object.keys(v).length + ' 帧');
          }
          res();
        });
      } catch (e) { res(); }
    });
  }
  function saveBaseline() {
    var pid = APIW.projectIdFromPath();
    if (!pid) return;
    var keys = Object.keys(baseline);
    if (keys.length > BASE_CAP) {
      keys.sort(function (a, b) { return (baseline[a].ts || 0) - (baseline[b].ts || 0); });
      keys.slice(0, keys.length - BASE_CAP).forEach(function (k) { delete baseline[k]; });
    }
    try {
      var o = {};
      o[baselineStorageKey(pid)] = baseline;
      chrome.storage.local.set(o);
    } catch (e) { }
  }
  function scheduleBaselineSave() {
    if (baselineTimer) return;
    baselineTimer = setTimeout(function () {
      baselineTimer = null;
      if (baselineDirty) { baselineDirty = false; saveBaseline(); }
    }, 1500);
  }
  // 首次看到某帧 → 存下平台原始框数据（队别/号码/位置/大小）
  function snapshotBaseline(pid, frame, task) {
    if (!pid || frame == null || !task) return;
    var key = pid + ':' + frame;
    if (baseline[key]) return; // 已有基线不覆盖（基线=最早见到的状态）
    var bs = CORE.bestSourceOf(task);
    var src = bs ? CORE.parseSource(task, bs.kind, bs.index) : null;
    if (!src) return;
    baseline[key] = {
      b: src.boxes.map(function (b) {
        return [b.rid, b.label, b.number || '', +b.x.toFixed(2), +b.y.toFixed(2), +b.w.toFixed(2), +b.h.toFixed(2)];
      }),
      ts: Date.now()
    };
    baselineDirty = true;
    scheduleBaselineSave();
  }
  function exportBaseline() {
    var pid = APIW.projectIdFromPath();
    var frames = {};
    Object.keys(baseline).forEach(function (k) {
      if (k.indexOf(pid + ':') !== 0) return;
      frames[k.slice(pid.length + 1)] = baseline[k];
    });
    var out = { project: pid, exportedAt: new Date().toISOString(), count: Object.keys(frames).length, frames: frames };
    try {
      var blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'lsfi_baseline_' + pid + '_' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      toast('基线已导出：' + Object.keys(frames).length + ' 帧');
    } catch (e) {
      toast('导出失败：' + e.message);
    }
  }

  /* ---------------- 缓存（仅内存，随页面加载失效，保证数据新鲜） ---------------- */
  var mem = new Map();
  var sess = null;
  try { if (window.chrome && chrome.storage && chrome.storage.session) sess = chrome.storage.session; } catch (e) { }

  function cacheGet(id) { return mem.has(id) ? mem.get(id) : null; }
  function cacheSet(id, t) {
    if (mem.size >= MAX_CACHE) mem.clear();
    mem.set(id, t);
    if (t && t.annotations) {
      t.annotations.forEach(function (a) { if (a.id != null) annToTask[a.id] = t.id; });
    }
  }
  function cacheDel(id) { mem.delete(id); }

  // 某帧刚被改过（10 分钟内）→ 不做任何缓存复用，一律直连平台
  function isDirty(key) {
    var ts = dirtyMap[key];
    if (!ts) return false;
    if (Date.now() - ts > 10 * 60 * 1000) { delete dirtyMap[key]; return false; }
    return true;
  }
  function markDirty(pid, frame) {
    if (pid && frame != null) dirtyMap[pid + ':' + frame] = Date.now();
  }

  /* ---------------- 单任务按需请求 ----------------
   * 取数顺序：内存缓存 → 页面列表请求自带的完整 task（taskStore）→ API。
   * 当前帧与刚改过的帧一律走 API（noCache），保证拿到平台最新数据。 */
  var reqCount = 0, hitCount = 0;
  function fetchTask(id, noCache) {
    var pid = APIW.projectIdFromPath();
    var fr = idToFrame[id];
    // 刚改过的帧强制新鲜
    if (pid && fr != null && isDirty(pid + ':' + fr)) noCache = true;
    if (!noCache) {
      var c = cacheGet(id);
      if (c) { hitCount++; return Promise.resolve(c); }
      var s = taskStore[id];
      if (s && (s.predictions || s.annotations || s.drafts)) { hitCount++; return Promise.resolve(s); }
    } else {
      cacheDel(id);
    }
    reqCount++;
    return fetch(API + '/tasks/' + id, {
      credentials: 'include',
      headers: { 'Accept': 'application/json', 'X-LSFI': '1' }
    }).then(function (r) {
      if (r.status === 404) return { __missing: true, id: id };
      if (!r.ok) return { __error: true, id: id, status: r.status };
      return r.json();
    }).then(function (t) {
      if (!t.__missing && !t.__error) {
        cacheSet(id, t);
        noteSubmitted(t);
      }
      return t;
    });
  }

  // 用 task 详情更新提交状态（annotations 非空 = 已提交）
  function noteSubmitted(task) {
    if (!task || !task.data || task.data.frame == null) return;
    var pid = APIW.projectIdFromPath();
    if (pid) submittedMap[pid + ':' + task.data.frame] = !!(task.annotations && task.annotations.length);
  }

  /* ---------------- 常驻标志（左上角，可拖拽） ---------------- */
  var badge = null;
  // 所有权机制：同一标签页里可能同时存在多个实例（更新扩展后旧脚本还活着）。
  // 规则：版本高的接管（删掉旧实例的节点），版本低的**自动退场**（清掉自己的节点并不再工作），
  // 这样不会出现"两边每秒互删 → 面板闪烁"。
  var MY_TOK = MY_VER + ':' + Date.now();
  var dead = false;
  function cmpVer(a, b) {
    var pa = String(a || '0').split('.'), pb = String(b || '0').split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = parseInt(pa[i] || '0', 10), y = parseInt(pb[i] || '0', 10);
      if (x !== y) return x - y;
    }
    return 0;
  }
  function selfDestruct() {
    if (dead) return;
    dead = true;
    try { if (host) host.remove(); } catch (e) { }
    try { if (badge) badge.remove(); } catch (e) { }
    try { if (overlaySvg) overlaySvg.remove(); } catch (e) { }
    try { if (window.__LSFI_OWNER && window.__LSFI_OWNER.tok === MY_TOK) delete window.__LSFI_OWNER; } catch (e) { }
    diagLog('检测到更新的实例已接管，本实例退场');
  }
  function enforceOwnership() {
    try {
      var w = window.__LSFI_OWNER;
      if (!w || !w.tok) { window.__LSFI_OWNER = { tok: MY_TOK, v: MY_VER }; return; }
      if (w.tok === MY_TOK) return;                       // 我就是 Owner
      if (cmpVer(MY_VER, w.v) >= 0) {
        // 我更新 → 接管：删掉旧实例的节点，把自己设为 Owner
        window.__LSFI_OWNER = { tok: MY_TOK, v: MY_VER };
        var hosts = document.querySelectorAll('#lsfi-host');
        for (var i = 0; i < hosts.length; i++) { if (hosts[i] !== host) hosts[i].remove(); }
        var badges = document.querySelectorAll('#lsfi-badge');
        for (var j = 0; j < badges.length; j++) { if (badges[j] !== badge) badges[j].remove(); }
        var ovs = document.querySelectorAll('#lsfi-overlay');
        for (var k = 0; k < ovs.length; k++) { if (ovs[k] !== overlaySvg) ovs[k].remove(); }
      } else {
        selfDestruct();                                    // 我是旧实例 → 退场
      }
    } catch (e) { }
  }

  function ensureBadge() {
    if (badge || !document.body) return;
    // 重复注入时先清掉旧标志，避免出现两个
    try { var oldB = document.getElementById('lsfi-badge'); if (oldB) oldB.remove(); } catch (e) { }
    badge = document.createElement('div');
    badge.id = 'lsfi-badge';
    setBadge('待命', null);
    var s = badge.style;
    s.position = 'fixed'; s.left = '14px'; s.top = '14px'; s.zIndex = '2147483647';
    s.background = '#101828'; s.color = '#fff';
    s.font = '12px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    s.padding = '6px 12px'; s.borderRadius = '16px'; s.cursor = 'pointer';
    s.boxShadow = '0 4px 14px rgba(16,24,40,.28)'; s.userSelect = 'none';
    s.pointerEvents = 'auto'; s.whiteSpace = 'nowrap';
    badge.title = '帧检助手：点击打开/关闭面板（也可拖动我）';
    badge.onclick = function (e) {
      if (badge._dragged) { badge._dragged = false; return; } // 拖拽后不触发点击
      // 双击标志 = 复位面板位置并重新打开（面板跑到屏幕外时的救命操作）
      if (badge._lastClick && Date.now() - badge._lastClick < 400) {
        badge._lastClick = 0;
        try { sess.remove('panelPos'); } catch (e2) { }
        if (host) { host.remove(); }
        host = null; bodyEl = null; infoEl = null; ftrEl = null; shadow = null;
        closedByUser = false;
        ensurePanel();
        loadCurrent(true);
        toast('面板位置已复位');
        return;
      }
      badge._lastClick = Date.now();
      togglePanel();
    };
    document.body.appendChild(badge);
    makeBadgeDraggable(badge);
    if (sess) {
      try {
        sess.get('badgePos', function (o) {
          if (o && o.badgePos && badge) {
            // 夹进可视区，避免"标志被记到屏幕外，看不见也点不到"
            var maxX = Math.max(0, window.innerWidth - 120);
            var maxY = Math.max(0, window.innerHeight - 40);
            var bx = Math.max(0, Math.min(Number(o.badgePos.x) || 14, maxX));
            var by = Math.max(0, Math.min(Number(o.badgePos.y) || 14, maxY));
            badge.style.left = bx + 'px'; badge.style.top = by + 'px';
            if (bx !== o.badgePos.x || by !== o.badgePos.y) {
              try { sess.set({ badgePos: { x: bx, y: by } }); } catch (e3) { }
            }
          }
        });
      } catch (e) { }
    }
    console.log('[帧检助手] 常驻标志已显示（左上角，可拖动）');
  }
  function makeBadgeDraggable(el) {
    el.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var r = el.getBoundingClientRect();
      var dx = e.clientX - r.left, dy = e.clientY - r.top, moved = false;
      function mv(ev) {
        moved = true;
        var x = Math.max(4, Math.min(window.innerWidth - 140, ev.clientX - dx));
        var y = Math.max(4, Math.min(window.innerHeight - 40, ev.clientY - dy));
        el.style.left = x + 'px'; el.style.top = y + 'px';
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        if (moved) {
          el._dragged = true;
          if (sess) {
            try { sess.set({ badgePos: { x: parseInt(el.style.left, 10) || 14, y: parseInt(el.style.top, 10) || 14 } }); } catch (e2) { }
          }
        }
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }
  function setBadge(text, ok) {
    if (!badge) return;
    // 常驻标志始终带运行中脚本的版本号 + 当前帧号（加粗），方便一眼确认在看哪帧
    badge.innerHTML = '帧检助手 ' + (MY_VER ? 'v' + MY_VER + ' · ' : '') + '<b style="font-size:13px">' + esc(text) + '</b>';
    badge.style.background = ok === false ? '#b8860b' : (ok ? '#0e8a5f' : '#101828');
  }

  /* ---------------- 面板 ---------------- */
  var host = null, shadow = null, bodyEl = null, infoEl = null, ftrEl = null;
  var collapsed = false, closedByUser = false;
  var viewerWin = null;

  var CSS = [
    '.hdr{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#101828;color:#fff;flex:none;cursor:move;user-select:none}',
    '.hdr .t{font-weight:700;font-size:13px;white-space:nowrap}',
    '.hdr .fi{font-size:12px;color:#aeb9cf;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',
    '.hdr .fi b.frameno{font-size:18px;font-weight:800;color:#fff;letter-spacing:.5px;margin-right:2px}',
    '.hdr .fi .sub{font-size:11px;color:#8fa0bd}',
    '.hdr button{background:#25324a;color:#fff;border:0;border-radius:6px;width:26px;height:24px;cursor:pointer;font-size:13px;line-height:1}',
    '.hdr button:hover{background:#32456a}',
    '.hdr .grip{color:#8fa0bd;padding:0 2px;font-size:14px;line-height:1}',
    '.jumpbar{display:flex;gap:6px;padding:8px 12px 0;flex:none;align-items:center}',
    '.jumpbar input{flex:1;min-width:0;font-size:12px;padding:4px 8px;border:1px solid #d8dee9;border-radius:6px;background:#f7f9fc;color:#1a2233}',
    '.jumpbar button{font-size:12px;padding:4px 12px;border:0;border-radius:6px;background:#2456c8;color:#fff;cursor:pointer;white-space:nowrap}',
    '.jumpbar button:disabled{background:#9db2dd;cursor:default}',
    '.jumpbar .st{font-size:11px;color:#5b6478;white-space:nowrap;max-width:90px;overflow:hidden;text-overflow:ellipsis}',
    '.body{overflow-y:auto;padding:10px 12px;flex:1}',
    '.srcbar{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}',
    '.srcbar select{flex:1;min-width:170px;font-size:12px;padding:3px 6px;border:1px solid #d8dee9;border-radius:6px;background:#f7f9fc}',
    '.srcbar button{font-size:12px;padding:3px 10px;border:1px solid #d8dee9;border-radius:6px;background:#f7f9fc;cursor:pointer;white-space:nowrap}',
    '.srcbar label{font-size:11px;color:#5b6478;white-space:nowrap;cursor:pointer}',
    '.srcbar input[type=number]{width:40px;font-size:12px;padding:1px 4px;border:1px solid #d8dee9;border-radius:4px}',
    'h4{font-size:12px;margin:12px 0 6px;padding:4px 8px;background:#eef1f7;border-radius:6px;color:#2a3550;display:flex;justify-content:space-between;gap:8px}',
    'h4 .cnt{font-weight:400;color:#5b6478;white-space:nowrap}',
    'h4.sug{background:#f3efff;color:#4c1d95}',
    'h4.motion{background:#fdf2f2;color:#8f1d1d}',
    '.subbar{display:flex;align-items:center;gap:8px;margin:0 0 6px;font-size:11px;color:#5b6478}',
    '.subbar .st{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.subbar button{font-size:11px;padding:2px 9px;border-radius:6px;border:1px solid #d8dee9;background:#f7f9fc;cursor:pointer;white-space:nowrap;color:#2456c8;border-color:#b9ccf2}',
    '.subbar button:hover{background:#eef4ff}',
    '.subbar button:disabled{color:#98a2b8;cursor:default}',
    '.ribbon{display:flex;flex-wrap:wrap;gap:3px;margin:2px 0 4px}',
    '.rb{font-size:11px;padding:1px 6px;border-radius:5px;border:1px solid #d8dee9;background:#f7f9fc;color:#5b6478;cursor:pointer;white-space:nowrap}',
    '.rb.known{color:#2456c8;border-color:#b9ccf2;background:#eef4ff}',
    '.rb.unknown{color:#98a2b8;border-style:dashed}',
    '.rb.cur{background:#101828;color:#fff;border-color:#101828;cursor:default;font-weight:700}',
    '.rb:not(.cur):hover{border-color:#2456c8;color:#2456c8}',
    '.ribbon-hint{font-size:11px;color:#8a6508;background:#fdf6e3;border:1px solid #f0e2b6;border-radius:6px;padding:4px 8px;margin:2px 0 6px}',
    'h4.machine{background:#eef4ff}h4.human{background:#eafaf2}',
    'h4.prev{background:#f6f7f9}h4.next{background:#f6f7f9}',
    'table{width:100%;border-collapse:collapse;font-size:12px;margin:2px 0 6px}',
    'th{background:#f7f9fc;text-align:left;padding:3px 6px;border:1px solid #e7ebf2;white-space:nowrap;color:#5b6478;font-weight:600}',
    'td{padding:3px 6px;border:1px solid #e7ebf2}',
    'tr.nonum td{color:#b8860b}',
    'tr.clk{cursor:pointer}',
    'tr.clk:hover td{background:#eef4ff}',
    '.sg{display:flex;align-items:flex-start;gap:8px;border:1px solid #e4e8f0;border-left-width:4px;border-radius:8px;padding:7px 9px;margin:6px 0;font-size:12px}',
    '.sg .txt{flex:1;min-width:0}',
    '.sg .why{color:#5b6478;font-size:11px;margin-top:2px}',
    '.sg .pos{color:#8a93a6;font-size:11px;margin-left:3px;white-space:nowrap}',
    '.sg .act{display:flex;flex-direction:column;gap:4px;flex:none}',
    '.sg button.loc{background:#f7f9fc;color:#2456c8;border:1px solid #b9ccf2}',
    '#batch-n{width:34px;font-size:12px;padding:3px 4px;border:1px solid #d8dee9;border-radius:6px;text-align:center}',
    '#btn-batch{background:#6d28d9;color:#fff;border-color:#6d28d9;font-weight:600}',
    '.batchbar{display:none;padding:6px 12px 8px;background:#f7f9fc;border-bottom:1px solid #e6ebf2}',
    '.bb-track{height:6px;background:#e3e9f2;border-radius:4px;overflow:hidden}',
    '.bb-fill{height:100%;width:0;background:linear-gradient(90deg,#6d28d9,#2456c8);border-radius:4px;transition:width .25s}',
    '.bb-text{font-size:12px;color:#3b4a63;margin-top:4px}',
    '.sg select.num{width:70px;font-size:13px;font-weight:600;padding:4px 6px;border:1px solid #b9ccf2;border-radius:6px;background:#fff;color:#0f172a;cursor:pointer}',
    '.sg input.num:focus{outline:2px solid #b9ccf2;border-color:#2456c8}',
    '.sg .ck{position:absolute;top:6px;left:6px;width:15px;height:15px;margin:0;cursor:pointer;accent-color:#c0392b}',
    '.sg{padding-left:26px}',
    '.sg .x{position:absolute;top:4px;right:4px;width:18px;height:18px;line-height:16px;text-align:center;border:none;border-radius:50%;background:#eef1f6;color:#7a8699;font-size:12px;cursor:pointer;padding:0}',
    '.sg .x:hover{background:#e6e9ef;color:#c0392b}',
    '.sg{position:relative}',
    '.sg button.sim{background:#fdf6e3;color:#8a6508;border:1px solid #f0e2b6}',
    '.sg button.del{background:#fdecea;color:#c0392b;border:1px solid #e6b8b3}',
    '.sg button.fill{background:#eafaf2;color:#0e8a5f;border:1px solid #b7e3cc}',
    '.sg:hover{background:#fafbfe}',
    '.mk{font-size:10px;background:#fdecea;color:#c0392b;border-radius:8px;padding:0 5px;margin-left:4px;white-space:nowrap}',
    '.sg .cf{font-size:10px;border-radius:8px;padding:0 6px;margin-left:4px;white-space:nowrap}',
    '.sg .clk{cursor:pointer}',
    '.sg .clk:hover{text-decoration:underline}',
    '.sg button{font-size:11px;padding:2px 9px;border-radius:6px;border:0;background:#2456c8;color:#fff;cursor:pointer;white-space:nowrap}',
    '.sg button:hover{background:#1a45a8}',
    '.sg button.done{background:#0e8a5f;cursor:default}',
    '.sgall{display:block;width:100%;box-sizing:border-box;font-size:14px;font-weight:700;padding:10px 14px;margin:10px 0 4px;border-radius:10px;border:1px solid #6d28d9;background:#6d28d9;color:#fff;cursor:pointer;white-space:nowrap;letter-spacing:.5px;box-shadow:0 2px 8px rgba(109,40,217,.28)}',
    '.modal{position:fixed;inset:0;background:rgba(16,24,40,.42);display:flex;align-items:center;justify-content:center;z-index:2147483646}',
    '.modal .card{width:300px;background:#fff;border-radius:14px;padding:16px 18px 14px;box-shadow:0 18px 50px rgba(16,24,40,.28);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}',
    '.modal .msg{font-size:13px;line-height:1.6;color:#1a2233;margin-bottom:14px}',
    '.modal .row{display:flex;gap:8px;justify-content:flex-end}',
    '.modal .row button{font-size:13px;padding:6px 16px;border-radius:8px;cursor:pointer;border:1px solid transparent}',
    '.modal .row .cancel{background:#f2f4f8;color:#3b4a63;border-color:#d8dee9}',
    '.modal .row .ok{background:#2456c8;color:#fff}',
    '.modal .row button:hover{filter:brightness(.96)}',
    '.sgall:hover{background:#5b21b6}',
    '.sgall:active{transform:translateY(1px)}',
    '.iss{font-size:12px;margin:4px 0;padding:5px 8px;border-radius:6px;background:#fdf6e3;color:#8a6508;border:1px solid #f0e2b6}',
    '.iss.none{background:#eafaf2;color:#0e8a5f;border-color:#c8ecd9}',
    '.diff{font-size:12px;margin:4px 0;padding:5px 8px;border-radius:6px;background:#f4f6fb;border:1px solid #e2e8f4}',
    '.diff b{color:#c8102e}',
    '.hint{font-size:12px;color:#5b6478;padding:14px 6px;text-align:center}',
    '.ftr{flex:none;font-size:11px;color:#8a93a6;padding:6px 12px;border-top:1px solid #eef1f7;display:flex;justify-content:space-between;gap:8px}',
    '.ftr button{font-size:11px;border:1px solid #d8dee9;background:#fff;border-radius:5px;padding:1px 8px;cursor:pointer;color:#5b6478}',
    '.diagwrap{flex:none;display:none;border-top:1px solid #eef1f7;padding:8px 12px;background:#f7f9fc}',
    '.diagwrap.open{display:block}',
    '.diagtools{display:flex;align-items:center;gap:8px;font-size:11px;color:#5b6478;margin-bottom:6px}',
    '.diagtools span{flex:1}',
    '.diagtools button{font-size:11px;padding:2px 9px;border-radius:6px;border:1px solid #d8dee9;background:#fff;cursor:pointer;color:#2456c8;border-color:#b9ccf2;white-space:nowrap}',
    '.diagwrap pre{font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;background:#fff;border:1px solid #e4e8f0;border-radius:6px;padding:8px;max-height:220px;overflow:auto;margin:0;font-family:ui-monospace,Menlo,Consolas,monospace}',
    '.wrap.min .body,.wrap.min .ftr,.wrap.min .jumpbar{display:none}',
    '.wrap.min{width:auto;max-height:none}'
  ].join('\n');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var SUG_META = {
    fill_number: { color: '#0e8a5f', name: '补号' },
    fix_number: { color: '#d99a06', name: '改号' },
    add_box: { color: '#7c3aed', name: '补框' },
    del_box: { color: '#c0392b', name: '删框' },
    fix_label: { color: '#0e8a5f', name: '改标签' },
    need_number: { color: '#c026d3', name: '缺号待补' }
  };
  var CONF_META = { high: ['高', '#e7f6ef', '#0e8a5f'], mid: ['中', '#fdf6e3', '#8a6508'], low: ['低·需判断', '#fdecea', '#c0392b'] };

  function ensurePanel() {
    // 关键：host 存在但已经不在文档里（被 LS 重渲染挤掉）→ 视为没开，重建
    if (host && !document.contains(host)) {
      host = null; bodyEl = null; infoEl = null; ftrEl = null; shadow = null;
    }
    if (host) return;
    closedByUser = false;
    // 重复注入时先清掉旧面板
    try { var oldH = document.getElementById('lsfi-host'); if (oldH) oldH.remove(); } catch (e) { }
    host = document.createElement('div');
    host.id = 'lsfi-host';
    shadow = host.attachShadow({ mode: 'open' });
    // 面板在 shadow DOM 里：按键事件一旦冒出去，LS 会把 target 看成面板容器（不是输入框），
    // 于是数字键被当"选中第N个区域"、Delete 被当"删除选中区域"吃掉。
    // 这里在 shadow 根上拦截：焦点在输入框时，事件不外传。
    ['keydown', 'keypress', 'keyup'].forEach(function (tp) {
      shadow.addEventListener(tp, function (e) {
        var t = e.target;
        if (!t) return;
        var tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
          e.stopPropagation();
        }
      }, true);
    });
    shadow.innerHTML =
      '<style>' + CSS + '</style>' +
      '<div class="wrap" id="wrap">' +
      '  <div class="hdr" id="hdr">' +
      '    <span class="grip" id="grip" title="按住拖动移动面板">⠿</span>' +
      '    <span class="t">帧检助手 v' + MY_VER + '</span>' +
      '    <span class="fi" id="fi">—</span>' +
      '    <button id="btn-prev" title="上一帧 (←)">◀</button>' +
      '    <button id="btn-next" title="下一帧 (→)">▶</button>' +
      '    <button id="btn-refresh" title="重新拉取本帧">⟳</button>' +
      '    <button id="btn-min" title="折叠/展开">—</button>' +
      '    <button id="btn-close" title="关闭">×</button>' +
      '  </div>' +
      '  <div class="jumpbar" id="jumpbar">' +
      '    <input id="jump-input" type="text" inputmode="numeric" placeholder="跳到帧号，如 5204" />' +
      '    <button id="jump-btn" title="跳转到指定帧">跳转</button>' +
      '    <input id="batch-n" type="text" inputmode="numeric" value="5" title="批量处理帧数（默认 5，可改 1-20）" onkeydown="event.stopPropagation()" onkeypress="event.stopPropagation()" onkeyup="event.stopPropagation()" />' +
      '    <button id="btn-batch" title="从当前帧开始连续处理 N 帧：每帧自动应用建议并前进，您只需检查">批量 5 帧</button>' +
      '    <button id="btn-batch-stop" title="停止批量处理" style="display:none;background:#c0392b;color:#fff;border-color:#c0392b">停止</button>' +
      '    <span class="st" id="jump-st"></span>' +
      '  </div>' +
      '  <div class="batchbar" id="batchbar"><div class="bb-track"><div class="bb-fill" id="bb-fill"></div></div><div class="bb-text" id="bb-text"></div></div>' +
      '  <div class="body" id="body"></div>' +
      '  <div class="diagwrap" id="diagwrap">' +
      '    <div class="diagtools"><span>诊断信息（复制后发给开发者）</span><button id="btn-copy-diag">复制</button><button id="btn-close-diag">收起</button></div>' +
      '    <pre id="diag-text"></pre>' +
      '  </div>' +
      '  <div class="modal" id="modal" style="display:none"><div class="card">' +
      '    <div class="msg" id="modal-msg"></div>' +
      '    <div class="row"><button class="cancel" id="modal-cancel">取消</button><button class="ok" id="modal-ok">确定</button></div>' +
      '  </div></div>' +
      '  <div class="ftr"><span id="ftr-stats"></span><span><button id="btn-unknowndel" title="unknown 标签框默认建议删除（凉白开机器预测的 unknown 多是垃圾框）；关闭则保留、交给与上一帧比对/改标签">unknown:默认删</button><button id="btn-delmode" title="删框建议的收敛程度：严格=只与上一帧强比对（默认，不刷屏）；宽松=再加上「所有邻帧都没有」的兜底">删框:严格</button><button id="btn-marks" title="是否在画布上画出建议框（默认关闭，画面上更干净）">画布标记:关</button><button id="btn-autoreload" title="写入平台后是否自动让画面刷新（跳一帧再跳回，不会重载页面；关掉则完全不动画面）">自动刷新:开</button><button id="btn-kbd" title="默认只认 Alt+←/→；开启后裸方向键也能翻帧">方向键翻帧:关</button><button id="btn-base" title="导出原始数据基线（框+号码+位置+大小，不含图片）">导出基线</button><button id="btn-diag" title="打开诊断信息">诊断</button><button id="btn-reanalyze" title="清掉缓存与本地修正层，从平台重新拉数据并重新分析">重新分析</button></span></div>' +
      '</div>';
    document.body.appendChild(host);

    var hs = host.style;
    hs.position = 'fixed'; hs.top = '0'; hs.left = '0'; hs.width = '100%'; hs.height = '100%';
    hs.pointerEvents = 'none'; hs.zIndex = '2147483647';
    var wrap = shadow.getElementById('wrap');
    var ws = wrap.style;
    ws.position = 'fixed'; ws.top = '70px'; ws.right = '14px'; ws.width = '400px';
    ws.maxHeight = 'calc(100vh - 100px)'; ws.background = '#fff'; ws.zIndex = '2147483647';
    ws.border = '1px solid #d8dee9'; ws.borderRadius = '12px';
    ws.display = 'flex'; ws.flexDirection = 'column'; ws.overflow = 'hidden';
    ws.pointerEvents = 'auto'; ws.boxShadow = '0 8px 30px rgba(16,24,40,.18)';
    ws.font = '13px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    ws.color = '#1a2233';

    // 上次的位置：同步应用（避免"先默认位置、再挪过去"的跳动）
    var pos0 = loadPanelPosSync();
    if (pos0) {
      var maxX0 = Math.max(0, window.innerWidth - 200);
      var maxY0 = Math.max(0, window.innerHeight - 80);
      ws.left = Math.max(0, Math.min(pos0.x, maxX0)) + 'px';
      ws.top = Math.max(0, Math.min(pos0.y, maxY0)) + 'px';
      ws.right = 'auto'; ws.bottom = 'auto';
    }

    if (sess) {
      try {
        sess.get('panelPos', function (o) {
          if (o && o.panelPos && host) {
            var w = shadow.getElementById('wrap');
            // 位置必须夹在可视区内——否则"面板开了但看不见"，看起来像打不开
            var maxX = Math.max(0, window.innerWidth - 200);
            var maxY = Math.max(0, window.innerHeight - 80);
            var x = Math.max(0, Math.min(Number(o.panelPos.x) || 0, maxX));
            var y = Math.max(0, Math.min(Number(o.panelPos.y) || 0, maxY));
            w.style.left = x + 'px'; w.style.top = y + 'px';
            w.style.right = 'auto'; w.style.bottom = 'auto';
            if (x !== o.panelPos.x || y !== o.panelPos.y) {
              try { sess.set({ panelPos: { x: x, y: y } }); } catch (e3) { }
            }
          }
        });
      } catch (e) { }
    }

    bodyEl = shadow.getElementById('body');
    infoEl = shadow.getElementById('fi');
    ftrEl = shadow.getElementById('ftr-stats');

    shadow.getElementById('btn-prev').onclick = function () { gotoFrame(-1); };
    shadow.getElementById('btn-next').onclick = function () { gotoFrame(1); };
    shadow.getElementById('btn-refresh').onclick = function () { loadCurrent(true); };
    shadow.getElementById('btn-min').onclick = function () {
      collapsed = !collapsed;
      shadow.getElementById('wrap').classList.toggle('min', collapsed);
    };
    shadow.getElementById('btn-close').onclick = function () {
      host.remove(); host = null; bodyEl = null; infoEl = null; ftrEl = null;
      closedByUser = true;
    };
    // 面板内确认框的按钮绑定（askConfirm 定义在顶层）
    shadow.getElementById('modal-ok').onclick = function () { var f = modalCb; closeModal(); if (f) f(); };
    shadow.getElementById('modal-cancel').onclick = closeModal;

    var batchBtn = shadow.getElementById('btn-batch');
    var batchStopBtn = shadow.getElementById('btn-batch-stop');
    if (batchBtn) {
      batchBtn.onclick = function () {
        var inpN = shadow.getElementById('batch-n');
        var n = parseInt((inpN && inpN.value) || '5', 10);
        if (!isFinite(n) || n < 1) n = 5;
        if (n > 20) n = 20;
        if (inpN) inpN.value = String(n);
        startBatch(n);
      };
    }
    if (batchStopBtn) {
      batchStopBtn.onclick = function () { batchStop('用户手动停止'); };
    }
    var raBtn = shadow.getElementById('btn-reanalyze');
    if (raBtn) {
      raBtn.onclick = function () {
        raBtn.disabled = true; raBtn.textContent = '分析中…';
        reanalyze();
        setTimeout(function () { raBtn.disabled = false; raBtn.textContent = '重新分析'; }, 2500);
      };
    }
    var arBtn = shadow.getElementById('btn-autoreload');
    if (arBtn) {
      arBtn.textContent = '自动刷新:' + (state.autoReload ? '开' : '关');
      arBtn.onclick = function () {
        state.autoReload = !state.autoReload;
        arBtn.textContent = '自动刷新:' + (state.autoReload ? '开' : '关');
        try { localStorage.setItem('lsfi_autoReload', state.autoReload ? '1' : '0'); } catch (e) { }
        toast(state.autoReload ? '写入后会自动刷新该帧' : '写入后不自动刷新（请自己按 F5）');
      };
    }
    var udBtn = shadow.getElementById('btn-unknowndel');
    if (udBtn) {
      udBtn.textContent = 'unknown:' + (state.unknownDel ? '默认删' : '保留');
      udBtn.onclick = function () {
        state.unknownDel = !state.unknownDel;
        udBtn.textContent = 'unknown:' + (state.unknownDel ? '默认删' : '保留');
        try { localStorage.setItem('lsfi_unknownDel', state.unknownDel ? '1' : '0'); } catch (e) { }
        toast(state.unknownDel ? 'unknown 默认删除 —— 机器预测的 unknown 框会提示删除' : 'unknown 保留 —— 交给与上一帧比对 / 改标签处理');
        loadCurrent(true);
      };
    }
    var dmBtn = shadow.getElementById('btn-delmode');
    if (dmBtn) {
      dmBtn.textContent = '删框:' + (state.delMode === 'loose' ? '宽松' : '严格');
      dmBtn.onclick = function () {
        state.delMode = (state.delMode === 'loose') ? 'strict' : 'loose';
        dmBtn.textContent = '删框:' + (state.delMode === 'loose' ? '宽松' : '严格');
        try { localStorage.setItem('lsfi_delMode', state.delMode); } catch (e) { }
        toast(state.delMode === 'loose'
          ? '删框:宽松 —— 额外提示「所有邻帧都没有」的框'
          : '删框:严格 —— 只提示与上一帧强比对得出的误检，其余您目视');
        loadCurrent(true);
      };
    }
    var kbdBtn = shadow.getElementById('btn-kbd');
    var marksBtn = shadow.getElementById('btn-marks');
    if (marksBtn) {
      marksBtn.onclick = function () {
        state.marks = !state.marks;
        marksBtn.textContent = '画布标记:' + (state.marks ? '开' : '关');
        updateOverlay(lastSuggestions);
        toast(state.marks ? '画布标记已打开（会画出建议框）' : '画布标记已关闭（画面干净）');
      };
    }
    kbdBtn.onclick = function () {
      state.kbd = !state.kbd;
      kbdBtn.textContent = '方向键翻帧:' + (state.kbd ? '开' : '关');
    };

    var baseBtn = shadow.getElementById('btn-base');
    if (baseBtn) baseBtn.onclick = exportBaseline;
    var diagBtn = shadow.getElementById('btn-diag');    var diagWrap = shadow.getElementById('diagwrap');
    diagBtn.onclick = function () {
      diagWrap.classList.toggle('open');
      if (diagWrap.classList.contains('open')) updateDiagText();
    };
    shadow.getElementById('btn-close-diag').onclick = function () { diagWrap.classList.remove('open'); };
    shadow.getElementById('btn-copy-diag').onclick = function () {
      copyText(shadow.getElementById('diag-text').textContent);
      toast('诊断信息已复制，粘贴发给开发者');
    };

    makeDraggable(wrap, shadow.getElementById('hdr'));
    wireJumpBar();
    console.log('[帧检助手] 面板已创建（抓头部或⠿手柄可拖动，双击头部复位）');
  }

  // 邻帧数据摘要（诊断用）：帧号 · 来源 · 各框号码
  function neighborInfo(pid, item) {
    if (!item || !item.task) return '-';
    var src = parseBest(frameSource(pid, item.frame, item.task));
    if (!src) return '帧 ' + item.frame + ' · 无数据';
    var bs = CORE.bestSourceOf(item.task);
    var fresh = isDirty(pid + ':' + item.frame) ? '（刚改过·已强制重拉）' : '';
    return '帧 ' + item.frame + ' · ' + (src.human ? '人工' : '机器·' + src.name) + fresh + ' · ' +
      src.boxes.map(function (b) { return b.label + '#' + (b.number || '?') + '@(' + b.cx.toFixed(0) + ',' + b.cy.toFixed(0) + ')'; }).join(' ');
  }

  function updateDiagText() {    if (!shadow) return;
    var el = shadow.getElementById('diag-text');
    if (!el) return;
    var extVer = '?';
    try { extVer = chrome.runtime.getManifest().version; } catch (e) { }
    var pid = APIW.projectIdFromPath();
    var frame = (ctx.task && ctx.task.data) ? ctx.task.data.frame : null;
    var cur = (frame != null) ? parseBest(frameSource(pid, frame, ctx.task)) : null;
    var anns = (ctx.task && ctx.task.annotations) || [];
    var lines = [
      '=== 帧检助手诊断 ' + localStamp() + ' ===',
      '脚本版本: ' + MY_VER + ' / 扩展版本: ' + extVer + (MY_VER === extVer ? '  ✓一致' : '  ✗不一致(需F5)'),
      '算法构建: ' + ((CORE && CORE.CORE_BUILD) || '缺失(旧版!)') + ' / 需要 ' + NEED_CORE_BUILD + (coreBuildOk() ? '  ✓' : '  ✗ core.js 是旧缓存，请F5'),
      '页面URL: ' + location.href,
      '当前task: ' + (ctx.id || '-') + ' / 帧号: ' + (frame == null ? '-' : frame),
      '读取来源: ' + (cur ? cur.name + (cur.human ? '（人工确认）' : '（机器）') : '-') +
        ' / 标注数: ' + anns.length +
        (anns.length ? ' / 最新更新: ' + (anns.map(function (a) { return (a.updated_at || a.created_at || '').slice(0, 16); }).sort().pop()) : ''),
      '草稿: ' + (function () {
        var ds = (ctx.task && ctx.task.drafts) || [];
        if (!ds.length) return '无';
        return ds.map(function (d) { return '#' + d.id + ' 更新于 ' + (d.updated_at || d.created_at || '').slice(5, 16); }).join('；');
      })(),
      '本帧数据指纹: ' + (cur ? cur.boxes.map(function (b) { return b.label + '#' + (b.number || '?') + '@(' + b.cx.toFixed(0) + ',' + b.cy.toFixed(0) + ',' + b.w.toFixed(0) + 'x' + b.h.toFixed(0) + ')'; }).join(' ') : '-'),
      '号码解析统计: ' + (function () {
        try {
          var bsN = CORE.bestSourceOf(ctx.task);
          if (!bsN) return '无数据源';
          var stN = CORE.parseSourceStats(ctx.task, bsN.kind, bsN.index);
          if (!stN) return '无数据源';
          return '框 ' + stN.rects + ' 个 / 其中读到号码 ' + stN.withNumber + ' 个 / 文本控件 ' + stN.texts + ' 个（来源 ' + bsN.kind + '#' + bsN.index + '）';
        } catch (eN) { return '统计失败 ' + eN.message; }
      })(),
      '上一帧数据: ' + neighborInfo(pid, ctx.win && ctx.win.prevList ? ctx.win.prevList[0] : null),
      '下一帧数据: ' + neighborInfo(pid, ctx.win && ctx.win.nextList ? ctx.win.nextList[0] : null),
      '清单登记: ' + Object.keys(taskRegistry).length + ' 条（拦截命中 ' + diag.listHits + ' 次）',
      '完整task缓存: ' + Object.keys(taskStore).length + ' / 提交状态: ' + Object.keys(submittedMap).length + ' 条',
      '本地修正层: ' + Object.keys(localFix).length + ' 帧',
      'API请求: ' + reqCount + ' 次 / 缓存命中: ' + hitCount + ' 次',
      '窗口大小: ' + state.winSize + ' 帧 / 来源: ' + (state.src || 'auto'),
      '--- 最近事件 ---'
    ].concat(diag.errors.slice(-12));
    el.textContent = lines.join('\n');
  }

  /* ---------------- 拖拽（document 级 mouse 事件） ---------------- */
  function makeDraggable(wrap, handle) {
    handle.style.cursor = 'move';
    handle.title = '按住拖动移动面板（双击复位到右下角）';
    handle.addEventListener('mousedown', function (e) {
      if (e.target && e.target.tagName === 'BUTTON') return;
      if (e.button !== 0) return;
      e.preventDefault();
      var r = wrap.getBoundingClientRect();
      var dx = e.clientX - r.left, dy = e.clientY - r.top;
      function mv(ev) {
        var x = Math.max(4, Math.min(window.innerWidth - 100, ev.clientX - dx));
        var y = Math.max(4, Math.min(window.innerHeight - 40, ev.clientY - dy));
        wrap.style.left = x + 'px'; wrap.style.top = y + 'px';
        wrap.style.right = 'auto'; wrap.style.bottom = 'auto';
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        savePanelPos(wrap);
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
    handle.addEventListener('dblclick', function () {
      wrap.style.left = ''; wrap.style.top = ''; wrap.style.bottom = '';
      wrap.style.right = '14px';
      savePanelPos(wrap);
      console.log('[帧检助手] 面板位置已复位');
    });
  }

  function savePanelPos(wrap) {
    try {
      var x = parseInt(wrap.style.left, 10), y = parseInt(wrap.style.top, 10);
      if (isFinite(x) && isFinite(y)) {
        // 同时写 localStorage（同步读取，创建面板时就能就位，不会"跳一下"）
        try { localStorage.setItem('lsfi_panelPos', JSON.stringify({ x: x, y: y })); } catch (e0) { }
        if (sess) sess.set({ panelPos: { x: x, y: y } });
      } else if (sess) {
        sess.remove('panelPos');
      }
    } catch (e) { }
  }

  // 同步读取上次的面板位置（localStorage，读不到再看 session 缓存）
  function loadPanelPosSync() {
    try {
      var raw = localStorage.getItem('lsfi_panelPos');
      if (raw) {
        var p = JSON.parse(raw);
        if (p && isFinite(p.x) && isFinite(p.y)) return p;
      }
    } catch (e) { }
    return null;
  }

  function togglePanel() {
    if (host && document.contains(host)) {
      host.remove(); host = null; bodyEl = null; infoEl = null; ftrEl = null;
      closedByUser = true;
      console.log('[帧检助手] 面板已关闭');
    } else {
      host = null; bodyEl = null; infoEl = null; ftrEl = null; shadow = null;
      ensurePanel();
      loadCurrent(true);
    }
  }

  function updateFtr() {
    if (ftrEl) ftrEl.textContent = '请求 ×' + reqCount + ' · 缓存 ×' + hitCount + ' · 窗口 ' + state.winSize + ' 帧';
  }

  /* ---------------- 画布叠加层（建议框 + 定位高亮，rAF 跟随） ---------------- */
  var overlaySvg = null, lastSuggestions = [];
  var hlList = []; // [{box, label, color, until}]

  function findTargetImg() {
    var cands = [];
    var imgs = document.images;
    for (var i = 0; i < imgs.length; i++) {
      var r = imgs[i].getBoundingClientRect();
      if (r.width > 200 && r.height > 150 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0) {
        cands.push({ img: imgs[i], area: r.width * r.height });
      }
    }
    if (!cands.length) return null;
    cands.sort(function (a, b) { return b.area - a.area; });
    return cands[0].img;
  }

  function updateOverlay(suggestions) {
    if (dead) return;
    lastSuggestions = suggestions || [];
    if (!host) return;
    // 画布标记默认关闭（不往画面上画框/文字）；只有打开时或点了「定位」才画
    if (!state.marks) {
      if (overlaySvg) while (overlaySvg.firstChild) overlaySvg.removeChild(overlaySvg.firstChild);
      if (!hlList.length) return;
    }
    if (!lastSuggestions.length && !hlList.length) {
      if (overlaySvg) { while (overlaySvg.firstChild) overlaySvg.removeChild(overlaySvg.firstChild); }
      return;
    }
    var img = findTargetImg();
    if (!img) return;
    var r = img.getBoundingClientRect();
    if (r.width < 50) return;
    if (!overlaySvg) {
      overlaySvg = document.createElementNS(SVG_NS, 'svg');
      overlaySvg.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483640;overflow:visible';
      overlaySvg.id = 'lsfi-overlay';
      document.body.appendChild(overlaySvg);
    }
    overlaySvg.style.left = r.left + 'px';
    overlaySvg.style.top = r.top + 'px';
    overlaySvg.style.width = r.width + 'px';
    overlaySvg.style.height = r.height + 'px';
    overlaySvg.setAttribute('viewBox', '0 0 100 100');
    overlaySvg.setAttribute('preserveAspectRatio', 'none');
    while (overlaySvg.firstChild) overlaySvg.removeChild(overlaySvg.firstChild);

    var ox = 7 / r.width * 100;
    var oy = -7 / r.height * 100;
    // 字号按图片实际高度换算，保证永远约 12~13px 高（不随 viewBox/缩放失真）
    var fsBox = Math.max(1.6, Math.min(3.2, 13 * 100 / Math.max(1, r.height)));
    var fsHl = Math.max(1.6, Math.min(3.0, 12 * 100 / Math.max(1, r.height)));

    (state.marks ? lastSuggestions : []).forEach(function (sg) {
      var meta = SUG_META[sg.type];
      if (!meta) return;
      var b = sg.box;
      var x = b.x + ox, y = b.y + oy;
      var label = meta.name + ' ';
      if (sg.type === 'fill_number') label += sg.number;
      else if (sg.type === 'fix_number') label += b.number + '→' + sg.number;
      else label += b.label + (b.number ? ' #' + b.number : '');

      var rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', x); rect.setAttribute('y', y);
      rect.setAttribute('width', b.w); rect.setAttribute('height', b.h);
      rect.setAttribute('fill', meta.color + '22');
      rect.setAttribute('stroke', meta.color);
      rect.setAttribute('stroke-width', '0.5');
      rect.setAttribute('stroke-dasharray', '2 1.5');
      overlaySvg.appendChild(rect);

      var txt = document.createElementNS(SVG_NS, 'text');
      txt.setAttribute('x', x);
      txt.setAttribute('y', y - 1.2);
      txt.setAttribute('fill', meta.color);
      txt.setAttribute('font-size', String(fsBox));
      txt.setAttribute('font-weight', 'bold');
      txt.setAttribute('stroke', '#ffffff');
      txt.setAttribute('stroke-width', '0.9');
      txt.setAttribute('paint-order', 'stroke');
      txt.textContent = label;
      overlaySvg.appendChild(txt);

      if (sg.type === 'del_box') {
        [[-1, -1], [1, 1], [-1, 1], [1, -1]].forEach(function (d) {
          var ln = document.createElementNS(SVG_NS, 'line');
          ln.setAttribute('x1', b.cx + d[0] * b.w * 0.35); ln.setAttribute('y1', b.cy + d[1] * b.h * 0.35);
          ln.setAttribute('x2', b.cx - d[0] * b.w * 0.35); ln.setAttribute('y2', b.cy - d[1] * b.h * 0.35);
          ln.setAttribute('stroke', meta.color); ln.setAttribute('stroke-width', '0.6');
          overlaySvg.appendChild(ln);
        });
      }
    });

    // 定位高亮：闪圈 + 十字线（支持多个）
    (hlList || []).forEach(function (h) {
      if (Date.now() >= h.until) return;
      var hb = h.box;
      var color = h.color || '#c8102e';
      var g = document.createElementNS(SVG_NS, 'g');
      var circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', hb.cx); circle.setAttribute('cy', hb.cy);
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', color);
      circle.setAttribute('stroke-width', '0.7');
      var anim = document.createElementNS(SVG_NS, 'animate');
      anim.setAttribute('attributeName', 'r');
      anim.setAttribute('values', '3.5;6.5;3.5');
      anim.setAttribute('dur', '0.9s');
      anim.setAttribute('repeatCount', 'indefinite');
      circle.appendChild(anim);
      g.appendChild(circle);
      [[-1, 0], [1, 0]].forEach(function (d) {
        var ln = document.createElementNS(SVG_NS, 'line');
        ln.setAttribute('x1', hb.cx + d[0] * 8); ln.setAttribute('y1', hb.cy);
        ln.setAttribute('x2', hb.cx + d[0] * 3); ln.setAttribute('y2', hb.cy);
        ln.setAttribute('stroke', color); ln.setAttribute('stroke-width', '0.5');
        g.appendChild(ln);
      });
      [[0, -1], [0, 1]].forEach(function (d) {
        var ln = document.createElementNS(SVG_NS, 'line');
        ln.setAttribute('x1', hb.cx); ln.setAttribute('y1', hb.cy + d[0] * 8);
        ln.setAttribute('x2', hb.cx); ln.setAttribute('y2', hb.cy + d[0] * 3);
        ln.setAttribute('stroke', color); ln.setAttribute('stroke-width', '0.5');
        g.appendChild(ln);
      });
      var ht = document.createElementNS(SVG_NS, 'text');
      ht.setAttribute('x', hb.cx + 5); ht.setAttribute('y', hb.cy - 5);
      ht.setAttribute('fill', color); ht.setAttribute('font-size', String(fsHl)); ht.setAttribute('font-weight', 'bold');
      ht.setAttribute('stroke', '#ffffff'); ht.setAttribute('stroke-width', '0.45'); ht.setAttribute('paint-order', 'stroke');
      ht.textContent = '◀ ' + h.label;
      g.appendChild(ht);
      overlaySvg.appendChild(g);
    });
    hlList = hlList.filter(function (h) { return Date.now() < h.until; });
  }

  function setHighlight(box, label, color) {
    setHighlightList([{ box: box, label: label, color: color }], 2800);
  }
  function setHighlightList(list, ttl, color) {
    var until = Date.now() + (ttl || 2800);
    (list || []).forEach(function (item) {
      if (!item || !item.box) return;
      hlList.push({ box: item.box, label: item.label || '', color: item.color || color, until: until });
    });
    if (hlList.length > 12) hlList = hlList.slice(-12);
    updateOverlay(lastSuggestions);
    (list || []).forEach(function (item) {
      if (item && item.box) console.log('[帧检助手] 画布定位：' + (item.label || '') + ' @(' + item.box.cx.toFixed(1) + ',' + item.box.cy.toFixed(1) + ')');
    });
  }

  // rAF 跟随：缩放/平移/滚动实时对齐
  var lastRectKey = '';
  function trackLoop() {
    var img = findTargetImg();
    var r = img ? img.getBoundingClientRect() : null;
    var key = r ? (r.left + ',' + r.top + ',' + r.width + ',' + r.height) : '';
    if (key !== lastRectKey) {
      lastRectKey = key;
      updateOverlay(lastSuggestions);
    } else if (hlList.length && hlList.every(function (h) { return Date.now() > h.until; })) {
      hlList = [];
      updateOverlay(lastSuggestions);
    }
    requestAnimationFrame(trackLoop);
  }
  requestAnimationFrame(trackLoop);

  /* ---------------- 状态与加载 ---------------- */
  var state = { kbd: false, src: 'auto', busy: 0, winSize: 5, marks: false, autoReload: true, delMode: 'strict', unknownDel: true };
  try { if (localStorage.getItem('lsfi_autoReload') === '0') state.autoReload = false; } catch (e) { }
  try { if (localStorage.getItem('lsfi_delMode') === 'loose') state.delMode = 'loose'; } catch (e) { }
  try { if (localStorage.getItem('lsfi_unknownDel') === '0') state.unknownDel = false; } catch (e) { }
  var ctx = { id: null, task: null, win: { prevList: [], nextList: [] }, motion: [] };

  function readUrlTask() {
    try { return new URL(location.href).searchParams.get('task'); } catch (e) { return null; }
  }

  // 当前显示的是哪一份标注（LS 的 URL 会带 annotation=<id>）
  function readUrlAnnotation() {
    try { return new URL(location.href).searchParams.get('annotation'); } catch (e) { return null; }
  }

  // 读取与写入都以"当前显示的那份标注"为准；没有就用最佳来源（最新标注 > 预测）
  function pickWorkSource(task) {
    var annId = readUrlAnnotation();
    if (annId && task && task.annotations) {
      for (var i = 0; i < task.annotations.length; i++) {
        if (String(task.annotations[i].id) === String(annId)) {
          return { kind: 'annotation', index: i, human: true };
        }
      }
    }
    return CORE.bestSourceOf(task);
  }

  function renderIdle() {
    setBadge('未选帧', null);
    lastSuggestions = []; hlList = [];
    updateOverlay([]);
    if (!host) return;
    infoEl.textContent = '未选择帧';
    bodyEl.innerHTML = '<div class="hint">在左侧列表点击任意一帧<br>这里会显示该帧的标注信息 + 前后帧对照</div>';
    updateFtr();
  }

  // 每帧取"最优来源"：本地修正（且比平台新）> 人工标注 > 机器预测
  function frameSource(pid, frame, task) {
    var key = pid + ':' + frame;
    var lf = localFix[key];
    if (lf) {
      // 平台数据（最新标注 OR 最新草稿，取更晚者）比本地修正新 → 平台优先，弃用本地层。
      // 只看 annotations[0] 会漏：用户在编辑器里改完没提交时改动落在草稿上（6129 帧教训）。
      var platTs = 0;
      if (task) {
        (task.annotations || []).forEach(function (a) {
          var t = Date.parse(a.updated_at || a.created_at || '') || 0;
          if (t > platTs) platTs = t;
        });
        (task.drafts || []).forEach(function (dr) {
          var t = Date.parse(dr.updated_at || dr.created_at || '') || 0;
          if (t > platTs) platTs = t;
        });
      }
      // 3 秒容差：插件 PATCH 平台后 localFix.ts（本地时钟）总 ≥ 平台 updated_at（服务器时钟），
      // 时钟偏差会让旧失效判断漏判 → 本地层压住平台新数据，出现"明明有号却提示缺号"（6305 帧实锤）。
      // 平台在 localFix 写入前后 3 秒内有过更新 → 一律以平台为准（本地层只在平台确实没有时兜底）。
      if (platTs && platTs > lf.ts - 3000) {
        delete localFix[key];
        saveLocalFix();
        console.log('[帧检助手] 帧 ' + frame + ' 平台数据更新，弃用本地修正层');
      } else {
        return CORE.wrapLocalResult(lf.result, '本地修正版');
      }
    }
    return task;
  }

  function bestSource(task) {
    return CORE.bestSourceOf(task);
  }

  function parseBest(task) {
    var bs = bestSource(task);
    return bs ? CORE.parseSource(task, bs.kind, bs.index) : null;
  }

  // 邻帧证据专用：只用 244 的标注/草稿（凉白开不进邻帧对比）
  function parseBestHuman(task) {
    var bs = CORE.bestHumanSourceOf(task);
    return bs ? CORE.parseSource(task, bs.kind, bs.index) : null;
  }

  // 重新分析：清掉该帧的所有缓存 + 本地修正层，强制从平台拉最新数据再分析
  function reanalyze() {
    var pid = APIW.projectIdFromPath();
    var frame = (ctx.task && ctx.task.data) ? ctx.task.data.frame : null;
    try { if (ctx.id) { cacheDel(ctx.id); delete taskStore[ctx.id]; } } catch (e) { }
    try { mem.clear(); } catch (e) { }
    if (pid && frame != null) {
      delete localFix[pid + ':' + frame];
      saveLocalFix();
    }
    diagLog('重新分析：清缓存 + 本地修正层，强制重拉');
    toast('正在从平台重新拉取数据并分析…');
    loadCurrent(true);
  }

  function loadCurrent(force) {
    if (dead) return;
    var id = readUrlTask();
    if (!id) { renderIdle(); return; }
    var pid = APIW.projectIdFromPath();
    // 面板被挤出文档 → 重置，保证能重新打开
    if (host && !document.contains(host)) {
      host = null; bodyEl = null; infoEl = null; ftrEl = null; shadow = null;
    }
    if (!closedByUser) ensurePanel();
    if (!host) { setBadge('帧 ' + id, null); return; }
    lastLoadAt = Date.now();
    console.log('[帧检助手] 载入帧 task=' + id + '（窗口 ' + state.winSize + ' 帧，当前帧+紧邻前后帧直连平台取最新）');
    diag.taskLoads++;
    diagLog('载入 task=' + id);
    infoEl.textContent = '帧载入中… task ' + id;
    var token = ++state.busy;
    // 当前帧一律强制刷新（不用缓存），保证拿到平台最新数据
    fetchTask(id, true).then(function (task) {
      if (token !== state.busy) return null;
      ctx.id = id; ctx.task = task;
      return fetchWindowFrames(task).then(function (win) {
        if (token !== state.busy) return;
        ctx.win = win;
        // 记录原始数据基线（当前帧 + 邻帧，首次见到时存）
        snapshotBaseline(pid, task && task.data ? task.data.frame : null, task);
        win.prevList.forEach(function (f) { snapshotBaseline(pid, f.frame, f.task); });
        win.nextList.forEach(function (f) { snapshotBaseline(pid, f.frame, f.task); });
        renderState(id, task, win);
        updateFtr();
        maybeResumeBatch();
        var dw = shadow.getElementById('diagwrap');
        if (dw && dw.classList.contains('open')) updateDiagText();
        var f = (task && task.data) ? task.data.frame : id;
        setBadge('帧 ' + f, true);
        scrollToFrameRow(f);
        console.log('[帧检助手] 帧 ' + f + ' 渲染完成（邻帧 ' + win.prevList.length + '/' + win.nextList.length + '）');
      });
    }).catch(function (e) {
      console.error('[帧检助手] 加载失败', e);
      diagLog('加载失败 task=' + id + '：' + e.message);
      if (host) { infoEl.textContent = '加载失败：' + e.message; }
    });
  }

  // 拉取窗口内前后各 winSize 帧。
  // 新鲜度规则：当前帧与**紧邻的前后各 1 帧**每次强制直连平台重拉（不用缓存），
  // 更远的帧（±2 起）才用缓存/页面已加载数据——保证判断依据永远是最新的。
  function fetchWindowFrames(task) {
    var pid = APIW.projectIdFromPath();
    var frame = (task && task.data) ? task.data.frame : null;
    var prevList = [], nextList = [], jobs = [];
    var hasNearest = false;
    if (frame != null && pid) {
      for (var k = 1; k <= state.winSize; k++) {
        (function (k) {
          var pId = taskRegistry[pid + ':' + (Number(frame) - k)];
          var nId = taskRegistry[pid + ':' + (Number(frame) + k)];
          var force = true; // 全窗口邻帧每次强制刷新：用户在 LS 提交后立刻翻帧，紧邻帧数据必须最新
          if (pId) { hasNearest = true; jobs.push(fetchTask(pId, force).then(function (t) { prevList.push({ frame: Number(frame) - k, task: t }); })); }
          if (nId) { hasNearest = true; jobs.push(fetchTask(nId, force).then(function (t) { nextList.push({ frame: Number(frame) + k, task: t }); })); }
        })(k);
      }
    }
    // 登记表里没有紧邻帧 → 兜底按 task id ±1 探测（强制新鲜）
    if (!hasNearest && frame != null && pid) {
      jobs.push(probeNeighbor(pid, frame, Number(ctx.id) - 1).then(function (t) {
        if (t && !t.__unrelated) prevList.push({ frame: t.data.frame, task: t });
      }));
      jobs.push(probeNeighbor(pid, frame, Number(ctx.id) + 1).then(function (t) {
        if (t && !t.__unrelated) nextList.push({ frame: t.data.frame, task: t });
      }));
    }
    return Promise.all(jobs).then(function () {
      prevList.sort(function (a, b) { return b.frame - a.frame; }); // [0] = 最近邻
      nextList.sort(function (a, b) { return a.frame - b.frame; });
      return { prevList: prevList, nextList: nextList };
    });
  }

  function probeNeighbor(pid, frame, probeId) {
    if (!probeId || probeId < 1) return Promise.resolve({ __unrelated: true });
    return fetchTask(probeId).then(function (t) {
      if (!t || t.__missing || t.__error || t.__unrelated) return { __unrelated: true };
      if (t.project != null && String(t.project) !== String(pid)) return { __unrelated: true };
      if (!t.data || Math.abs(Number(t.data.frame) - Number(frame)) !== 1) return { __unrelated: true };
      return t;
    });
  }

  function pickSources(task) {
    var out = [];
    // 凉白开（机器预测）仅作为"未提交帧的起稿参考"出现在来源里；邻帧对比仍只用 244
    (task.predictions || []).forEach(function (p, i) {
      var d = p.created_at ? p.created_at.slice(0, 16).replace('T', ' ') : '';
      out.push({
        kind: 'prediction', index: i,
        label: '机器预测 · ' + (p.model_version || 'v' + i) + (d ? ' · ' + d : '') +
          (p.score != null ? ' · ' + Math.round(p.score * 100) + '%' : '')
      });
    });
    (task.annotations || []).forEach(function (a, i) {
      // 显示 updated_at（上次提交时间），方便核对是不是最新那份
      var d = (a.updated_at || a.created_at || '').slice(0, 16).replace('T', ' ');
      out.push({
        kind: 'annotation', index: i,
        label: '人工标注 · ' + (a.created_by_username || ('#' + i)) + (d ? ' · 更新于 ' + d : '') +
          (a.was_cancelled ? ' · 已取消' : '')
      });
    });
    // 草稿（244 账号在编辑器里改过但没点 Submit 的内容）——也属于人工数据
    (task.drafts || []).forEach(function (dr, i) {
      var d = (dr.updated_at || dr.created_at || '').slice(0, 16).replace('T', ' ');
      out.push({
        kind: 'draft', index: i,
        label: '草稿 · ' + (dr.created_by_username || ('#' + i)) + (d ? ' · 存于 ' + d : '') + '（未提交）'
      });
    });
    return out;
  }

  function renderState(id, task, win) {
    if (dead) return;
    try {
      // 记住正在编辑的号码框（面板重绘后恢复，避免打字被冲掉）
      var fEl = shadow ? shadow.activeElement : null;
      var fIdx = (fEl && fEl.getAttribute) ? fEl.getAttribute('data-numfor') : null;
      var fVal = (fIdx != null && fEl) ? fEl.value : null;
      renderStateInner(id, task, win);
      if (fIdx != null) {
        var again = shadow.querySelector('[data-numfor="' + fIdx + '"]');
        if (again) { again.value = fVal; try { again.focus(); } catch (e) { } }
      }
    } catch (e) {
      console.error('[帧检助手] 渲染失败', e);
      diagLog('渲染失败：' + (e && e.message));
      try {
        ensurePanel();
        if (bodyEl) bodyEl.innerHTML = '<div class="iss">渲染出错：' + esc((e && e.message) || String(e)) +
          '<br>请点「诊断」复制详情反馈</div>';
      } catch (e2) { }
    }
  }

  /* 被用户划掉的建议（本帧内不再显示、不参与应用） */
  var dismissed = {};
  function sgKey(sg) {
    return sg.type + '|' + (sg.box && sg.box.label) + '|' + (sg.box && sg.box.number || '') + '|' +
      Math.round(sg.box && sg.box.cx) + ',' + Math.round(sg.box && sg.box.cy);
  }
  function dismissKey() {
    var pid = APIW.projectIdFromPath() || 'p';
    var f = (ctx.task && ctx.task.data) ? ctx.task.data.frame : 'x';
    return pid + ':' + f;
  }

  function renderStateInner(id, task, win) {
    if (task && task.__error) {
      console.warn('[帧检助手] task ' + id + ' HTTP ' + task.status);
      infoEl.textContent = 'task ' + id + ' 加载失败 HTTP ' + task.status;
      bodyEl.innerHTML = '<div class="hint">请求失败（HTTP ' + esc(task.status) + '）<br>若是 401：请先在本标签页登录 Label Studio</div>';
      lastSuggestions = []; updateOverlay([]);
      return;
    }
    if (task && task.__missing) {
      infoEl.textContent = 'task ' + id + ' 不存在';
      bodyEl.innerHTML = '<div class="hint">task ' + esc(id) + ' 不存在（404）</div>';
      lastSuggestions = []; updateOverlay([]);
      return;
    }
    var frame = task.data ? task.data.frame : '?';
    var pid = APIW.projectIdFromPath();
    // 头部：大号帧号 + 数据来源 + task id（帧号一眼可见）
    infoEl.innerHTML = '<b class="frameno">帧 ' + esc(frame) + '</b><span class="sub">载入中…</span>';

    var srcs = pickSources(task);
    var sel = state.src;
    if (sel === 'auto' || !srcs.some(function (s) { return s.kind + ':' + s.index === sel; })) {
      var bs = bestSource(frameSource(pid, frame, task));
      sel = bs ? bs.kind + ':' + bs.index : null;
    }
    state.src = sel;

    var cur = sel ? CORE.parseSource(task, sel.split(':')[0], Number(sel.split(':')[1])) : null;
    var curHuman = CORE.parseSource(task, 'annotation', 0);

    // ---- AI 修正建议（窗口证据 + 本地修正层）----
    // URL 指定了正在看哪份标注 → 严格读那一份（否则会读/写到另一份，导致"刷新后框还在"）
    var urlAnn = readUrlAnnotation();
    var workSrc = pickWorkSource(task);
    var curBest = urlAnn && workSrc
      ? CORE.parseSource(task, workSrc.kind, workSrc.index)
      : parseBest(frameSource(pid, frame, task));
    // 头部补上数据来源与 task id（帧号大号显示）
    var srcLabel = curBest ? (curBest.kind === 'draft' ? '草稿·未提交' : (curBest.human ? '人工标注' : '机器·' + curBest.name)) : '无数据';
    infoEl.innerHTML = '<b class="frameno">帧 ' + esc(frame) + '</b><span class="sub"> · ' + esc(srcLabel) + ' · task ' + esc(id) + '</span>' +
      (coreBuildOk() ? '' : '<span style="color:#fff;background:#c0392b;padding:1px 6px;border-radius:8px;font-weight:700;white-space:nowrap">算法文件过旧·请F5</span>');
    var prevSrcs = win.prevList.map(function (f) {
      var s = parseBestHuman(frameSource(pid, f.frame, f.task));   // 邻帧证据只用 244，凉白开不进对比
      if (s) s.frameNo = f.frame;   // 证据链要用帧号（"证据：帧6128 teamB#46@(82,43)·人工"）
      return s;
    }).filter(Boolean);
    var nextSrcs = win.nextList.map(function (f) {
      var s = parseBest(frameSource(pid, f.frame, f.task));   // 后面的帧未提交、空白 → 回退凉白开做参考
      if (s) s.frameNo = f.frame;
      return s;
    }).filter(Boolean);
    var suggestions = CORE.suggestFixesWindow(curBest, prevSrcs, nextSrcs, 6, 10, { delMode: state.delMode, unknownDel: state.unknownDel });
    // 兜底：本帧只要有缺号框，就必须有对应标记（与"缺号 N 个"提示保持一致）
    if (curBest) {
      var covered = {};
      suggestions.forEach(function (s) {
        if (s.box) covered[Math.round(s.box.cx * 10) + ',' + Math.round(s.box.cy * 10)] = 1;
      });
      curBest.boxes.forEach(function (b) {
        if (b.number) return;
        var k = Math.round(b.cx * 10) + ',' + Math.round(b.cy * 10);
        if (covered[k]) return;
        suggestions.push({ type: 'need_number', box: b, conf: 'low', reason: '本帧缺号（兜底标记）——请补号或删框' });
      });
    }
    lastSuggestions = suggestions;
    updateOverlay(suggestions);

    var hasAnnotation = !!(task.annotations && task.annotations.length);
    var hasLocal = !!(pid && localFix[pid + ':' + frame]);
    var canWrite = hasAnnotation || !!(task.predictions && task.predictions.length);

    var html = [];
    html.push('<div class="srcbar"><select id="src-sel">');
    srcs.forEach(function (s) {
      html.push('<option value="' + s.kind + ':' + s.index + '"' + (s.kind + ':' + s.index === sel ? ' selected' : '') + '>' + esc(s.label) + '</option>');
    });
    html.push('</select><button id="btn-copy">复制摘要</button>' +
      '<button id="btn-viewer" title="打开独立查看窗（加载本帧图片+虚拟绘制，可缩放）">查看窗</button>' +
      '<button id="btn-sort" title="让左侧列表改成按帧号排序（点列表的 frame 列头）">列表排序</button>' +
      '<label>窗口<input id="win-size" type="number" min="1" max="10" value="' + state.winSize + '">帧</label></div>');

    // 帧号导航条：按帧号连续排列，不依赖左列表的 task id 顺序
    html.push('<div class="ribbon-hint">左列表按 task id 排序（与帧序无关，故 5204 左右可能是 4529/4530）· 下面导航条按帧号连续，点击即跳</div>');
    html.push(continuityNote());
    html.push(frameRibbon(frame));
    html.push(submitBar(frame, task));

    if (hasLocal) html.push('<div class="iss none">✓ 本帧有本地修正版，建议与后续帧均以修正后数据为准</div>');

    html.push(suggestionsSection(suggestions, canWrite, hasAnnotation, win));

    if (!cur) {
      html.push('<div class="hint">该来源没有标注数据</div>');
    } else {
      var marks = suggestions.map(function (sg) { return { cx: sg.box.cx, cy: sg.box.cy }; });
      // 标题写清"帧号 + 数据来源"，避免把模型名（凉白开）误读成帧名
      var srcTitle = cur.human ? '人工标注' : '机器预测 · ' + cur.name;
      html.push(frameSection('machine', '当前帧 · 帧 ' + frame + ' · ' + srcTitle, cur.boxes, CORE.qcIssues(cur.boxes), marks));
      if (!cur.human) {
        if (curHuman) {
          // 有标注却在看预测 → 这是"删了还看得见"的根源，必须点明
          html.push('<div class="iss" style="background:#fdecea;border-color:#e6b8b3;color:#8f1d1d">⚠ 当前显示的是**机器预测（只读）**——预测里多出来的框永远不会消失，插件删除的是人工标注。' +
            '<br><button id="btn-to-ann" style="margin-top:4px">切到人工标注（看修正结果）</button></div>');
        } else {
          html.push('<div class="diff">本帧尚无人工标注，以上是机器预测（' + esc(cur.name) + '）的数据；提交人工标注后会自动切换为人工数据</div>');
        }
      }
    }

    // 最近邻前后帧明细
    var nearPrev = win.prevList[0], nearNext = win.nextList[0];
    if (nearPrev) {
      var pf = nearPrev.frame;
      var ps = parseBestHuman(frameSource(pid, pf, nearPrev.task));
      var cont = Math.abs(Number(pf) - Number(frame)) !== 1 ? ' ⚠帧号不连续' : '';
      html.push(frameSection('prev', '上一帧 · ' + pf + (ps ? ' · ' + ps.name : '') + cont,
        ps ? ps.boxes : [], ps ? CORE.qcIssues(ps.boxes) : []));
      if (cur && ps) html.push(diffLine(CORE.diffBoxes(cur, ps), '上一帧'));
    } else {
      html.push('<div class="diff">上一帧未定位：列表未加载到相邻帧（点相邻行或翻页）</div>');
    }
    if (nearNext) {
      var nf = nearNext.frame;
      var ns = parseBest(frameSource(pid, nf, nearNext.task));
      var cont2 = Math.abs(Number(nf) - Number(frame)) !== 1 ? ' ⚠帧号不连续' : '';
      html.push(frameSection('next', '下一帧 · ' + nf + (ns ? ' · ' + ns.name : '') + cont2,
        ns ? ns.boxes : [], ns ? CORE.qcIssues(ns.boxes) : []));
      if (cur && ns) html.push(diffLine(CORE.diffBoxes(ns, cur), '下一帧'));
    } else {
      html.push('<div class="diff">下一帧未定位：列表未加载到相邻帧（点相邻行或翻页）</div>');
    }

    // 运动连续性：当前帧 vs 上一帧同位置框的位移/大小对比（差距小=正常移动，大=异常）
    if (curBest && prevSrcs.length) {
      var motion = CORE.motionCheck(curBest, prevSrcs[0]);
      ctx.motion = motion;
      html.push(motionSection(motion));
    }
    html.push(historySection());
    bodyEl.innerHTML = html.join('');
    wirePanelEvents(id, task, suggestions, canWrite, hasAnnotation, win);
  }

  function motionSection(list) {
    var h = ['<h4 class="motion"><span>运动连续性（vs 上一帧）</span><span class="cnt">' + list.length + ' 处异常</span></h4>'];
    if (!list.length) {
      h.push('<div class="iss none">✓ 帧间框区域差距均在正常范围</div>');
      return h.join('');
    }
    list.slice(0, 12).forEach(function (m, i) {
      var color = m.level === 'jump' ? '#c0392b' : '#d99a06';
      var chip = m.level === 'jump' ? '跳变' : '偏快';
      h.push('<div class="sg" style="border-left-color:' + color + '">' +
        '<div class="txt"><span class="clk" data-motion="' + i + '" title="点击在画布上定位">' +
        esc(m.box.label + (m.box.number ? ' #' + m.box.number : '')) + '</span>' +
        '<span class="cf" style="background:' + (m.level === 'jump' ? '#fdecea' : '#fdf6e3') + ';color:' + color + '">' + chip + '</span>' +
        '<div class="why">' + esc(m.reason) + '</div></div></div>');
    });
    if (list.length > 12) h.push('<div class="hint" style="padding:4px">另有 ' + (list.length - 12) + ' 处未显示</div>');
    return h.join('');
  }

  // 帧号导航条：当前帧 ±8，按帧号连续；已登记=可直跳，未登记=点击走有界搜索
  function frameRibbon(frame) {
    var pid = APIW.projectIdFromPath();
    var h = ['<div class="ribbon" id="ribbon">'];
    for (var d = -8; d <= 8; d++) {
      var f = Number(frame) + d;
      if (f < 0) continue;
      var id = pid ? taskRegistry[pid + ':' + f] : null;
      var cls = d === 0 ? 'cur' : (id ? 'known' : 'unknown');
      var tip = d === 0 ? '当前帧' : (id ? '点击跳到帧 ' + f : '帧 ' + f + '（未登记，点击搜索跳转）');
      h.push('<span class="rb ' + cls + '" data-frame="' + f + '" title="' + tip + '">' + f + '</span>');
    }
    h.push('</div>');
    return h.join('');
  }

  // 读当前可见列表行的帧号（升序）
  function visibleFrameList() {
    var container = cachedListContainer || findListContainer();
    if (!container) return [];
    var rows = container.querySelectorAll('tr, [role="row"], li, .ant-table-row');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getBoundingClientRect().height < 8) continue;
      var leaves = rows[i].querySelectorAll('td, th, span, div, a');
      var nums = [];
      for (var j = 0; j < leaves.length; j++) {
        if (leaves[j].children.length) continue;
        var t = (leaves[j].textContent || '').trim();
        if (/^\d{1,5}$/.test(t)) nums.push(Number(t));
      }
      if (nums.length) out.push(Math.max.apply(null, nums));
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  // 左列表帧号是否连续：有超过 20 的跳号就提示（导入顺序导致，不是漏帧）
  function continuityNote() {
    var rows = visibleFrameList();
    if (rows.length < 3) return '';
    var jumps = [];
    for (var i = 1; i < rows.length; i++) {
      if (rows[i] - rows[i - 1] > 20) jumps.push(rows[i - 1] + '→' + rows[i]);
    }
    if (!jumps.length) return '';
    return '<div class="ribbon-hint" style="background:#fdecea;border-color:#e6b8b3;color:#8f1d1d">' +
      '⚠ 左列表此处帧号不连续（' + jumps.slice(0, 3).map(esc).join('、') + '）：LS 按 task id 排序，这批帧的 task id 排在别处，**不是漏帧**。想连续看可点「列表排序」按帧号排。</div>';
  }

  // 提交状态条：当前帧是否已提交 + 跳到下一个未提交帧
  function submitBar(frame, task) {
    var pid = APIW.projectIdFromPath();
    var sub = pid ? submittedMap[pid + ':' + frame] : null;
    var annCount = (task && task.annotations) ? task.annotations.length : 0;
    var subTxt = sub === true ? '<span style="color:#0e8a5f">已提交</span>' : (sub === false ? '<span style="color:#c8102e">未提交</span>' : '未知');
    // 列表说已提交、但详情里没有标注 → 说明可能是草稿或已取消，明确提示
    if (sub === true && annCount === 0) {
      subTxt += ' <span style="color:#c0392b" title="列表显示已提交，但任务详情里没有标注（可能是未提交的草稿或被取消）">(详情无标注)</span>';
    }
    var near = pid ? CORE.nextUnsubmitted(frame, frameKeyMap(pid), 1, 300) : null;
    var nearTxt = near != null ? ('下一个未提交：帧 ' + near + '（+' + (near - Number(frame)) + '）') : '附近 300 帧内都已提交';
    var hist = pid ? editHistory[pid + ':' + frame] : null;
    var revertBtn = hist
      ? '<button id="btn-revert" title="把本帧恢复到修改前的原始数据" style="color:#c0392b;border-color:#e6b8b3">↩ 退回本帧（' + hist.applied + ' 处）</button>'
      : '';
    // 编辑器界面（无任务列表）才需要手动刷新画面
    var editorBtn = findListContainer()
      ? ''
      : '<button id="btn-reload" title="重新加载页面，让 LS 画布与平台数据完全一致">刷新画面</button>';
    return '<div class="subbar"><span class="st" id="sub-st">本帧 ' + subTxt + ' · ' + esc(nearTxt) + '</span>' +
      revertBtn + editorBtn +
      '<button id="btn-next-unsub" title="跳到下一个未提交的帧（向后）">下一个未提交 ▶</button></div>';
  }

  // 修改历史区（本会话应用过的帧，可逐个退回）
  function historySection() {
    var pid = APIW.projectIdFromPath();
    var keys = Object.keys(editHistory).filter(function (k) { return k.indexOf(pid + ':') === 0; });
    if (!keys.length) return '';
    keys.sort(function (a, b) { return (editHistory[b].ts || 0) - (editHistory[a].ts || 0); });
    var h = ['<h4 style="background:#fdecea;color:#8f1d1d"><span>修改历史（本会话，可退回）</span><span class="cnt">' + keys.length + ' 帧</span></h4>'];
    keys.slice(0, 8).forEach(function (k) {
      var fr = k.slice(pid.length + 1);
      var e = editHistory[k];
      var t = e.ts ? new Date(e.ts).toTimeString().slice(0, 5) : '';
      h.push('<div class="sg" style="border-left-color:#c0392b">' +
        '<div class="txt">帧 <b>' + esc(fr) + '</b> · ' + e.applied + ' 处修改 · ' + esc(t) +
        '<div class="why">' + (e.created ? '新建标注' : '更新标注 #' + esc(e.annotationId)) + '</div></div>' +
        '<button data-revert="' + esc(fr) + '">退回</button></div>');
    });
    if (keys.length > 8) h.push('<div class="hint" style="padding:4px">另有 ' + (keys.length - 8) + ' 帧未显示</div>');
    return h.join('');
  }
  function frameKeyMap(pid) {
    var m = {};
    Object.keys(submittedMap).forEach(function (k) {
      if (k.indexOf(pid + ':') === 0) m[Number(k.slice(pid.length + 1))] = submittedMap[k];
    });
    return m;
  }

  // 跳下一个未提交：先用已知数据；未知帧有界探测（最多 25 个 task 请求）
  function gotoNextUnsubmitted(btn) {
    var pid = APIW.projectIdFromPath();
    var frame = (ctx.task && ctx.task.data) ? Number(ctx.task.data.frame) : null;
    if (frame == null || !pid) return;
    if (btn) btn.disabled = true;
    var known = frameKeyMap(pid);
    var hit = CORE.nextUnsubmitted(frame, known, 1, 300);
    if (hit != null) { jumpToFrame(String(hit), function () { }); if (btn) btn.disabled = false; return; }
    // 有界探测未知帧
    var unknowns = [];
    for (var f = frame + 1; f <= frame + 60; f++) if (known[f] === undefined) unknowns.push(f);
    var probe = unknowns.slice(0, 25);
    var i = 0;
    (function next() {
      if (i >= probe.length) {
        toast('附近未发现未提交帧（已探测 ' + probe.length + ' 帧）');
        if (btn) btn.disabled = false;
        return;
      }
      var f = probe[i++];
      fetchTask(taskRegistry[pid + ':' + f] || 0).then(function (t) {
        if (t && !t.__missing && !t.__error) noteSubmitted(t);
        var again = frameKeyMap(pid);
        var h = CORE.nextUnsubmitted(frame, again, 1, 300);
        if (h != null) { jumpToFrame(String(h), function () { }); if (btn) btn.disabled = false; return; }
        next();
      }).catch(function () { next(); });
    })();
  }

  function suggestionsSection(suggestions, canWrite, hasAnnotation, win) {
    // 过滤被用户划掉的建议（本帧不再显示、不参与应用）
    var dk0 = dismissKey();
    var dset0 = dismissed[dk0] || {};
    suggestions = suggestions.filter(function (s) { return !dset0[sgKey(s)]; });
    var h = ['<h4 class="sug"><span>AI 修正建议（前后 ' + state.winSize + ' 帧证据）</span><span class="cnt">' + suggestions.length + ' 条</span></h4>'];
    if (!coreBuildOk()) {
      h.push('<div class="iss" style="background:#c0392b;color:#fff;border-color:#c0392b">⚠ 页面缓存了旧版算法文件（core.js），解析结果不可信 —— 请按 F5 硬刷新，或到 chrome://extensions 重载本扩展后再 F5</div>');
    }
    if (!suggestions.length) {
      h.push('<div class="iss none">✓ 未发现可由前后帧确定的修正</div>');
      return h.join('');
    }
    if (!canWrite) h.push('<div class="iss">该帧没有可回写的标注数据</div>');
    suggestions.forEach(function (sg, i) {
      var meta = SUG_META[sg.type], cf = CONF_META[sg.conf] || CONF_META.mid;
      var title = meta.name + ' ';
      var labelTxt = '<b>' + esc(sg.box.label) + '</b>' +
        (sg.box.seq ? '<span style="color:#7a8699;font-weight:400">（本帧第 ' + sg.box.seq + '/' + (sg.box.seqTotal || '?') + ' 个' + esc(sg.box.label) + '）</span>' : '');
      if (sg.type === 'fill_number') title += labelTxt + ' 缺号 → <b>' + esc(sg.number) + '</b>';
      else if (sg.type === 'fix_number') title += labelTxt + ' <b>#' + esc(sg.box.number) + ' → ' + esc(sg.number) + '</b>';
      else if (sg.type === 'fix_label') title += '<b>' + esc(sg.box.label) + ' → ' + esc(sg.label) + '</b>（队别判错）';
      else if (sg.type === 'add_box') {
        var numTxt = sg.box.number ? ' #' + esc(sg.box.number) : '（号码未定）';
        title += '<b>' + esc(sg.box.label) + numTxt + '</b> 本帧缺失';
        if (sg.conf !== 'high') title += '（漏检或已退场）';
        if (!sg.box.number) {
          // 说明为什么没号：上一帧该框没号码 / 上一帧根本没匹配到
          title += sg.box.prevHadBox === false ? '·上一帧未匹配到' : '·上一帧无号';
        }
      } else {
        title += labelTxt + (sg.box.number ? ' <b>#' + esc(sg.box.number) + '</b>' : '（无号码）') + ' 疑似误检';
      }
      var pos = ' @(' + sg.box.cx.toFixed(1) + '%, ' + sg.box.cy.toFixed(1) + '%)';
      var isMarker = (sg.type === 'need_number'); // 纯提醒，无可应用内容
      if (isMarker) title = meta.name + ' <b>' + esc(sg.box.label) + (sg.box.number ? ' #' + esc(sg.box.number) : ' 无号') + '</b>';
      // 证据链：这条号码建议到底是哪一帧的哪个框投出来的——可逐条和 LS 里翻帧核对
      var evLine = '';
      if (sg.evidence && sg.evidence.length) {
        evLine = '<div class="why" style="color:#7a8699">证据：' + sg.evidence.map(function (e) {
          return '帧' + (e.frameNo != null ? e.frameNo : '?') + ' ' + esc(e.label || sg.box.label) + '#' + esc(e.num) +
            '@(' + e.cx.toFixed(0) + ',' + e.cy.toFixed(0) + ') 距' + e.d.toFixed(1) + '%' + (e.human ? '·人工' : '·机器');
        }).join('；') + '</div>';
      }
      h.push('<div class="sg" data-sgrow="' + i + '" style="border-left-color:' + meta.color + '">' +
        '<input type="checkbox" class="ck" data-ck="' + i + '" title="勾选后可一键删除这些框" />' +
        '<button class="x" data-x="' + i + '" title="划掉这条建议：本帧不再显示，也不参与应用">×</button>' +
        '<div class="txt"><span class="clk" data-hl="' + i + '" title="点击在画布上定位">' + title + '</span>' +
        '<span class="pos">' + pos + '</span>' +
        '<span class="cf" style="background:' + cf[1] + ';color:' + cf[2] + '">' + cf[0] + '</span>' +
        '<div class="why">依据：' + esc(sg.reason) + '</div>' + evLine + '</div>' +
        '<div class="act">' +
        ((sg.type === 'add_box' || sg.type === 'fill_number' || sg.type === 'fix_number' || sg.type === 'need_number')
          ? (function () {
              var def = sg.type === 'add_box' ? (sg.box.number || '')
                : (sg.type === 'need_number' ? (sg.hint || '') : (sg.number || ''));
              var opts = '<option value="">— 选号 —</option>';
              for (var n = 1; n <= 99; n++) {
                opts += '<option value="' + n + '"' + (String(n) === String(def) ? ' selected' : '') + '>' + n + '</option>';
              }
              return '<select class="num" data-numfor="' + i + '" title="选择球衣号码（默认已按参考号码选好，可改）">' + opts + '</select>';
            })()
          : '') +
        '<button class="loc" data-loc="' + i + '" title="在画布上高亮这个框（不影响数据）">定位</button>' +
        (isMarker
          ? '<select class="num" data-mop="' + i + '" title="选这一行的操作：补号（用左边的号）或删框"><option value="">— 选操作 —</option><option value="fill">补号</option><option value="del">删框</option></select>' +
            '<button data-markapply="' + i + '" title="按本行选的操作写入平台">应用</button>'
          : '<button data-sug="' + i + '">应用</button>') +
        (sg.type === 'del_box' ? '<button class="sim" data-simdel="' + i + '" title="模拟人工：点框 → 按 Delete → 点提交（实验，走 LS 自己的状态）">模拟删</button>' : '') +
        ((sg.type === 'fill_number' || sg.type === 'fix_number') ? '<button class="sim" data-simnum="' + i + '" title="模拟人工：点框 → 填号码 → 点提交（实验）">模拟改</button>' : '') +
        '</div></div>');
    });
    var applicable = suggestions.filter(function (sg) { return sg.type !== 'need_number'; }).length;
    var markerN = suggestions.filter(function (sg) { return sg.type === 'need_number'; }).length;
    if (applicable || markerN) {
      h.push('<div style="margin-top:6px;display:flex;gap:6px;align-items:stretch">' +
        (applicable ? '<button class="sgall" data-all="1" style="flex:1">全部应用（' + applicable + '）</button>' : '') +
        (markerN ? '<button class="sgall" id="btn-applyops" style="flex:1;background:#185fa5;border-color:#185fa5" title="按每行选好的操作（补号/删框）一次性全部应用">一起应用所选（0）</button>' : '') +
        '<button class="sgall" id="btn-delck" style="display:none;background:#c0392b;border-color:#c0392b">删除勾选（0）</button>' +
        '<button class="sgall" id="btn-ckall" style="background:#3b4a63;border-color:#3b4a63" title="全选/取消全选本帧所有建议">全选</button>' +
        '</div>');
    }
    if (!hasAnnotation) {
      h.push('<div class="hint" style="padding:6px">' +
        (inEditorMode()
          ? '该帧还没有人工标注：插件会在画布上按建议操作，改完点右下角 <b>Submit</b> 即保存为人工标注'
          : '该帧还没有人工标注，应用将基于机器预测新建一份标注') +
        '</div>');
    }
    return h.join('');
  }

  function wirePanelEvents(id, task, suggestions, canWrite, hasAnnotation, win) {
    var selEl = shadow.getElementById('src-sel');
    if (selEl) selEl.onchange = function () { state.src = selEl.value; loadCurrent(true); };
    var winSize = shadow.getElementById('win-size');
    if (winSize) winSize.onchange = function () {
      var v = Math.max(1, Math.min(10, parseInt(winSize.value, 10) || 5));
      state.winSize = v;
      loadCurrent(true);
    };
    var viewerBtn = shadow.getElementById('btn-viewer');
    if (viewerBtn) viewerBtn.onclick = openViewer;

    // 帧号导航条点击
    Array.prototype.forEach.call(shadow.querySelectorAll('.rb[data-frame]'), function (el) {
      el.onclick = function () {
        var f = Number(el.getAttribute('data-frame'));
        var cur = (ctx.task && ctx.task.data) ? Number(ctx.task.data.frame) : null;
        if (f === cur) return;
        var pid = APIW.projectIdFromPath();
        var id = pid ? taskRegistry[pid + ':' + f] : null;
        if (id) navigateToTask(id);
        else jumpToFrame(String(f), function (msg) { if (infoEl) infoEl.textContent = msg; });
      };
    });

    // 列表按帧号排序（点 LS 的 frame 列头）
    var sortBtn = shadow.getElementById('btn-sort');
    if (sortBtn) sortBtn.onclick = function () {
      var els = document.querySelectorAll('th, [role="columnheader"], .ant-table-cell, .lsf-table-cell');
      var clicked = false;
      for (var i = 0; i < els.length; i++) {
        var txt = (els[i].textContent || '').trim().toLowerCase();
        if (txt.indexOf('frame') === 0) { els[i].click(); clicked = true; break; }
      }
      toast(clicked ? '已点 frame 列头：列表按帧号排序（再点一次可反转）' : '未找到 frame 列头，请手动点列表头');
    };

    // 下一个未提交
    var nextUnsubBtn = shadow.getElementById('btn-next-unsub');
    if (nextUnsubBtn) nextUnsubBtn.onclick = function () { gotoNextUnsubmitted(nextUnsubBtn); };

    // 退回本帧 / 历史退回
    var revertBtn = shadow.getElementById('btn-revert');
    if (revertBtn) revertBtn.onclick = function () { revertFrame(task.data ? task.data.frame : null, revertBtn); };
    var reloadBtn = shadow.getElementById('btn-reload');
    if (reloadBtn) reloadBtn.onclick = function () {
      askConfirm('刷新页面后 LS 会重新读取平台数据，画布将与最新数据完全一致。<br>继续？', function () { location.reload(); });
    };
    Array.prototype.forEach.call(shadow.querySelectorAll('button[data-revert]'), function (btn) {
      btn.onclick = function () { revertFrame(Number(btn.getAttribute('data-revert')), btn); };
    });

    // 切到人工标注视图
    var toAnnBtn = shadow.getElementById('btn-to-ann');
    if (toAnnBtn) toAnnBtn.onclick = function () {
      var ann = (task.annotations || [])[0];
      if (!ann) { toast('该帧还没有人工标注'); return; }
      if (!switchToAnnotationView(ann.id)) toast('已经是人工标注视图');
    };

    // 缺号框：每行选操作（补号/删框）→ 行内应用，或底部「一起应用所选」批量写入
    function readMarkerOp(i) {
      var opSel = shadow.querySelector('select[data-mop="' + i + '"]');
      return { op: opSel ? String(opSel.value || '') : '', opSel: opSel };
    }
    Array.prototype.forEach.call(shadow.querySelectorAll('button[data-markapply]'), function (btn) {
      btn.onclick = function () {
        var i = btn.getAttribute('data-markapply');
        var sg = suggestions[Number(i)];
        if (!sg) return;
        var mo = readMarkerOp(i);
        if (!mo.op) { toast('请先在这一行选操作（补号 / 删框）'); if (mo.opSel) try { mo.opSel.focus(); } catch (e) { } return; }
        if (mo.op === 'fill') {
          var sel = shadow.querySelector('select.num[data-numfor="' + i + '"]');
          var num = sel ? String(sel.value || '').trim() : '';
          if (!num) { toast('补号需要先选号码'); if (sel) try { sel.focus(); } catch (e) { } return; }
          applySuggestions([{ type: 'fill_number', box: sg.box, number: num, conf: 'high', reason: '人工选号 ' + num }], btn);
        } else if (mo.op === 'del') {
          applySuggestions([{ type: 'del_box', box: sg.box, conf: 'mid', reason: '人工判定误检，删除' }], btn);
        }
      };
    });
    function refreshOpsCount() {
      var b = shadow.getElementById('btn-applyops');
      if (!b) return;
      var n = 0;
      Array.prototype.forEach.call(shadow.querySelectorAll('select[data-mop]'), function (s2) { if (s2.value) n++; });
      b.textContent = '一起应用所选（' + n + '）';
    }
    Array.prototype.forEach.call(shadow.querySelectorAll('select[data-mop]'), function (sel) {
      sel.onchange = refreshOpsCount;
    });
    var aoBtn = shadow.getElementById('btn-applyops');
    if (aoBtn) {
      aoBtn.onclick = function () {
        var list = [], missNum = 0;
        suggestions.forEach(function (sg, i) {
          if (sg.type !== 'need_number') return;
          var mo = readMarkerOp(i);
          if (!mo.op) return;
          if (mo.op === 'fill') {
            var sel = shadow.querySelector('select.num[data-numfor="' + i + '"]');
            var num = sel ? String(sel.value || '').trim() : '';
            if (!num) { missNum++; return; }
            list.push({ type: 'fill_number', box: sg.box, number: num, conf: 'high', reason: '人工选号 ' + num });
          } else if (mo.op === 'del') {
            list.push({ type: 'del_box', box: sg.box, conf: 'mid', reason: '人工判定误检，删除' });
          }
        });
        if (!list.length) {
          toast(missNum ? '有 ' + missNum + ' 行选了补号但还没选号码' : '请先在每一行选好操作（补号 / 删框）');
          return;
        }
        applySuggestions(list, aoBtn);
      };
    }

    // 模拟人工操作（实验）：模拟删 / 模拟改
    Array.prototype.forEach.call(shadow.querySelectorAll('button[data-simdel]'), function (btn) {
      btn.onclick = function () {
        var sg = suggestions[Number(btn.getAttribute('data-simdel'))];
        if (sg) simulateDelete(sg);
      };
    });
    Array.prototype.forEach.call(shadow.querySelectorAll('button[data-simnum]'), function (btn) {
      btn.onclick = function () {
        var sg = suggestions[Number(btn.getAttribute('data-simnum'))];
        if (sg && sg.number) simulateNumber(sg, sg.number);
      };
    });

    // 点击定位：建议
    Array.prototype.forEach.call(shadow.querySelectorAll('.clk[data-hl]'), function (el) {
      el.onclick = function () {
        var sg = suggestions[Number(el.getAttribute('data-hl'))];
        if (sg) setHighlight(sg.box, SUG_META[sg.type].name + ' ' + (sg.number || sg.box.label));
      };
    });
    // 「定位」按钮：应用前先看清是哪个框
    Array.prototype.forEach.call(shadow.querySelectorAll('button.loc[data-loc]'), function (btn) {
      btn.onclick = function () {
        var sg = suggestions[Number(btn.getAttribute('data-loc'))];
        if (sg) setHighlight(sg.box, SUG_META[sg.type].name + ' ' + (sg.number || sg.box.label), SUG_META[sg.type].color);
      };
    });
    // 鼠标悬停建议行 → 画布自动高亮该框（不点也能看到要动哪个）
    Array.prototype.forEach.call(shadow.querySelectorAll('.sg[data-sgrow]'), function (rowEl) {
      rowEl.onmouseenter = function () {
        var sg = suggestions[Number(rowEl.getAttribute('data-sgrow'))];
        if (sg) setHighlight(sg.box, SUG_META[sg.type].name + ' ' + (sg.number || sg.box.label), SUG_META[sg.type].color);
      };
    });
    // 点击定位：框明细行
    Array.prototype.forEach.call(shadow.querySelectorAll('tr[data-cx]'), function (tr) {
      tr.onclick = function () {
        setHighlight({
          cx: parseFloat(tr.getAttribute('data-cx')),
          cy: parseFloat(tr.getAttribute('data-cy')),
          w: 0, h: 0
        }, tr.getAttribute('data-label') || '框');
      };
    });
    // 点击定位：运动异常
    Array.prototype.forEach.call(shadow.querySelectorAll('.clk[data-motion]'), function (el) {
      el.onclick = function () {
        var m = (ctx.motion || [])[Number(el.getAttribute('data-motion'))];
        if (m) setHighlight(m.box, (m.level === 'jump' ? '跳变 ' : '偏快 ') + (m.box.label + (m.box.number ? ' #' + m.box.number : '')));
      };
    });

    var copyBtn = shadow.getElementById('btn-copy');
    if (copyBtn) copyBtn.onclick = function () {
      var pid = APIW.projectIdFromPath();
      var curBest = parseBest(frameSource(pid, task.data ? task.data.frame : null, task));
      var ctx2 = {
        taskId: id, frame: task.data ? task.data.frame : '?', curName: curBest ? curBest.name : '-',
        curBoxes: curBest ? curBest.boxes : [], qc: curBest ? CORE.qcIssues(curBest.boxes) : [],
        prevFrame: win.prevList[0] ? win.prevList[0].frame : '-',
        nextFrame: win.nextList[0] ? win.nextList[0].frame : '-',
        diffPrev: null, diffNext: null
      };
      copyText(CORE.summarize(ctx2));
      copyBtn.textContent = '已复制 ✓';
      setTimeout(function () { copyBtn.textContent = '复制摘要'; }, 1200);
    };

    // 单条应用（读该行下拉选的号码）
    function applyOne(one, btn) {
      if (!one) return;
      var idx = Number(btn.getAttribute('data-sug'));
      var inp = shadow.querySelector('[data-numfor="' + idx + '"]');
      var typed = inp ? String(inp.value).trim() : null;
      // 补框：用行内选中的号码（默认已选参考号，可改）
      if (one.type === 'add_box') {
        applySuggestions([{
          type: 'add_box', conf: one.conf, reason: one.reason,
          box: { label: one.box.label, x: one.box.x, y: one.box.y, w: one.box.w, h: one.box.h,
            cx: one.box.cx, cy: one.box.cy, number: typed == null ? (one.box.number || '') : typed }
        }], btn);
        return;
      }
      // 补号/改号：也允许改成下拉里选的号码
      if ((one.type === 'fill_number' || one.type === 'fix_number') && typed) {
        applySuggestions([{ type: one.type, box: one.box, number: typed, conf: one.conf, reason: one.reason }], btn);
        return;
      }
      applySuggestions([one], btn);
    }
    // 勾选 → 一键删除勾选的框（缺号待补的框多数就该删）
    var delCkBtn = shadow.getElementById('btn-delck');
    function refreshCk() {
      if (!delCkBtn) return;
      var n = shadow.querySelectorAll('input[data-ck]:checked').length;
      delCkBtn.style.display = n ? '' : 'none';
      delCkBtn.textContent = '删除勾选（' + n + '）';
    }
    Array.prototype.forEach.call(shadow.querySelectorAll('input[data-ck]'), function (ck) {
      ck.onchange = refreshCk;
    });
    var ckAllBtn = shadow.getElementById('btn-ckall');
    if (ckAllBtn) {
      ckAllBtn.onclick = function () {
        var all = shadow.querySelectorAll('input[data-ck]');
        var checked = shadow.querySelectorAll('input[data-ck]:checked').length;
        var want = checked < all.length;
        Array.prototype.forEach.call(all, function (ck) { ck.checked = want; });
        ckAllBtn.textContent = want ? '全不选' : '全选';
        refreshCk();
      };
    }
    if (delCkBtn) {
      delCkBtn.onclick = function () {
        var picked = [];
        Array.prototype.forEach.call(shadow.querySelectorAll('input[data-ck]'), function (ck) {
          if (!ck.checked) return;
          var one = suggestions[Number(ck.getAttribute('data-ck'))];
          if (one && one.box) picked.push({ type: 'del_box', box: one.box, conf: one.conf || 'mid', reason: '人工勾选删除' });
        });
        if (!picked.length) { toast('先勾选要删除的框'); return; }
        applySuggestions(picked, delCkBtn);
      };
    }
    // 划掉某条建议（本帧不再显示、不参与应用）
    Array.prototype.forEach.call(shadow.querySelectorAll('button[data-x]'), function (btn) {
      btn.onclick = function () {
        var one = suggestions[Number(btn.getAttribute('data-x'))];
        if (!one) return;
        var dk = dismissKey();
        if (!dismissed[dk]) dismissed[dk] = {};
        dismissed[dk][sgKey(one)] = 1;
        toast('已划掉该建议（本帧不再提示）');
        renderState(ctx.id, ctx.task, ctx.win);
      };
    });
    Array.prototype.forEach.call(shadow.querySelectorAll('button[data-sug]'), function (btn) {
      btn.onclick = function () {
        var one = suggestions[Number(btn.getAttribute('data-sug'))];
        if (!one) return;
        applyOne(one, btn);
      };
    });
    var allBtn = shadow.querySelector('button[data-all]');
    if (allBtn) allBtn.onclick = function () {
      // 「全部应用」也尊重每行输入框里的号码（默认值已填好，用户改过就用改后的）
      var list = suggestions.filter(function (s) { return s.type !== 'need_number'; }).map(function (sg, k) {
        var realIdx = suggestions.indexOf(sg);
        var inp = shadow.querySelector('[data-numfor="' + realIdx + '"]');
        var typed = inp ? String(inp.value).trim() : null;
        if (sg.type === 'add_box') {
          return { type: 'add_box', conf: sg.conf, reason: sg.reason,
            box: { label: sg.box.label, x: sg.box.x, y: sg.box.y, w: sg.box.w, h: sg.box.h,
              cx: sg.box.cx, cy: sg.box.cy, number: typed == null ? (sg.box.number || '') : typed } };
        }
        if ((sg.type === 'fill_number' || sg.type === 'fix_number') && typed) {
          return { type: sg.type, box: sg.box, number: typed, conf: sg.conf, reason: sg.reason };
        }
        return sg;
      });
      if (!list.length) { toast('没有可应用的修正（缺号标记需手动补）'); return; }
      applySuggestions(list, allBtn);
    };
  }

  /* ---------------- 模拟人工操作（实验）：点框 → Delete / 填号码 → 点提交 ----------------
   * 走 LS 自己的界面与状态，不会被编辑器草稿覆盖；但合成事件有不确定性，
   * 所以每一步都做"确认"，确认不过就放弃（绝不乱按 Delete）。 */

  // 统一的框图匹配：同时尝试"坐标已是百分比"和"像素需换算"两种解释，
  // 以及稍微放宽的容差；命中返回 rect 数组。
  function matchRegionRects(box) {
    var out = [];
    if (!box) return out;
    var rects = document.querySelectorAll('svg rect');
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (r.closest('#lsfi-overlay')) continue;
      var x = parseFloat(r.getAttribute('x')), y = parseFloat(r.getAttribute('y'));
      var w = parseFloat(r.getAttribute('width')), h = parseFloat(r.getAttribute('height'));
      if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) continue;
      var k = 100 / svgUnits(r.closest('svg'));
      // 解释 A：属性已是百分比；解释 B：属性是像素
      var cands = [
        { cx: x + w / 2, cy: y + h / 2, w: w },
        { cx: (x + w / 2) * k, cy: (y + h / 2) * k, w: w * k }
      ];
      for (var c = 0; c < cands.length; c++) {
        var q = cands[c];
        var tolC = 2.4;
        var tolW = Math.max(3, box.w * 0.7);
        if (Math.abs(q.cx - box.cx) < tolC && Math.abs(q.cy - box.cy) < tolC && Math.abs(q.w - box.w) < tolW) {
          out.push(r);
          break;
        }
      }
    }
    return out;
  }

  // 切换到某份人工标注的视图（LS 用 URL 的 annotation 参数决定显示哪份）
  function switchToAnnotationView(annId) {
    if (!annId) return false;
    try {
      var u = new URL(location.href);
      if (String(u.searchParams.get('annotation')) === String(annId)) return false;
      u.searchParams.set('annotation', String(annId));
      diagLog('切换视图到人工标注 ' + annId);
      location.href = u.toString();
      return true;
    } catch (e) { return false; }
  }

  // 在画布上按坐标找框元素：先严格，找不到就放宽容差取"最近的一个"
  function findCanvasRegion(box) {
    var c = matchRegionRects(box);
    if (c.length === 1) return c[0];
    if (c.length > 1) {
      // 多个候选 → 取中心离目标最近的那个
      var best = null, bd = 1e9;
      for (var i = 0; i < c.length; i++) {
        var r = c[i];
        var k = 100 / svgUnits(r.closest('svg'));
        var cx = (parseFloat(r.getAttribute('x')) + parseFloat(r.getAttribute('width')) / 2);
        var cy = (parseFloat(r.getAttribute('y')) + parseFloat(r.getAttribute('height')) / 2);
        var d1 = Math.abs(cx - box.cx) + Math.abs(cy - box.cy);
        var d2 = Math.abs(cx * k - box.cx) + Math.abs(cy * k - box.cy);
        var d = Math.min(d1, d2);
        if (d < bd) { bd = d; best = r; }
      }
      return best;
    }
    // 严格匹配为空 → 放宽到 5% 半径找最近的
    var rects = document.querySelectorAll('svg rect');
    var best2 = null, bd2 = 1e9;
    for (var j = 0; j < rects.length; j++) {
      var rr = rects[j];
      if (rr.closest('#lsfi-overlay')) continue;
      var x = parseFloat(rr.getAttribute('x')), y = parseFloat(rr.getAttribute('y'));
      var w = parseFloat(rr.getAttribute('width')), h = parseFloat(rr.getAttribute('height'));
      if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h) || w <= 0) continue;
      var kk = 100 / svgUnits(rr.closest('svg'));
      var ccx = x + w / 2, ccy = y + h / 2;
      var dd = Math.min(Math.abs(ccx - box.cx) + Math.abs(ccy - box.cy),
        Math.abs(ccx * kk - box.cx) + Math.abs(ccy * kk - box.cy));
      if (dd < bd2) { bd2 = dd; best2 = rr; }
    }
    return (best2 && bd2 < 5) ? best2 : null;
  }

  function dispatchClickSeq(el) {
    var types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    types.forEach(function (t) {
      try {
        var Ctor = t.indexOf('pointer') === 0 && window.PointerEvent ? window.PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(t, { bubbles: true, cancelable: true, view: window, button: 0, buttons: t === 'mousedown' || t === 'pointerdown' ? 1 : 0 }));
      } catch (e) { }
    });
  }

  // 选区是否已确认（元素或祖先带 selected 类 / aria-selected）
  function isRegionSelected(el) {
    var n = el;
    for (var i = 0; i < 7 && n; i++, n = n.parentElement) {
      var cn = n.className;
      if (cn && cn.baseVal != null) cn = cn.baseVal; // SVGAnimatedString
      if (typeof cn === 'string' && /select/i.test(cn)) return true;
      if (n.getAttribute && /true/i.test(n.getAttribute('aria-selected') || '')) return true;
    }
    return false;
  }

  // 在页面上找"删除这个区域"的按钮并点击（优先用 LS 自带的删除按钮）。
  // 安全：只在区域自身的分组 / 画布 SVG 内找；绝不点带 annotation/task/project 字样的按钮。
  function clickRegionDeleteButton(regionEl) {
    function bad(s) { return /annotation|task|project|annotations|全部|delete all/i.test(s); }
    function acc(el) {
      var cn = el.className;
      if (cn && cn.baseVal != null) cn = cn.baseVal;
      return ((el.getAttribute && (el.getAttribute('title') || '')) + ' ' +
        (el.getAttribute && (el.getAttribute('aria-label') || '')) + ' ' +
        (typeof cn === 'string' ? cn : '')).toLowerCase();
    }
    function clickIfDelete(el) {
      if (!el || el.closest('#lsfi-host')) return false;
      var s = acc(el);
      if (!/delete|删除|remove|trash/.test(s) || bad(s)) return false;
      var r = el.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) return false; // 不可见/太小
      try { el.click(); return true; } catch (e) { return false; }
    }

    // ① 区域自身分组及其近邻（LSF 会在区域标签旁挂删除图标）
    var g = regionEl.closest('g');
    if (g) {
      var near = g.querySelectorAll('[title], [aria-label], button, [role="button"]');
      for (var i = 0; i < near.length; i++) if (clickIfDelete(near[i])) return true;
      var sib = g.parentElement;
      if (sib) {
        var sibs = sib.children;
        for (var j = 0; j < sibs.length; j++) {
          var t = sibs[j];
          if (t === g) continue;
          if (clickIfDelete(t)) return true;
          var inner = t.querySelectorAll ? t.querySelectorAll('[title], [aria-label], button') : [];
          for (var k = 0; k < inner.length; k++) if (clickIfDelete(inner[k])) return true;
        }
      }
    }
    // ② 右侧区域面板里的删除按钮（通常带 trash 图标）
    var panel = regionEl.closest('svg');
    var scope = panel && panel.parentElement ? panel.parentElement : document;
    var all = scope.querySelectorAll('[title], [aria-label], button, [role="button"]');
    for (var m = 0; m < all.length; m++) if (clickIfDelete(all[m])) return true;
    return false;
  }

  function pressDelete() {
    ['keydown', 'keyup'].forEach(function (t) {
      var ev = new KeyboardEvent(t, { key: 'Delete', code: 'Delete', keyCode: 46, which: 46, bubbles: true, cancelable: true });
      try { document.activeElement && document.activeElement.dispatchEvent(ev); } catch (e) { }
      document.dispatchEvent(ev);
      window.dispatchEvent(ev);
    });
  }

  // 找并点击 LS 自己的提交/更新按钮
  function clickLsSubmit() {
    var btns = document.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || '').trim().toLowerCase();
      if (t === 'submit' || t === 'update' || t === '提交' || t === '更新' || t === 'save' || t === '保存') {
        try { btns[i].click(); return true; } catch (e) { }
      }
    }
    return false;
  }

  // 当前页面上可见的输入框（排除插件自己的面板）
  function visibleInputs() {
    var els = document.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea');
    var out = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest('#lsfi-host') || el.closest('#lsfi-overlay')) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 12 || r.height < 6) continue;
      out.push(el);
    }
    return out;
  }

  // 在右侧区域面板里找号码输入框（可见的文本框/数字框）
  function findNumberInput() {
    var els = document.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea');
    var cands = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest('#lsfi-host')) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 8) continue;
      var lab = ((el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('name') || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
      var score = /number|号码|num/.test(lab) ? 3 : 1;
      if (/search|filter|comment|search/i.test(lab)) continue;
      cands.push({ el: el, score: score });
    }
    if (!cands.length) return null;
    cands.sort(function (a, b) { return b.score - a.score; });
    return cands[0].el;
  }

  function setReactInputValue(el, value) {
    try {
      var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, String(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) { return false; }
  }

  // 填号码：优先用"点框之后新冒出来/被聚焦"的那个输入框（LS 底部弹出的号码框）
  function fillNumberAfterSelect(before, num) {
    var cand = null;
    // ① 当前聚焦的就是输入框（点框后 LS 会自动聚焦号码框）
    var ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName) && !ae.closest('#lsfi-host')) cand = ae;
    // ② 点框后新出现的输入框
    if (!cand) {
      var after = visibleInputs();
      for (var i = 0; i < after.length; i++) {
        if (before.indexOf(after[i]) < 0) { cand = after[i]; break; }
      }
    }
    // ③ 兜底：按出现顺序取第一个可见输入框
    if (!cand) cand = findNumberInput();
    if (!cand) return false;
    if (!setReactInputValue(cand, num)) return false;
    // 有些版本需要回车/失焦才提交到标注里
    try {
      cand.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      cand.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    } catch (e) { }
    return true;
  }

  // 模拟删除：点框 → 确认选中 → Delete → 点提交；任一步不成立 → 提示手动
  function simulateDelete(sg) {
    var reg = findCanvasRegion(sg.box);
    if (!reg) {
      toast('模拟删除：画布上没唯一定位到该框 → 请手动点选后按 Delete');
      diagLog('模拟删除失败（未匹配到框）');
      return;
    }
    dispatchClickSeq(reg);
    setTimeout(function () {
      if (!isRegionSelected(reg)) {
        // 选区没确认也先试试页面自带的删除按钮；再不行才回退接口
        var clicked0 = clickRegionDeleteButton(reg);
        if (clicked0) {
          diagLog('模拟删除：选区未确认，已直接点页面删除按钮');
          setTimeout(function () {
            var ok0 = clickLsSubmit();
            toast(ok0 ? '已点删除按钮并提交，请核对画面' : '已点删除按钮，但没找到提交按钮 —— 请手动点提交');
          }, 300);
          return;
        }
        toast('模拟删除：选区未确认 → 请手动点选该框后按 Delete');
        diagLog('模拟删除失败（选区未确认）');
        return;
      }
      // 优先点页面自带的删除按钮；没有才按 Delete 键
      var usedBtn = clickRegionDeleteButton(reg);
      if (!usedBtn) pressDelete();
      diagLog('模拟删除：' + (usedBtn ? '已点页面删除按钮' : '已按 Delete 键'));
      toast('已删除该框 —— 请点右下角 Update 提交');
    }, 200);
  }

  // 模拟改号：点框 → 确认选中 → 右侧号码框填值 → 点提交；失败则自动改用接口写入
  function simulateNumber(sg, num) {
    var reg = findCanvasRegion(sg.box);
    if (!reg) {
      toast('模拟改号：画布上没唯一定位到该框 → 请手动点选后改号码');
      diagLog('模拟改号失败（未匹配到框）');
      return;
    }
    var before = visibleInputs();
    dispatchClickSeq(reg);
    setTimeout(function () {
      if (!isRegionSelected(reg)) {
        toast('模拟改号：选区未确认 → 请手动点选后改号码');
        diagLog('模拟改号失败（选区未确认）');
        return;
      }
      if (!fillNumberAfterSelect(before, num)) {
        toast('模拟改号：没找到号码输入框 → 请手动修改');
        return;
      }
      diagLog('模拟改号：已输入 ' + num);
      toast('已填入号码 ' + num + ' —— 请点右下角 Update 提交');
    }, 240);
  }
  // 软刷新：点下一帧那一行、再点回本帧 → LS 自己重新拉一次该帧数据并重画
  // 不重载页面、不动列表滚动位置，也不需要点 Submit（接口写入已经保存了）
  function softRefreshFrame() {
    var frame = ctx.task && ctx.task.data ? ctx.task.data.frame : null;
    if (frame == null) return false;
    var cur = findFrameRow(frame);
    var next = findFrameRow(frame + 1);
    if (!cur || !next) {
      toast('已写入平台 ✓（列表里找不到相邻行，按 F5 才能看到画面变化）');
      diagLog('软刷新失败：找不到相邻行');
      return false;
    }
    try { next.click(); } catch (e) { }
    setTimeout(function () {
      try {
        var back = findFrameRow(frame);
        (back || cur).click();
        diagLog('软刷新：已跳帧并跳回 ' + frame);
        toast('已写入平台 ✓ 画面已刷新（未重载页面）');
      } catch (e2) { }
    }, 700);
    return true;
  }

  /* ---------------- 回写（api.js 共享） ---------------- */
  // 标注编辑器里（没有任务列表）优先"像人一样操作"：点框/删框/填号，
  // 不写接口、不刷新、不点提交——由用户自己点右下角 Update。
  // 是否处于"标注编辑器"：页面上有 更新/Update/提交/Submit 按钮就是编辑器
  // （不能靠"有没有任务列表"判断——编辑器里也有可滚动容器，会误判成数据页）
  function inEditorMode() {
    try {
      var btns = document.querySelectorAll('button, [role="button"], a');
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || '').trim().toLowerCase();
        if (t !== 'update' && t !== '更新' && t !== 'submit' && t !== '提交') continue;
        var r = btns[i].getBoundingClientRect();
        if (r.width > 10 && r.height > 10) return true;
      }
    } catch (e) { }
    return false;
  }

  function doOneSim(sg, cb) {
    var reg = findCanvasRegion(sg.box);
    if (!reg) {
      diagLog('模拟: 未定位到框 @' + sg.box.cx.toFixed(1) + '%,' + sg.box.cy.toFixed(1) + '%');
      cb(false); return;
    }
    var before = visibleInputs();   // 记下点框前已有的输入框
    dispatchClickSeq(reg);
    setTimeout(function () {
      if (sg.type === 'del_box') {
        // 只要能找到"删除按钮"，或选区被认出，就动手；两者都不成立才放弃
        var usedBtn = clickRegionDeleteButton(reg);
        var sel = isRegionSelected(reg);
        if (!usedBtn && !sel) {
          diagLog('模拟删除: 选区未确认且找不到删除按钮');
          cb(false); return;
        }
        if (!usedBtn) pressDelete();
        diagLog('模拟删除: ' + (usedBtn ? '点页面删除按钮' : '按 Delete') + (sel ? '（选区已确认）' : ''));
        cb(true);
        return;
      }
      // 补号/改号：填到"点框后底部弹出的那个号码框"里
      var okFill = fillNumberAfterSelect(before, sg.number);
      diagLog('模拟改号: ' + (okFill ? '已填入 ' + sg.number : '没找到号码输入框'));
      cb(okFill);
    }, 260);
  }

  function runSimulated(list, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '模拟中…'; }
    var i = 0, fails = 0;
    function next() {
      if (i >= list.length) {
        var okN = list.length - fails;
        toast('已在画面上改完 ' + okN + ' 处' + (fails ? '（' + fails + ' 处失败）' : '') + ' —— 请点右下角 Update 提交');
        diagLog('模拟应用完成：成功 ' + okN + '，失败 ' + fails);
        if (btn) { btn.disabled = false; btn.textContent = '应用'; }
        return;
      }
      doOneSim(list[i++], function (ok) {
        if (!ok) fails++;
        setTimeout(next, 280);
      });
    }
    next();
  }

  function applySuggestions(list, btn, onDone) {
    var task = ctx.task;
    if (!task || task.__missing || task.__error) return;
    // 缺号标记只是提醒，不参与回写
    list = (list || []).filter(function (s) { return s.type !== 'need_number'; });
    if (!list.length) { toast('缺号标记需在平台手动补号'); return; }
    // 编辑器模式：走接口写入（可靠），写完整页重载该帧，让画面立刻与平台一致
    // （合成点击在本项目这套 LS 版本上不可靠，已放弃作为主路径）
    if (inEditorMode() && list.some(function (s) { return s.type === 'del_box' || s.type === 'fill_number' || s.type === 'fix_number'; })) {
      diagLog('编辑器模式：接口写入 + 自动重载');
    }
    // 若该帧没有号码控件（没有 textarea），补号/改号写不进去，提前剔除并告知
    var needsNum = list.some(function (s) { return s.type === 'fill_number' || s.type === 'fix_number'; });
    if (needsNum) {
      var bsBase = CORE.bestSourceOf(task);
      var baseArr = bsBase ? ((bsBase.kind === 'annotation' ? task.annotations[bsBase.index] : task.predictions[bsBase.index]) || {}).result || [] : [];
      var hasText = (baseArr || []).some(function (r) { return r && r.type === 'textarea'; });
      if (!hasText) {
        toast('该帧没有号码控件，补号无法自动写入——请在平台手动补');
        list = list.filter(function (s) { return s.type !== 'fill_number' && s.type !== 'fix_number'; });
        if (!list.length) return;
      }
    }
    if (btn) { btn.disabled = true; btn.textContent = '写入中…'; }
    var pid = APIW.projectIdFromPath();
    var frame = task.data ? task.data.frame : null;
    // 首次修改该帧 → 快照原始数据（供退回）
    var histKey = pid + ':' + frame;
    if (!editHistory[histKey]) {
      var hasAnn0 = !!(task.annotations && task.annotations.length);
      var origResult = hasAnn0
        ? JSON.parse(JSON.stringify(task.annotations[0].result || []))
        : (task.predictions && task.predictions.length ? JSON.parse(JSON.stringify(task.predictions[task.predictions.length - 1].result || [])) : []);
      editHistory[histKey] = {
        orig: origResult, ts: Date.now(),
        created: !hasAnn0,
        annotationId: hasAnn0 ? task.annotations[0].id : null,
        applied: 0
      };
    }
    editHistory[histKey].applied += list.length;
    editHistory[histKey].ts = Date.now();
    saveHistory();
    console.log('[帧检助手] 应用 ' + list.length + ' 条建议到 task ' + ctx.id);
    // 记录写入前是否已有人工标注（没有的话这次会新建一份，画面可能仍显示机器预测）
    var createdNewAnn = !(task.annotations && task.annotations.length);
    // 必须把"读取建议时用的那份数据"传给写入（草稿读的写草稿，标注读的写标注），
    // 否则删框/改号会落在另一份数据上而失效（框 id 对不上）
    var bsWrite = pickWorkSource(task);
    var annIdx = (bsWrite && bsWrite.kind === 'annotation') ? bsWrite.index : 0;
    var writeIsDraft = !!(bsWrite && bsWrite.kind === 'draft' && (task.drafts || [])[bsWrite.index]);
    diagLog('写入目标: ' + (bsWrite ? bsWrite.kind + '#' + bsWrite.index : '无') +
      (writeIsDraft ? '（草稿 id=' + task.drafts[bsWrite.index].id + '，写后仍需在 LS 点 Submit）'
        : (bsWrite && bsWrite.kind === 'annotation' ? '（标注 id=' + (task.annotations[annIdx] || {}).id + '）' : '（将新建标注）')));
    APIW.applyToTask(task, list, CORE.buildCorrectedResult, null, annIdx, bsWrite).then(function (res) {
      if (!res.ok) {
        console.error('[帧检助手] 写入失败', res.status, res.body);
        diagLog('写入失败 HTTP ' + res.status);
        editHistory[histKey].applied -= list.length; // 回滚计数
        saveHistory();
        toast('写入失败 HTTP ' + res.status);
        if (onDone) { try { onDone({ ok: false, n: 0, status: res.status }); } catch (e) { } }
        if (btn) {
          btn.textContent = '✗ 失败';
          setTimeout(function () { if (btn.isConnected) { btn.disabled = false; btn.textContent = '应用'; } }, 1600);
        }
        return;
      }
      console.log('[帧检助手] 写入成功');
      // 标记该帧"刚改过"：后续任何一次读取（本帧/邻帧）都直连平台，不碰缓存
      markDirty(pid, frame);
      if (ctx.id) { delete taskStore[ctx.id]; }
      // 本地修正层：后续帧以此为准
      if (pid && frame != null) { localFix[pid + ':' + frame] = { result: res.corrected, ts: Date.now() }; saveLocalFix(); }
      // 号码唯一性：被跳过的重复号要告知用户
      var dupSkip = (res.corrected && res.corrected.__dupSkipped) || [];
      if (dupSkip.length) {
        toast('已写入 ✓ ' + list.length + ' 条修正；其中 ' + dupSkip.length +
          ' 条因"同队已有该号码"被跳过（' + dupSkip.map(function (d) { return d.box.label + '#' + d.number; }).join('、') + '）');
      } else {
        toast('已写入 ✓ ' + list.length + ' 条修正' + (writeIsDraft ? '（写入草稿，记得在 LS 里点 Submit 提交）' : ''));
      }
      if (onDone) { try { onDone({ ok: true, n: list.length }); } catch (e) { } }
      if (btn) {
        btn.textContent = '✓ 已写入';
        setTimeout(function () { if (btn.isConnected) { btn.disabled = false; btn.textContent = '应用'; } }, 1200);
      }
      // 编辑器里：写完直接重载该帧，画面立刻与平台一致（不用再点 Submit）
      // 不整页刷新（会丢滚动位置）：改为"跳下一帧再跳回来"，让 LS 自己重画该帧
      if (inEditorMode()) {
        if (state.autoReload) setTimeout(function () { softRefreshFrame(); }, 220);
        setTimeout(function () { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = '应用'; } }, 1200);
        return;
      }
      if (createdNewAnn) {
        diagLog('已新建人工标注（原帧无标注）');
        setTimeout(function () {
          toast('已新建「人工标注」✓ 画面若还显示机器预测，请点顶部人工标注标签或「刷新画面」');
        }, 1400);
      }
      if (btn) { btn.textContent = '已应用 ✓'; btn.className = 'done'; }
      // 画布上把刚应用的位置打上"✓ 已应用"绿色标记（直到 LS 预览刷新）
      setHighlightList(list.map(function (sg) { return { box: sg.box, label: '✓ 已应用' }; }), 4000, '#0e8a5f');
      try { if (viewerWin && !viewerWin.closed) viewerWin.postMessage({ type: 'lsfi-updated', task: ctx.id }, '*'); } catch (e) { }
      // 不整页刷新：失效缓存 → 重拉当前帧 → 重渲染；并尽力让 LS 预览自行刷新
      cacheDel(ctx.id);
      // 不再自动切换/刷新视图（用户要求：改完自己点 Update 提交）
      fetchTask(ctx.id, true).then(function (fresh) {
        ctx.task = fresh;
        return fetchWindowFrames(fresh);
      }).then(function (win) {
        ctx.win = win;
        renderState(ctx.id, ctx.task, win);
        // 核对删框是否真的生效（用平台原始数据核，不看本地修正层）
        var delRids = list.filter(function (s) { return s.type === 'del_box' && s.box && s.box.rid; })
          .map(function (s) { return s.box.rid; });
        var still = [];
        if (delRids.length) {
          var bsV = CORE.bestSourceOf(ctx.task);
          var raw = bsV ? CORE.parseSource(ctx.task, bsV.kind, bsV.index) : null;
          still = delRids.filter(function (rid) {
            return raw && raw.boxes.some(function (b) { return b.rid === rid; });
          });
          if (still.length) {
            console.warn('[帧检助手] 删框未生效，仍存在 rid=' + still.join(','));
            diagLog('删框未生效 rid=' + still.join(',') + '（平台仍保留，可能被编辑器草稿覆盖）');
            // 本地修正层不能再掩盖真相：去掉它，让面板如实显示平台数据
            if (pid && frame != null) { delete localFix[pid + ':' + frame]; saveLocalFix(); }
          } else {
            console.log('[帧检助手] 删框核对通过（' + delRids.length + ' 个已移除）');
            diagLog('删框核对通过 ' + delRids.length + ' 个');
          }
        }
        refreshLsPreview();
        var hid = syncCanvasAfterApply(list);
        if (still.length) {
          if (hid) renderState(ctx.id, ctx.task, ctx.win);
          toast('⚠ 平台未删除 ' + still.length + ' 个框（编辑器草稿可能覆盖）。请点「刷新画面」后重试');
          if (pid && frame != null) renderState(ctx.id, ctx.task, ctx.win); // 让建议重新出现
        } else if (delRids.length) {
          toast('已删除 ' + delRids.length + ' 个框（平台已确认 ✓）' + (hid ? '，画面已同步' : ''));
        } else if (hid) {
          toast('已在画面上移除 ' + hid + ' 个框（数据已写入平台）');
        }
      }).catch(function (e) { console.error('[帧检助手] 写后刷新失败', e); });
    }).catch(function (e) {
      console.error('[帧检助手] 写入异常', e);
      diagLog('写入异常：' + e.message);
      editHistory[histKey].applied -= list.length;
      saveHistory();
      toast('写入异常：' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = '应用'; }
    });
  }

  // 退回：把该帧恢复到修改前的原始数据（PATCH 回原 result；若是我们新建的标注则删除）
  function revertFrame(frame, btn) {
    var pid = APIW.projectIdFromPath();
    var key = pid + ':' + frame;
    var h = editHistory[key];
    if (!h) { toast('该帧没有修改记录'); return; }
    var self3 = this;
    askConfirm('确定退回帧 <b>' + frame + '</b> 到修改前的原始数据？<br>（将撤销 ' + h.applied + ' 处修改）', function () { doRevert(); });
    function doRevert() {
      if (btn) { btn.disabled = true; btn.textContent = '退回中…'; }
      var chain;
      if (h.created && h.annotationId) {
        chain = APIW.apiWrite(API + '/annotations/' + h.annotationId + '/', 'DELETE', {});
      } else if (h.annotationId) {
        chain = APIW.apiWrite(API + '/annotations/' + h.annotationId + '/', 'PATCH', { result: h.orig });
      } else {
        toast('无法退回：缺少标注信息');
        if (btn) { btn.disabled = false; btn.textContent = '退回'; }
        return;
      }
      chain.then(function (res) {
        if (!res.ok) {
          toast('退回失败 HTTP ' + res.status);
          if (btn) { btn.disabled = false; btn.textContent = '退回'; }
          return;
        }
        delete editHistory[key];
        saveHistory();
        delete localFix[key];
        saveLocalFix();
        markDirty(pid, frame);
        var taskId = (ctx.task && ctx.task.data && Number(ctx.task.data.frame) === Number(frame)) ? ctx.id : taskRegistry[pid + ':' + frame];
        if (taskId) { cacheDel(taskId); delete taskStore[taskId]; }
        toast('已退回帧 ' + frame + ' 的原始数据 ✓');
        if (btn) btn.textContent = '已退回';
        if (taskId && String(taskId) === String(ctx.id)) {
          fetchTask(ctx.id, true).then(function (fresh) {
            ctx.task = fresh;
            return fetchWindowFrames(fresh);
          }).then(function (win) {
            ctx.win = win;
            renderState(ctx.id, ctx.task, win);
            refreshLsPreview();
          }).catch(function () { });
        } else {
          renderState(ctx.id, ctx.task, ctx.win);
        }
      }).catch(function (e) {
        toast('退回异常：' + e.message);
        if (btn) { btn.disabled = false; btn.textContent = '退回'; }
      });
    }
  }


  // 尽力让 LS 自己的预览刷新（点当前帧的列表行，SPA 行为不重置页面）；失败仅提示
  // 写入后让画面与实际数据一致：
  //  数据管理页 → 点相邻行再点回来，强制 LS 重渲染；
  //  标注编辑器（没有任务列表）→ 按坐标精确隐藏已删除的框（唯一匹配才动，纯视觉同步）。
  // 坐标兼容百分比(0-100)与像素两种 SVG 空间。
  function svgUnits(svg) {
    if (!svg) return 100;
    var vb = svg.getAttribute('viewBox');
    if (vb) {
      var parts = vb.split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 10) return parts[2];
    }
    var r = svg.getBoundingClientRect();
    return r.width > 10 ? r.width : 100;
  }
  function syncCanvasAfterApply(list) {
    var dels = (list || []).filter(function (s) { return s.type === 'del_box' && s.box; });
    if (!dels.length) return 0;
    var hidden = 0;
    dels.forEach(function (s) {
      var c = matchRegionRects(s.box);
      if (c.length === 1) {
        var g = c[0].closest('g') || c[0];
        g.style.display = 'none';
        hidden++;
      } else if (c.length > 1) {
        console.warn('[帧检助手] 画布匹配到多个框（' + c.length + '），跳过隐藏以免误伤');
      }
    });
    if (hidden) console.log('[帧检助手] 画布已同步：隐藏 ' + hidden + ' 个已删除的框');
    return hidden;
  }
  // 强制 LS 重新拉取该帧数据 → 画布上多出来的框会消失、补的框会出现。
  function refreshLsPreview() {
    var frame = (ctx.task && ctx.task.data) ? ctx.task.data.frame : null;
    var row = frame != null ? findFrameRow(frame) : null;
    if (!row || !isRowUsable(row)) {
      console.log('[帧检助手] 列表行不在可视区，跳过预览刷新（数据已写入平台）');
      toast('已写入平台；预览未自动刷新，请手动点一下该行');
      return false;
    }
    var sib = row.nextElementSibling || row.previousElementSibling;
    var sibUsable = sib && isRowUsable(sib) && sib.querySelectorAll('td, [role="gridcell"]').length > 0;
    try {
      if (sibUsable) {
        sib.click();
        setTimeout(function () {
          try { row.click(); } catch (e) { }
          console.log('[帧检助手] 已强制 LS 预览重新渲染');
        }, 260);
      } else {
        row.click();
        console.log('[帧检助手] 已点击当前行（无相邻行可切换）');
      }
      return true;
    } catch (e) { return false; }
  }

  // 行是否可安全操作：可见、在列表容器内
  function isRowUsable(row) {
    try {
      if (!row || !row.getBoundingClientRect) return false;
      var r = row.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return false;
      if (r.bottom < 0 || r.top > window.innerHeight) return false;
      var container = liveListContainer();
      if (container && !container.contains(row)) return false;
      return true;
    } catch (e) { return false; }
  }

  // 取"活着"的列表容器：Submit 后 LS 会重渲染列表，缓存的容器可能已脱离文档
  // （6432/6459 帧实锤：死容器找不到行；且 findListContainer 内部会调 findFrameRow，
  //   两者互相递归会爆栈 → 必须加 findingListContainer 护栏）
  var findingListContainer = false;
  function liveListContainer() {
    var c = cachedListContainer;
    if (c && c.isConnected) return c;
    cachedListContainer = null;
    if (!findingListContainer) {
      findingListContainer = true;
      try { c = findListContainer(); } catch (e) { c = null; } finally { findingListContainer = false; }
    }
    if (c && c.isConnected) { cachedListContainer = c; return c; }
    return null;
  }

  // 在左侧列表里找文本恰好等于帧号的单元格所在行（只在列表容器内找，避免点错）
  function findFrameRow(frame) {
    try {
      var container = liveListContainer();
      var scope = container || document;
      var els = scope.querySelectorAll('td, th, span, div, a, li');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.children.length) continue;
        if (el.textContent.trim() !== String(frame)) continue;
        var row = el.closest('tr, [role="row"], li, .ant-table-row');
        if (row) return row;
      }
    } catch (e) { }
    return null;
  }

  // 把左侧列表滚动到当前帧并高亮——**仅当该行不在视口内时才滚**，不跟用户的手动滚动打架
  function scrollToFrameRow(frame) {
    var row = findFrameRow(frame);
    if (!row) return false;
    try {
      var container = liveListContainer();
      var rr = row.getBoundingClientRect();
      var cr = container ? container.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      var inView = rr.top >= cr.top - 5 && rr.bottom <= cr.bottom + 5;
      if (inView) return true; // 已在视口，不动
      row.scrollIntoView({ block: 'center' });
      var old = row.style.outline;
      row.style.outline = '2px solid #c8102e';
      row.style.outlineOffset = '-2px';
      setTimeout(function () { row.style.outline = old; row.style.outlineOffset = ''; }, 1800);
      return true;
    } catch (e) { return false; }
  }

  /* 面板内确认框（替代原生 confirm，供各处调用） */
  var modalCb = null;
  function askConfirm(msg, onOk) {
    if (!shadow) { if (window.confirm(msg)) onOk(); return; }
    var m = shadow.getElementById('modal');
    var t = shadow.getElementById('modal-msg');
    if (!m || !t) { if (window.confirm(msg)) onOk(); return; }
    t.innerHTML = msg;
    m.style.display = 'flex';
    modalCb = onOk;
  }
  function closeModal() {
    if (shadow) {
      var m = shadow.getElementById('modal');
      if (m) m.style.display = 'none';
    }
    modalCb = null;
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#0e8a5f;color:#fff;' +
      'font:12px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:7px 14px;border-radius:8px;' +
      'z-index:2147483647;box-shadow:0 4px 14px rgba(16,24,40,.25);pointer-events:none';
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
  }

  /* ---------------- 独立查看窗 ---------------- */
  function openViewer() {
    var pid = APIW.projectIdFromPath();
    if (!ctx.id) { toast('先选中一帧'); return; }
    var url = chrome.runtime.getURL('viewer.html') +
      '?task=' + encodeURIComponent(ctx.id) + '&pid=' + (pid || '') + '&win=' + state.winSize;
    if (viewerWin && !viewerWin.closed) {
      viewerWin.location.href = url;
      viewerWin.focus();
    } else {
      viewerWin = window.open(url, 'lsfi-viewer', 'width=1180,height=860');
    }
    console.log('[帧检助手] 打开独立查看窗 task=' + ctx.id);
  }

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'lsfi-updated') {
      console.log('[帧检助手] 查看窗通知已更新，刷新当前帧');
      loadCurrent(true);
    }
  });

  function frameSection(cls, title, boxes, issues, marks) {
    var h = ['<h4 class="' + cls + '"><span>' + esc(title) + '</span><span class="cnt">' + boxes.length + ' 框 · ' + esc(CORE.labelCounts(boxes)) + '</span></h4>'];
    if (issues && issues.length) {
      h.push('<div class="iss">⚠ ' + issues.map(esc).join('<br>⚠ ') + '</div>');
    } else if (boxes.length) {
      h.push('<div class="iss none">✓ 无常规质检提示</div>');
    }
    if (boxes.length) {
      h.push('<table><tr><th>#</th><th>队别</th><th>号码</th><th>中心(x%,y%)</th><th>宽×高</th></tr>');
      boxes.forEach(function (b, i) {
        // 有待处理建议的框打标（按位置匹配，容差 0.8%）
        var mk = '';
        if (marks && marks.length) {
          var hit = marks.some(function (m) {
            return Math.abs(m.cx - b.cx) < 0.8 && Math.abs(m.cy - b.cy) < 0.8;
          });
          if (hit) mk = '<span class="mk">待处理</span>';
        }
        h.push('<tr class="clk" data-cx="' + b.cx + '" data-cy="' + b.cy + '" data-label="' + esc(b.label + (b.number ? ' #' + b.number : '')) + '" title="点击在画布上定位">' +
          '<td>' + (i + 1) + '</td><td>' + esc(b.label) + mk + '</td><td>' +
          (b.number ? esc(b.number) : '缺号') + '</td><td>' + b.cx.toFixed(1) + ', ' + b.cy.toFixed(1) +
          '</td><td>' + b.w.toFixed(1) + '×' + b.h.toFixed(1) + '</td></tr>');
      });
      h.push('</table>');
    }
    return h.join('');
  }

  function diffLine(d, who) {
    if (!d) return '';
    var parts = [];
    if (d.gone.length) parts.push(who + '有、当前无 <b>' + d.gone.length + '</b>：' + d.gone.map(function (b) { return esc(CORE.fmtBox(b)); }).join('；'));
    if (d.appeared.length) parts.push('当前有、' + who + '无 <b>' + d.appeared.length + '</b>：' + d.appeared.map(function (b) { return esc(CORE.fmtBox(b)); }).join('；'));
    if (d.numChanged.length) parts.push('号码变化 <b>' + d.numChanged.length + '</b>：' + d.numChanged.map(function (r) {
      return esc(r.prev.label + ' ' + r.prev.number + '→' + (r.cur.number || '空'));
    }).join('；'));
    if (!parts.length) return '<div class="diff">与' + who + '对比：无差异</div>';
    return '<div class="diff"><b>与' + who + '对比：</b>' + parts.join('<br>') + '</div>';
  }

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(function () { fallbackCopy(t); });
    } else fallbackCopy(t);
  }
  function fallbackCopy(t) {
    var ta = document.createElement('textarea');
    ta.value = t; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { }
    ta.remove();
  }

  /* ---------------- 跳到指定帧 ---------------- */
  function wireJumpBar() {
    var input = shadow.getElementById('jump-input');
    var btn = shadow.getElementById('jump-btn');
    var st = shadow.getElementById('jump-st');
    function doJump() {
      var v = (input.value || '').trim();
      if (!v) { st.textContent = '输入帧号'; return; }
      btn.disabled = true;
      jumpToFrame(v, function (msg) { st.textContent = msg; });
    }
    btn.onclick = doJump;
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doJump(); }
      e.stopPropagation();
    });
  }

  // 跳转 = 模仿用户点击列表行（SPA，只加载中间面板，不刷新整页）。
  // 保守原则：行不可见就大跨距拽几次找；仍找不到**只提示，绝不整页跳转/刷新**
  function navigateToTask(id, onStatus) {
    var frame = idToFrame[id];
    var row = frame != null ? findFrameRow(frame) : null;
    if (row && isRowUsable(row)) {
      try { row.click(); if (onStatus) onStatus('已跳转'); return Promise.resolve(true); } catch (e) { }
    }
    if (onStatus) onStatus('查找列表行…');
    return scrollSearchRow(frame, onStatus).then(function (found) {
      if (found && isRowUsable(found)) {
        try {
          found.click();
          if (onStatus) onStatus('已跳转');
          return true;
        } catch (e) { }
      }
      // 找不到就停手；但如果当前没选中任何帧（无状态可丢），直接整页跳转保证到位
      if (onStatus) onStatus('未找到行');
      if (!ctx.id) {
        var u = new URL(location.href);
        u.searchParams.set('task', String(id));
        toast('已跳转到帧 ' + (frame != null ? frame : id) + '（整页加载）');
        location.href = u.toString();
        return false;
      }
      toast('没找到帧 ' + (frame != null ? frame : id) + '：列表可能还没加载到那里，往下滚一点再点「跳转」');
      return false;
    });
  }

  // 读当前可见列表行的帧号范围（用于判断该往上拽还是往下拽）
  function visibleFrameBounds() {
    var container = findListContainer();
    if (!container) return null;
    var rows = container.querySelectorAll('tr, [role="row"], li, .ant-table-row');
    var nums = [];
    for (var i = 0; i < rows.length; i++) {
      var leaves = rows[i].querySelectorAll('td, th, span, div, a');
      var rowNums = [];
      for (var j = 0; j < leaves.length; j++) {
        if (leaves[j].children.length) continue;
        var t = (leaves[j].textContent || '').trim();
        if (/^\d{1,5}$/.test(t)) rowNums.push(Number(t));
      }
      if (rowNums.length) nums.push(Math.max.apply(null, rowNums));
    }
    if (!nums.length) return null;
    return { min: Math.min.apply(null, nums), max: Math.max.apply(null, nums) };
  }

  // 大跨距查找目标帧的行（快版）：
  //  每次滚完立刻读"可见行的帧号范围 + 行高"，算出还差多少行、一次滚到位；
  //  目标帧一进入可见范围就停下、等它渲染出来、点击。
  //  滚过头会自动反向并缩小步长；用户滚轮/按下列表则立即暂停。
  function scrollSearchRow(frame, onStatus) {
    return new Promise(function (resolve) {
      if (frame == null) { resolve(null); return; }
      var container = findListContainer();
      if (!container) { resolve(null); return; }
      var aborted = false, iter = 0, MAX = 50, stuck = 0;
      var deadline = Date.now() + 90000;

      function onUser() { aborted = true; }
      container.addEventListener('wheel', onUser, { passive: true });
      container.addEventListener('pointerdown', onUser, { passive: true });
      function finish(v) {
        container.removeEventListener('wheel', onUser);
        container.removeEventListener('pointerdown', onUser);
        resolve(v);
      }

      // 读可见行：帧号 + 行高
      function rowInfo() {
        var rows = container.querySelectorAll('tr, [role="row"], li, .ant-table-row');
        var out = [];
        for (var i = 0; i < rows.length; i++) {
          var rr = rows[i].getBoundingClientRect();
          if (rr.height < 8) continue;
          var leaves = rows[i].querySelectorAll('td, th, span, div, a');
          var nums = [];
          for (var j = 0; j < leaves.length; j++) {
            if (leaves[j].children.length) continue;
            var t = (leaves[j].textContent || '').trim();
            if (/^\d{1,5}$/.test(t)) nums.push(Number(t));
          }
          if (nums.length) out.push({ f: Math.max.apply(null, nums), h: rr.height });
        }
        return out;
      }

      // 目标行还没渲染时，轮询等它出现（列表慢加载，最多等 1 秒）
      function waitRow(cb) {
        var t0 = Date.now();
        (function poll() {
          var r = findFrameRow(frame);
          if (r) return cb(r);
          if (Date.now() - t0 > 1000) return cb(null);
          setTimeout(poll, 60);
        })();
      }

      function step() {
        if (aborted) { toast('已暂停查找（你已手动接管滚动）'); finish(null); return; }
        var row = findFrameRow(frame);
        if (row) { finish(row); return; }
        if (iter++ >= MAX || Date.now() > deadline) { finish(null); return; }

        var info = rowInfo();
        if (info.length < 2) {
          container.scrollTop += container.clientHeight * 2;
          setTimeout(step, 800);   // 列表慢加载：滚完等一拍再继续
          return;
        }
        var first = info[0], last = info[info.length - 1];
        var avgH = 0;
        for (var i = 0; i < info.length; i++) avgH += info[i].h;
        avgH = Math.max(8, avgH / info.length);

        var orderSign = (last.f - first.f) >= 0 ? 1 : -1; // 向下滚帧号是否变大
        var frPerRow = Math.abs((last.f - first.f) / (info.length - 1)) || 1;
        var lo = Math.min(first.f, last.f), hi = Math.max(first.f, last.f);

        // 目标进入可见范围 → 停下等渲染后点它
        if (frame >= lo && frame <= hi) {
          waitRow(function (r) {
            if (r) { finish(r); return; }
            // 渲染还没跟上：按帧差微调一小步
            var d = (frame > hi ? 1 : -1) * orderSign;
            container.scrollTop += d * avgH;
            setTimeout(step, 300);
          });
          return;
        }

        // 步幅自适应：近目标小步细腻，远目标大步赶路（慢加载，每步后已等待 700ms）
        var gapFrames = frame > hi ? (frame - hi) : (lo - frame);
        var rowsMove = gapFrames / frPerRow;
        var stepVp = rowsMove > 80 ? 12 : (rowsMove > 30 ? 6 : 3);   // 视口倍数
        var px = Math.min(container.clientHeight * stepVp, rowsMove * avgH * 0.92);
        var dirPx = (frame > hi ? orderSign : -orderSign);
        var before = container.scrollTop;
        var rangeBefore = lo + ':' + hi;
        container.scrollTop = before + dirPx * px;
        if (onStatus) onStatus('跳 ' + Math.round(rowsMove) + ' 行（第 ' + iter + ' 次）');

        setTimeout(function () {
          var moved = container.scrollTop !== before;
          var info2 = rowInfo();
          var lo2 = info2.length ? Math.min(info2[0].f, info2[info2.length - 1].f) : null;
          var hi2 = info2.length ? Math.max(info2[0].f, info2[info2.length - 1].f) : null;
          var rangeChanged = info2.length ? ((lo2 + ':' + hi2) !== rangeBefore) : false;

          if (!moved) {
            // 滚动条没动：可能到了已加载数据的边界（分页还没加载下一页）
            // 只要目标帧还比当前可见的最大帧号大（或更小），就继续等一等再滚
            var stillBeyond = (hi2 != null) && (frame > hi2 || frame < lo2);
            if (stillBeyond && stuck < 10) {
              stuck++;
              if (onStatus) onStatus('等列表加载…（第 ' + stuck + ' 次）');
              setTimeout(step, 900);
              return;
            }
            stuck++;
            if (stuck >= 4) { finish(null); return; }
            setTimeout(step, 500);
            return;
          }
          stuck = 0;
          // 滚了但可见范围没变 → 列表还在渲染/加载，等一拍再看（用户口径：滚到之后等一下继续滚）
          if (!rangeChanged) { setTimeout(step, 600); return; }
          step();
        }, 700);   // 滚完等 0.7 秒让列表加载，再继续（旧版只等 45ms → 加载堆积会拖垮页面）
      }
      step();
    });
  }

  // 找左列表的滚动容器：含当前帧行的可滚动祖先，否则选 scrollHeight 最大的可滚动元素
  function findListContainer() {
    // ① 从当前帧行往上找可滚动祖先
    var row = (ctx.task && ctx.task.data) ? findFrameRow(ctx.task.data.frame) : null;
    var el = row;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 100) return el;
      el = el.parentElement;
    }
    // ② 扫所有可滚动元素，按"里面有多少个纯数字单元格"打分，取最像帧列表的那个
    //    （编辑器界面里有很多可滚动区域，只按高度取会拿到错误的那个 → 拽了没反应）
    var best = null, bestScore = 0;
    var all = document.querySelectorAll('div, section, main, [role="grid"], ul');
    for (var i = 0; i < all.length; i++) {
      var d = all[i];
      if (d.scrollHeight <= d.clientHeight + 100 || d.clientHeight < 120) continue;
      var leaves = d.querySelectorAll('td, th, span, div');
      var hits = 0;
      for (var j = 0; j < leaves.length && hits < 12; j++) {
        if (leaves[j].children.length) continue;
        var t = (leaves[j].textContent || '').trim();
        if (/^\d{3,5}$/.test(t)) hits++;
      }
      if (hits >= 3 && hits > bestScore) { bestScore = hits; best = d; }
    }
    if (best) return best;
    // ③ 最后兜底：最大的可滚动 div
    var b2 = null, h2 = 0;
    for (var k = 0; k < all.length; k++) {
      var e = all[k];
      if (e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 200 && e.scrollHeight > h2) {
        h2 = e.scrollHeight; b2 = e;
      }
    }
    return b2;
  }

  function jumpToFrame(frameStr, onStatus) {
    var pid = APIW.projectIdFromPath();
    var frame = parseInt(frameStr, 10);
    if (!isFinite(frame) || frame < 0) { onStatus('帧号无效'); return; }

    // ① 已登记且该行就在视口里 → 直接点（最快）
    var hit = pid ? taskRegistry[pid + ':' + frame] : null;
    if (hit) {
      var row0 = findFrameRow(frame);
      if (row0 && isRowUsable(row0)) { row0.click(); onStatus('已跳转'); return; }
    }

    // ② 拖列表找（拖拉往下拉，列表跟着走）—— 绝不整页跳转（重载 = 用户说的"网页跳蹦了"）
    onStatus('拽动定位…');
    scrollSearchRow(frame, onStatus).then(function (found) {
      if (found && isRowUsable(found)) { found.click(); onStatus('已跳转'); return; }
      // ③ 拖不到 → 查接口定位 task id 后点行；仍不行就干净提示，不重载页面
      onStatus('按帧号查询…');
      return searchFrame(pid, frame, onStatus).then(function (tid) {
        if (!tid) {
          onStatus('未找到帧 ' + frame);
          toast('没找到帧 ' + frame + '（列表加载不到该帧）');
          return;
        }
        var row1 = findFrameRow(frame);
        if (row1 && isRowUsable(row1)) { row1.click(); onStatus('已跳转'); return; }
        // 找到 task 但行不在列表里：**不整页跳转**（会重载页面），提示用户拖列表
        onStatus('帧 ' + frame + ' 在 task ' + tid + '，但列表没加载到该行');
        toast('目标帧在 task ' + tid + '，但列表没滚动到那里——请手动把列表往下拉一段再试（不刷新页面）');
      });
    }).catch(function (e) {
      onStatus('跳转失败');
      console.error('[帧检助手] 跳转失败', e);
    });
  }

  function searchFrame(pid, frame, onStatus) {
    var base = listUrlTemplate || (API + '/projects/' + pid + '/tasks');
    var PAGE = 100, CAP = 16;
    var fetched = 0;
    function pageUrl(p) {
      var u = new URL(base, location.origin);
      u.searchParams.set('page', String(p));
      u.searchParams.set('page_size', String(PAGE));
      return u.toString();
    }
    function fetchPage(p) {
      return fetch(pageUrl(p), { credentials: 'include', headers: { 'Accept': 'application/json', 'X-LSFI': '1' } })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) {
          var arr = Array.isArray(j) ? j : (j && Array.isArray(j.tasks) ? j.tasks : (j && Array.isArray(j.results) ? j.results : []));
          ingestTaskList(pageUrl(p), arr);
          fetched++;
          if (onStatus) onStatus('搜索中… ' + fetched + ' 页');
          return arr;
        });
    }
    function probe(pages) {
      var i = 0;
      function next() {
        var hit = taskRegistry[pid + ':' + frame];
        if (hit) return Promise.resolve(hit);
        if (i >= pages.length || fetched >= CAP) return Promise.resolve(null);
        return fetchPage(pages[i++]).then(next);
      }
      return next();
    }

    // 先用平台的筛选接口一次定位（等价于在筛选栏里按 data.frame 过滤），比逐页翻快得多
    function filterUrl(kind) {
      var u = new URL(base, location.origin);
      u.searchParams.set('page', '1');
      u.searchParams.set('page_size', '50');
      var item = (kind === 'contains')
        ? { filter: 'filter:tasks:data.frame', operator: 'contains', type: 'String', value: String(frame) }
        : { filter: 'filter:tasks:data.frame', operator: 'equal', type: 'Number', value: String(frame) };
      u.searchParams.set('filters', JSON.stringify({ conjunction: 'and', items: [item] }));
      return u.toString();
    }
    function tryFilter(kind) {
      if (onStatus) onStatus('按帧号查询…');
      var url = filterUrl(kind);
      return fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json', 'X-LSFI': '1' } })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) {
          var arr = Array.isArray(j) ? j : (j && Array.isArray(j.tasks) ? j.tasks : (j && Array.isArray(j.results) ? j.results : []));
          if (arr && arr.length) ingestTaskList(url, arr);
          return taskRegistry[pid + ':' + frame] || null;
        })
        .catch(function () { return null; });
    }

    return tryFilter('equal').then(function (hit) {
      if (hit) return hit;
      return tryFilter('contains');
    }).then(function (hit) {
      if (hit) { if (onStatus) onStatus('已定位'); return hit; }
      return fetchPage(1).then(function (arr) {
        var h2 = taskRegistry[pid + ':' + frame];
        if (h2) return h2;
        var frames = arr.map(function (t) { return t && t.data ? Number(t.data.frame) : NaN; }).filter(function (f) { return isFinite(f); });
        var ascending = frames.length > 1 && frames[0] < frames[frames.length - 1];
        if (ascending) {
          // 用已知"帧→task"推算偏移（本项目帧 4500=task 37867，偏移 33367；
          // estimatePage 按"帧号≈页码"估会翻错 300+ 页）
          var offset = null;
          Object.keys(taskRegistry).forEach(function (k) {
            if (offset != null || k.indexOf(pid + ':') !== 0) return;
            var f2 = Number(k.slice(pid.length + 1));
            var t2 = Number(taskRegistry[k]);
            if (isFinite(f2) && isFinite(t2)) offset = t2 - f2;
          });
          if (offset == null && ctx.win && ctx.win.nextList && ctx.win.nextList[0]) {
            offset = Number(ctx.win.nextList[0].task.id) - Number(ctx.win.nextList[0].frame);
          }
          var estPage = offset != null ? Math.max(1, Math.floor((Number(frame) + offset) / PAGE) + 1)
            : CORE.estimatePage(frame, PAGE);
          return probe(CORE.probeOrder(estPage, 2));
        }
        var pages = [];
        for (var p = 2; p <= CAP + 1; p++) pages.push(p);
        return probe(pages);
      });
    });
  }

  /* ---------------- 翻帧导航 ---------------- */
  // 保守模式：只点"当前视口内可见"的相邻行；行不可见就提示，不自动拽列表、不整页跳转
  /* ---------------- 批量处理：一次跑 N 帧，用户只检查 ---------------- */
  var batch = null;

  function batchUI(txt, pct) {
    var bar = shadow && shadow.getElementById('batchbar');
    var fill = shadow && shadow.getElementById('bb-fill');
    var t = shadow && shadow.getElementById('bb-text');
    if (bar) bar.style.display = 'block';
    if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (t) t.textContent = txt;
  }

  // 直接在左侧列表里找 frame 那一行并点击（不需要先反查 task id）
  function clickFrameRow(frame) {
    var row = findFrameRow(Number(frame));
    if (row && isRowUsable(row)) {
      try { row.click(); return true; } catch (e) { return false; }
    }
    return false;
  }

  function batchApplicable() {
    return (lastSuggestions || []).filter(function (sg) { return sg.type !== 'need_number'; });
  }

  function batchStop(reason) {
    if (!batch) return;
    batch = null;
    try { sessionStorage.removeItem('lsfi_batch'); } catch (e) { }
    var b = shadow && shadow.getElementById('btn-batch');
    if (b) { b.textContent = '批量 5 帧'; }
    var st = shadow && shadow.getElementById('btn-batch-stop');
    if (st) st.style.display = 'none';
    var bar = shadow && shadow.getElementById('batchbar');
    if (bar) bar.style.display = 'none';
    if (reason) toast('批量已停止：' + reason);
  }

  // 页面刷新后自动续跑批量：整页跳转兜底会重载页面，批量状态存 sessionStorage，回来接着跑
  function maybeResumeBatch() {
    if (batch || !shadow) return;
    var raw = null;
    try { raw = sessionStorage.getItem('lsfi_batch'); } catch (e) { }
    if (!raw) return;
    var b = null;
    try { b = JSON.parse(raw); } catch (e) { }
    if (!b || !b.total || b.i >= b.total) {
      try { sessionStorage.removeItem('lsfi_batch'); } catch (e) { }
      return;
    }
    batch = b;
    var btn = shadow.getElementById('btn-batch');
    if (btn) btn.textContent = '批量 ' + b.total + ' 帧·运行中';
    var st = shadow.getElementById('btn-batch-stop');
    if (st) st.style.display = '';
    batchUI('批量恢复（页面刷新后续跑）：第 ' + (b.i + 1) + '/' + b.total + ' 帧', b.i / b.total * 100);
    diagLog('批量恢复：页面刷新后从当前帧继续');
    toast('批量已恢复：继续处理第 ' + (b.i + 1) + '/' + b.total + ' 帧');
    setTimeout(batchStep, 1200);
  }

  function batchStep() {
    if (!batch) return;
    if (batch.i >= batch.total) {
      toast('批量完成 ✓ 共处理 ' + batch.done + ' 帧（提交 ' + (batch.submitted || 0) + ' 帧 · 跳过 ' + batch.skipped + ' 帧无建议）');
      batchUI('批量完成 ✓ 处理 ' + batch.done + ' 帧 · 写入 ' + batch.appliedN + ' 处 · 提交 ' + (batch.submitted || 0) + ' 帧' +
        (batch.skipped ? ' · 无建议 ' + batch.skipped + ' 帧' : ''), 100);
      setTimeout(function () {
        var bar = shadow && shadow.getElementById('batchbar');
        if (bar && !batch) bar.style.display = 'none';
      }, 4000);
      diagLog('批量完成：处理 ' + batch.done + '，跳过 ' + batch.skipped + '，写入 ' + batch.appliedN + ' 处');
      batchStop(null);
      return;
    }
    batch.i++;
    // 批量状态持久化：整页跳转兜底会刷新页面，刷新后靠 sessionStorage 自动续跑
    try { sessionStorage.setItem('lsfi_batch', JSON.stringify(batch)); } catch (e) { }
    var frame = (ctx.task && ctx.task.data) ? ctx.task.data.frame : null;
    var list = batchApplicable();
    if (!list.length) {
      batch.skipped++;
      batchUI('批量 ' + batch.i + '/' + batch.total + ' 帧 · 帧 ' + frame + ' 无建议，点提交 · 已写入 ' + batch.appliedN + ' 处',
        batch.i / batch.total * 100);
      toast('批量 ' + batch.i + '/' + batch.total + '：帧 ' + frame + ' 无建议，提交后进入下一帧');
      submitCurrentAndAdvance();
      return;
    }
    // 逐行读取下拉选的号码（与「全部应用」一致）
    var withNums = list.map(function (sg) {
      var realIdx = (lastSuggestions || []).indexOf(sg);
      var inp = shadow.querySelector('[data-numfor="' + realIdx + '"]');
      var typed = inp ? String(inp.value).trim() : null;
      if (sg.type === 'add_box') {
        return { type: 'add_box', conf: sg.conf, reason: sg.reason,
          box: { label: sg.box.label, x: sg.box.x, y: sg.box.y, w: sg.box.w, h: sg.box.h,
            cx: sg.box.cx, cy: sg.box.cy, number: typed == null ? (sg.box.number || '') : typed } };
      }
      if ((sg.type === 'fill_number' || sg.type === 'fix_number') && typed) {
        return { type: sg.type, box: sg.box, number: typed, conf: sg.conf, reason: sg.reason };
      }
      return sg;
    });
    toast('批量 ' + batch.i + '/' + batch.total + '：帧 ' + frame + ' 应用 ' + withNums.length + ' 条…');
    batchUI('批量 ' + batch.i + '/' + batch.total + ' 帧 · 当前帧 ' + frame + ' · 应用 ' + withNums.length + ' 条 · 已累计写入 ' + (batch.appliedN + withNums.length) + ' 处',
      (batch.i - 1) / batch.total * 100);
    applySuggestions(withNums, null, function (r) {
      if (!batch) return;
      if (!r.ok) { batchStop('帧 ' + frame + ' 写入失败'); return; }
      batch.done++;
      batch.appliedN += (r.n || 0);
      batchUI('批量 ' + batch.i + '/' + batch.total + ' 帧 · 已写入 ' + batch.appliedN + ' 处 ✓ 正在提交…',
        batch.i / batch.total * 100);
      submitCurrentAndAdvance();
    });
  }

  // 批量每帧收尾：点 LS 的 Submit/Update 提交这一帧，等提交写库后再进下一帧
  function submitCurrentAndAdvance() {
    if (!batch) return;
    var frame = (ctx.task && ctx.task.data) ? ctx.task.data.frame : null;
    var ok = clickLsSubmit();
    if (ok) batch.submitted = (batch.submitted || 0) + 1;
    batchUI('批量 ' + batch.i + '/' + batch.total + ' 帧 · 帧 ' + frame + (ok ? ' 已点提交 ✓' : '（无提交按钮，直接前进）') + ' · 进入下一帧…',
      batch.i / batch.total * 100);
    setTimeout(batchNext, ok ? 1000 : 300);   // 提交是异步写库，等一下再翻下一帧
  }

  function batchNext() {
    if (!batch) return;
    var before = (ctx.task && ctx.task.data) ? ctx.task.data.frame : null;
    var target = (before == null) ? null : Number(before) + 1;
    if (target == null) { batchStop('无法定位到下一帧'); return; }
    // 列表就摆在眼前、按帧号排好 —— 直接按顺序点下一行。
    // 提交后列表会重渲染（0→1），那一瞬间可能找不到行 → 短暂重试，而不是掉进 API 搜索卡住。
    var tries = 0;
    (function retry() {
      if (!batch) return;
      var now = (ctx.task && ctx.task.data) ? ctx.task.data.frame : null;
      if (now === target) { setTimeout(batchStep, 700); return; }   // 已经切过去了
      if (clickFrameRow(target)) {
        var t = 0;
        (function wait() {
          if (!batch) return;
          var n2 = (ctx.task && ctx.task.data) ? ctx.task.data.frame : null;
          t++;
          if (n2 === target || t > 12) { setTimeout(batchStep, 700); return; }
          setTimeout(wait, 500);
        })();
        return;
      }
      tries++;
      batchUI('批量 ' + batch.i + '/' + batch.total + ' 帧 · 等列表渲染出帧 ' + target + '（' + tries + '/10）…', batch.i / batch.total * 100);
      if (tries >= 10) {
        // 行不在视口 → 先拖列表找（拖拉往下拉，列表跟着走，不刷新页面）；拖不到才干净停下
        batchUI('批量 ' + batch.i + '/' + batch.total + ' 帧 · 正在拖列表到帧 ' + target + '…', batch.i / batch.total * 100);
        scrollSearchRow(target, function (st) {
          batchUI('批量 ' + batch.i + '/' + batch.total + ' 帧 · ' + st, batch.i / batch.total * 100);
        }).then(function (found) {
          if (!batch) return;
          if (found && clickFrameRow(target)) {
            var t = 0;
            (function wait() {
              if (!batch) return;
              var n2 = (ctx.task && ctx.task.data) ? ctx.task.data.frame : null;
              t++;
              if (n2 === target || t > 12) { setTimeout(batchStep, 700); return; }
              setTimeout(wait, 500);
            })();
            return;
          }
          batchStop('列表里找不到帧 ' + target + '：请把左侧列表拖到该帧附近，再点「批量」继续');
        });
        return;
      }
      setTimeout(retry, 500);
    })();
  }

  function startBatch(n) {
    if (!ctx.task || !ctx.task.data) { toast('请先选中一帧再批量'); return; }
    if (batch) { toast('批量正在进行中'); return; }
    batch = { total: n, i: 0, done: 0, skipped: 0, appliedN: 0, submitted: 0 };
    var b = shadow.getElementById('btn-batch');
    if (b) b.textContent = '批量 ' + n + ' 帧·运行中';
    var st = shadow.getElementById('btn-batch-stop');
    if (st) st.style.display = '';
    batchUI('批量开始：帧 ' + ctx.task.data.frame + ' 起，共 ' + n + ' 帧', 0);
    diagLog('批量开始：' + n + ' 帧，起始帧 ' + ctx.task.data.frame);
    toast('批量开始：从帧 ' + ctx.task.data.frame + ' 起处理 ' + n + ' 帧（随时可点「停止」）');
    setTimeout(batchStep, 400);
  }

  function gotoFrame(delta) {
    var pid = APIW.projectIdFromPath();
    var frame = (ctx.task && ctx.task.data) ? ctx.task.data.frame : null;
    var targetId = null, targetFrame = null;
    if (frame != null && pid) {
      targetFrame = Number(frame) + delta;
      var reg = lookupNeighbors(pid, frame);
      targetId = delta < 0 ? reg.prev : reg.next;
    }
    if (!targetId) {
      toast('未定位到' + (delta < 0 ? '上一帧' : '下一帧') + '：请先在左侧列表点击目标帧');
      return;
    }
    var row = targetFrame != null ? findFrameRow(targetFrame) : null;
    if (row && isRowUsable(row)) {
      try { row.click(); return; } catch (e) { }
    }
    // 行不在可视区 → 交给跳转逻辑（拖列表/查 id/整页跳）
    jumpToFrame(String(targetFrame), function (st) { toast(st); });
  }

  document.addEventListener('keydown', function (e) {
    if (!host) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    // 默认只认 Alt+← / Alt+→，避免和 LS 自己的按键导航打架；面板里开了"键盘翻帧"才认裸方向键
    var isArrow = (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
    if (!isArrow) return;
    var withAlt = e.altKey || e.metaKey;
    if (!withAlt && !state.kbd) return;
    e.preventDefault();
    gotoFrame(e.key === 'ArrowLeft' ? -1 : 1);
  });

  /* ---------------- URL 监听 ---------------- */
  var lastUrl = location.href;
  var lastTask = null;
  function tick() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      var t = readUrlTask();
      if (t !== lastTask) { lastTask = t; loadCurrent(false); }
    }
  }
  setInterval(tick, 400);

  // 左列表点击（含重复点当前帧）→ 防抖刷新当前帧数据。
  // LS 对重复点同一帧不会重新拉数据，插件据此自己刷新，保证永远用最新数据判断。
  var cachedListContainer = null;
  document.addEventListener('click', function (e) {
    if (!cachedListContainer || !document.contains(cachedListContainer)) cachedListContainer = findListContainer();
    if (!cachedListContainer || !cachedListContainer.contains(e.target)) return;
    scheduleReload(800);
  }, true);

  /* ---------------- 启动 ---------------- */
  var MY_VER = '2.13.20';
  window.__LSFI_VER = MY_VER; // 后台看守用它核对标签页里的脚本版本
  function checkVersion() {
    try {
      var v = chrome.runtime.getManifest().version;
      if (v && v !== MY_VER) {
        console.error('[帧检助手] 页面脚本版本 ' + MY_VER + ' 与扩展版本 ' + v + ' 不一致——该标签页还在跑旧脚本，请按 F5 / Cmd+R 真正刷新页面（在 LS 里点行切换不会重载脚本）');
        setBadge('⚠ 请按F5', false);
      }
    } catch (e) { }
  }

  function boot() {
    try {
      ensureBadge();
      loadLocalFix();
      loadHistory();
      loadBaseline();
      try { checkVersion(); } catch (e) { console.warn('[帧检助手] 版本检查失败', e); }
      diagLog('启动 v' + MY_VER + '，URL=' + location.pathname + location.search);
      if (readUrlTask()) loadCurrent(false);
      else renderIdle();
    } catch (e) {
      console.error('[帧检助手] 启动失败', e);
      diagLog('启动失败：' + (e && e.message));
      try { setBadge('⚠ 启动失败', false); } catch (e2) { }
      try { showFatal(e); } catch (e3) { }
    }
  }
  // 极端情况下也要能打开面板并把错误摆出来
  function showFatal(e) {
    if (!document.body) return;
    ensurePanel();
    if (bodyEl) {
      bodyEl.innerHTML = '<div class="iss" style="background:#fdecea;border-color:#e6b8b3;color:#8f1d1d">' +
        '插件初始化出错：' + esc((e && e.message) || String(e)) + '<br>请按 Cmd+Option+J 看控制台红字，或反馈这段信息。</div>';
    }
  }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
  setInterval(enforceOwnership, 1000);
  enforceOwnership();

  // 版本标记（后台看守据此判断页面里跑的是不是最新脚本）+ 手动打开入口
  window.__LSFI_VER = MY_VER;
  window.__LSFI_OPEN = function () {
    try {
      closedByUser = false;
      ensurePanel();
      if (readUrlTask()) loadCurrent(true);
      else renderIdle();
      return 'ok';
    } catch (e) {
      console.error('[帧检助手] 打开面板失败', e);
      return 'error: ' + (e && e.message);
    }
  };

  window.addEventListener('error', function (e) {
    console.error('[帧检助手] 运行错误：', e.message, e.filename + ':' + e.lineno);
    diagLog('运行错误：' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno);
    setBadge('⚠ 出错', false);
  });
})();
