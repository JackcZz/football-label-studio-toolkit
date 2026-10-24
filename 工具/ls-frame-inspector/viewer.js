/*
 * LS 帧检助手 · 独立查看窗（viewer.js）
 * 新窗口加载该帧图片，canvas 绘制原框 + AI 建议框，支持缩放/平移/定位，
 * 建议可一键应用（回写平台 + 本地修正层 + 通知来源页刷新）。
 */
(function () {
  'use strict';
  var CORE = window.LSFI_CORE;
  var APIW = window.LSFI_API;
  if (!CORE || !APIW) { document.getElementById('fi').textContent = 'core.js / api.js 加载失败'; return; }

  var params = new URL(location.href).searchParams;
  var ORIGIN = params.get('origin') || location.origin;
  var PID = params.get('pid') || '';
  var WIN = Math.max(1, Math.min(10, parseInt(params.get('win') || '5', 10)));
  var API = ORIGIN + '/api';
  document.getElementById('win-n').textContent = WIN;

  var sess = null;
  try { if (window.chrome && chrome.storage && chrome.storage.session) sess = chrome.storage.session; } catch (e) { }
  var localFix = {};
  function loadLocalFix() {
    if (!sess) return Promise.resolve();
    return new Promise(function (res) {
      sess.get('localFix', function (o) { localFix = (o && o.localFix) || {}; res(); });
    });
  }
  function saveLocalFix() {
    if (!sess) return;
    try { sess.set({ localFix: localFix }); } catch (e) { }
  }

  /* ---------- 数据 ---------- */
  var mem = new Map();
  function fetchTask(id) {
    if (mem.has(id)) return Promise.resolve(mem.get(id));
    if (sess) {
      return new Promise(function (res) {
        sess.get('t' + id, function (o) {
          if (o && o['t' + id]) { mem.set(id, o['t' + id]); res(o['t' + id]); }
          else res(null);
        });
      }).then(function (c) {
        if (c) return c;
        return doFetch(id);
      });
    }
    return doFetch(id);
  }
  function doFetch(id) {
    return fetch(API + '/tasks/' + id, { credentials: 'include', headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        if (r.status === 404) return { __missing: true, id: id };
        if (!r.ok) return { __error: true, id: id, status: r.status };
        return r.json();
      })
      .then(function (t) {
        if (!t.__missing && !t.__error) {
          mem.set(id, t);
          if (sess) { try { var o = {}; o['t' + id] = t; sess.set(o); } catch (e) { } }
        }
        return t;
      });
  }

  function probeTask(probeId, expectFrame) {
    return fetchTask(probeId).then(function (t) {
      if (!t || t.__missing || t.__error) return null;
      if (t.project != null && String(t.project) !== String(PID)) return null;
      if (!t.data || Number(t.data.frame) !== expectFrame) return null;
      return t;
    });
  }

  function frameSource(frame, task) {
    var key = PID + ':' + frame;
    var lf = localFix[key];
    if (lf) {
      var ann = task && task.annotations && task.annotations[0];
      var annTs = ann && ann.updated_at ? Date.parse(ann.updated_at) : 0;
      if (annTs && annTs > lf.ts) {
        delete localFix[key];
        saveLocalFix();
      } else {
        return CORE.wrapLocalResult(lf.result, '本地修正版');
      }
    }
    return task;
  }
  function parseBest(task) {
    if (!task || task.__missing || task.__error) return null;
    var bs = CORE.bestSourceOf(task);
    return bs ? CORE.parseSource(task, bs.kind, bs.index) : null;
  }

  /* ---------- 状态 ---------- */
  var task = null, prevList = [], nextList = [], suggestions = [];
  var img = new Image();
  var imgReady = false;
  var view = { scale: 1, x: 0, y: 0 };
  var hl = null; // {box, label, until}
  var cv = document.getElementById('cv');
  var ctx2d = cv.getContext('2d');
  var stage = document.getElementById('stage');
  var loadingEl = document.getElementById('loading');

  function resize() {
    var r = stage.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    cv.width = r.width * dpr;
    cv.height = r.height * dpr;
    cv.style.width = r.width + 'px';
    cv.style.height = r.height + 'px';
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  window.addEventListener('resize', resize);

  function fitScale() {
    if (!imgReady) return 1;
    var r = stage.getBoundingClientRect();
    return Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight) * 0.95;
  }
  function fitView() {
    var s = fitScale();
    var r = stage.getBoundingClientRect();
    view.scale = s;
    view.x = (r.width - img.naturalWidth * s) / 2;
    view.y = (r.height - img.naturalHeight * s) / 2;
    draw();
  }

  function s2i(sx, sy) { return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale }; }
  function i2s(ix, iy) { return { x: view.x + ix * view.scale, y: view.y + iy * view.scale }; }

  /* ---------- 绘制 ---------- */
  var TEAM_COLOR = { teamA: '#2456c8', teamB: '#c8102e', goalkeeperA: '#0e8a5f', goalkeeperB: '#0e8a5f', referee: '#d99a06', unknown: '#8a93a6' };
  var SUG_META = {
    fill_number: { color: '#0e8a5f', name: '补号' },
    fix_number: { color: '#d99a06', name: '改号' },
    add_box: { color: '#7c3aed', name: '补框' },
    del_box: { color: '#c0392b', name: '删框' }
  };

  function draw() {
    var r = stage.getBoundingClientRect();
    ctx2d.clearRect(0, 0, r.width, r.height);
    if (!imgReady) return;
    ctx2d.save();
    ctx2d.translate(view.x, view.y);
    ctx2d.scale(view.scale, view.scale);
    ctx2d.drawImage(img, 0, 0);
    ctx2d.restore();

    var W = img.naturalWidth, H = img.naturalHeight;
    var lw = Math.max(1, 1.6 / view.scale);

    // 原框（当前帧最优来源）
    var cur = parseBest(frameSource(task.data.frame, task));
    if (cur) {
      cur.boxes.forEach(function (b) {
        var x = b.x / 100 * W, y = b.y / 100 * H, w = b.w / 100 * W, h = b.h / 100 * H;
        ctx2d.strokeStyle = TEAM_COLOR[b.label] || '#333';
        ctx2d.lineWidth = lw;
        ctx2d.strokeRect(x, y, w, h);
        ctx2d.fillStyle = TEAM_COLOR[b.label] || '#333';
        ctx2d.font = 'bold ' + Math.max(10, 13 / view.scale) + 'px -apple-system,"PingFang SC",sans-serif';
        ctx2d.lineWidth = Math.max(1.5, 3 / view.scale);
        ctx2d.strokeStyle = 'rgba(255,255,255,.9)';
        var label = b.label + (b.number ? ' #' + b.number : ' 缺号');
        ctx2d.strokeText(label, x, y - 2 / view.scale);
        ctx2d.fillText(label, x, y - 2 / view.scale);
      });
    }

    // 建议框（半透明 + 错位）
    suggestions.forEach(function (sg) {
      var meta = SUG_META[sg.type];
      if (!meta) return;
      var b = sg.box;
      var x = b.x / 100 * W + 8 / view.scale, y = b.y / 100 * H - 8 / view.scale;
      var w = b.w / 100 * W, h = b.h / 100 * H;
      ctx2d.fillStyle = meta.color + '2c';
      ctx2d.fillRect(x, y, w, h);
      ctx2d.strokeStyle = meta.color;
      ctx2d.lineWidth = Math.max(1.2, 2 / view.scale);
      ctx2d.setLineDash([6 / view.scale, 4 / view.scale]);
      ctx2d.strokeRect(x, y, w, h);
      ctx2d.setLineDash([]);
      var label = meta.name + ' ';
      if (sg.type === 'fill_number') label += sg.number;
      else if (sg.type === 'fix_number') label += b.number + '→' + sg.number;
      else label += b.label + (b.number ? ' #' + b.number : '');
      ctx2d.font = 'bold ' + Math.max(11, 14 / view.scale) + 'px -apple-system,"PingFang SC",sans-serif';
      ctx2d.lineWidth = Math.max(2, 3.5 / view.scale);
      ctx2d.strokeStyle = 'rgba(255,255,255,.95)';
      ctx2d.strokeText(label, x, y - 4 / view.scale);
      ctx2d.fillStyle = meta.color;
      ctx2d.fillText(label, x, y - 4 / view.scale);
      if (sg.type === 'del_box') {
        var cx = b.cx / 100 * W, cy = b.cy / 100 * H;
        ctx2d.beginPath();
        ctx2d.moveTo(cx - w * 0.3, cy - h * 0.3); ctx2d.lineTo(cx + w * 0.3, cy + h * 0.3);
        ctx2d.moveTo(cx - w * 0.3, cy + h * 0.3); ctx2d.lineTo(cx + w * 0.3, cy - h * 0.3);
        ctx2d.stroke();
      }
    });

    // 定位高亮（呼吸圈）
    if (hl && Date.now() < hl.until) {
      var hb = hl.box;
      var cx = hb.cx / 100 * W, cy = hb.cy / 100 * H;
      var pulse = 3 + Math.sin(Date.now() / 150) * 1.2;
      ctx2d.strokeStyle = '#c8102e';
      ctx2d.lineWidth = Math.max(1.5, 2.5 / view.scale);
      ctx2d.beginPath();
      ctx2d.arc(cx, cy, Math.max(10, pulse * 10 / view.scale), 0, Math.PI * 2);
      ctx2d.stroke();
      ctx2d.beginPath();
      ctx2d.moveTo(cx - 40 / view.scale, cy); ctx2d.lineTo(cx - 14 / view.scale, cy);
      ctx2d.moveTo(cx + 14 / view.scale, cy); ctx2d.lineTo(cx + 40 / view.scale, cy);
      ctx2d.moveTo(cx, cy - 40 / view.scale); ctx2d.lineTo(cx, cy - 14 / view.scale);
      ctx2d.moveTo(cx, cy + 14 / view.scale); ctx2d.lineTo(cx, cy + 40 / view.scale);
      ctx2d.stroke();
      ctx2d.font = 'bold ' + Math.max(12, 16 / view.scale) + 'px -apple-system,"PingFang SC",sans-serif';
      ctx2d.lineWidth = Math.max(2, 3.5 / view.scale);
      ctx2d.strokeStyle = '#fff';
      ctx2d.strokeText('◀ ' + hl.label, cx + 16 / view.scale, cy - 16 / view.scale);
      ctx2d.fillStyle = '#c8102e';
      ctx2d.fillText('◀ ' + hl.label, cx + 16 / view.scale, cy - 16 / view.scale);
    }
    requestAnimationFrame(draw);
  }

  /* ---------- 交互 ---------- */
  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = stage.getBoundingClientRect();
    var mx = e.clientX - r.left, my = e.clientY - r.top;
    var before = s2i(mx, my);
    var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    var ns = Math.max(fitScale() * 0.3, Math.min(fitScale() * 12, view.scale * factor));
    view.scale = ns;
    var after = i2s(before.x, before.y);
    view.x += mx - after.x;
    view.y += my - after.y;
  }, { passive: false });

  var panning = null;
  cv.addEventListener('mousedown', function (e) {
    panning = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  });
  window.addEventListener('mousemove', function (e) {
    if (!panning) return;
    view.x = panning.vx + (e.clientX - panning.x);
    view.y = panning.vy + (e.clientY - panning.y);
  });
  window.addEventListener('mouseup', function () { panning = null; });

  document.getElementById('btn-zoom-in').onclick = function () { view.scale *= 1.3; };
  document.getElementById('btn-zoom-out').onclick = function () { view.scale /= 1.3; };
  document.getElementById('btn-fit').onclick = fitView;

  function zoomToBox(b) {
    var r = stage.getBoundingClientRect();
    var s = Math.max(fitScale() * 2.2, Math.min(r.width / (b.w / 100 * img.naturalWidth), r.height / (b.h / 100 * img.naturalHeight)) * 0.6);
    view.scale = s;
    var c = i2s(b.cx / 100 * img.naturalWidth, b.cy / 100 * img.naturalHeight);
    view.x = r.width / 2 - (c.x - view.x);
    view.y = r.height / 2 - (c.y - view.y);
  }

  /* ---------- 渲染面板 ---------- */
  function renderSide() {
    var frame = task.data ? task.data.frame : '?';
    document.getElementById('fi').textContent = '帧 ' + frame + ' · task ' + task.id + (task.__local ? '' : '') + ' · 来源 ' + (parseBest(frameSource(frame, task)) || {}).name;
    var cur = parseBest(frameSource(frame, task));
    document.getElementById('meta').innerHTML =
      '帧 <b>' + esc(frame) + '</b> · task ' + esc(task.id) +
      (localFix[PID + ':' + frame] ? ' · <span class="ok">本地修正版</span>' : '') +
      '<br>检出 ' + (cur ? cur.boxes.length : 0) + ' 框（' + esc(CORE.labelCounts(cur ? cur.boxes : [])) + '）' +
      '<br>邻帧证据：前 ' + prevList.length + ' / 后 ' + nextList.length + ' 帧';

    var box = document.getElementById('sug-list');
    if (!suggestions.length) {
      box.innerHTML = '<div class="meta"><span class="ok">✓ 未发现可由前后帧确定的修正</span></div>';
      return;
    }
    var h = ['<div style="text-align:right;margin-bottom:4px"><button class="sgall" id="sug-all" style="font-size:11px;padding:2px 9px;border-radius:6px;border:1px solid #7c3aed;background:#f3efff;color:#4c1d95;cursor:pointer">全部应用（' + suggestions.length + '）</button></div>'];
    suggestions.forEach(function (sg, i) {
      var meta = SUG_META[sg.type];
      var conf = { high: ['高', '#e7f6ef', '#0e8a5f'], mid: ['中', '#fdf6e3', '#8a6508'], low: ['低·需判断', '#fdecea', '#c0392b'] }[sg.conf] || ['中', '#fdf6e3', '#8a6508'];
      var title = meta.name + ' ';
      if (sg.type === 'fill_number') title += sg.box.label + ' 缺号 → <b>' + esc(sg.number) + '</b>';
      else if (sg.type === 'fix_number') title += sg.box.label + ' <b>' + esc(sg.box.number) + ' → ' + esc(sg.number) + '</b>';
      else if (sg.type === 'add_box') title += '<b>' + esc(sg.box.label) + (sg.box.number ? ' #' + esc(sg.box.number) : '') + '</b>（漏检回补）';
      else title += '<b>' + esc(sg.box.label) + (sg.box.number ? ' #' + esc(sg.box.number) : '') + '</b>（疑似误检）';
      h.push('<div class="sg" style="border-left-color:' + meta.color + '" data-i="' + i + '">' +
        '<div class="txt"><span data-loc="' + i + '">' + title + '</span>' +
        '<span class="cf" style="background:' + conf[1] + ';color:' + conf[2] + '">' + conf[0] + '</span>' +
        '<div class="why">依据：' + esc(sg.reason) + '</div></div>' +
        '<button data-apply="' + i + '">应用</button></div>');
    });
    box.innerHTML = h.join('');

    Array.prototype.forEach.call(box.querySelectorAll('[data-loc]'), function (el) {
      el.onclick = function () {
        var sg = suggestions[Number(el.getAttribute('data-loc'))];
        if (!sg) return;
        hl = { box: sg.box, label: SUG_META[sg.type].name, until: Date.now() + 3000 };
        zoomToBox(sg.box);
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-apply]'), function (btn) {
      btn.onclick = function () {
        var sg = suggestions[Number(btn.getAttribute('data-apply'))];
        if (!sg) return;
        if (sg.conf === 'low' && !window.confirm('该建议证据较弱（仅 1 帧支持），确定应用吗？')) return;
        apply([sg], btn);
      };
    });
    var allBtn = document.getElementById('sug-all');
    if (allBtn) allBtn.onclick = function () {
      var lows = suggestions.filter(function (s) { return s.conf === 'low'; }).length;
      if (!window.confirm('将把 ' + suggestions.length + ' 条修正写入该帧标注' + (lows ? '（其中 ' + lows + ' 条证据较弱）' : '') + '，确定？')) return;
      apply(suggestions, allBtn);
    };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 应用 ---------- */
  function apply(list, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '写入中…'; }
    var bsW = CORE.bestSourceOf(task);
    var annIdx = (bsW && bsW.kind === 'annotation') ? bsW.index : 0;
    APIW.applyToTask(task, list, CORE.buildCorrectedResult, API, annIdx).then(function (res) {
      if (!res.ok) {
        toast('写入失败 HTTP ' + res.status);
        if (btn) { btn.disabled = false; btn.textContent = '应用'; }
        return;
      }
      var frame = task.data ? task.data.frame : null;
      if (PID && frame != null) { localFix[PID + ':' + frame] = { result: res.corrected, ts: Date.now() }; saveLocalFix(); }
      toast('已写入 ✓ ' + list.length + ' 条修正');
      if (btn) { btn.textContent = '已应用 ✓'; btn.className = 'done'; }
      try { if (window.opener) window.opener.postMessage({ type: 'lsfi-updated', task: task.id }, '*'); } catch (e) { }
      // 用修正后的数据重算建议（应验：已应用的建议消失）
      recompute();
      renderSide();
    }).catch(function (e) {
      toast('写入异常：' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = '应用'; }
    });
  }

  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.style.display = 'none'; }, 2600);
  }

  /* ---------- 加载与翻帧 ---------- */
  function recompute() {
    var frame = task.data.frame;
    var cur = parseBest(frameSource(frame, task));
    var ps = prevList.map(function (f) { return parseBest(frameSource(f.frame, f.task)); }).filter(Boolean);
    var ns = nextList.map(function (f) { return parseBest(frameSource(f.frame, f.task)); }).filter(Boolean);
    suggestions = CORE.suggestFixesWindow(cur, ps, ns);
  }

  function loadTask(id) {
    loadingEl.style.display = 'flex';
    loadingEl.textContent = '载入中…';
    fetchTask(id).then(function (t) {
      if (!t || t.__missing || t.__error) {
        loadingEl.textContent = 'task ' + id + ' 加载失败';
        return null;
      }
      task = t;
      return loadWindow(t);
    }).then(function () {
      if (!task) return;
      loadingEl.style.display = 'none';
      imgReady = false;
      img.onload = function () { imgReady = true; fitView(); };
      img.onerror = function () { loadingEl.textContent = '图片加载失败：' + task.data.image; };
      img.src = ORIGIN + task.data.image;
      recompute();
      renderSide();
      document.title = '帧检助手 · 帧 ' + (task.data ? task.data.frame : '?');
    }).catch(function (e) {
      loadingEl.textContent = '加载异常：' + e.message;
    });
  }

  function loadWindow(t) {
    var frame = t.data.frame;
    prevList = []; nextList = [];
    var jobs = [];
    for (var k = 1; k <= WIN; k++) {
      (function (k) {
        jobs.push(probeTask(t.id - k, frame - k).then(function (p) { if (p) prevList.push({ frame: frame - k, task: p }); }));
        jobs.push(probeTask(t.id + k, frame + k).then(function (n) { if (n) nextList.push({ frame: frame + k, task: n }); }));
      })(k);
    }
    return Promise.all(jobs).then(function () {
      prevList.sort(function (a, b) { return b.frame - a.frame; });
      nextList.sort(function (a, b) { return a.frame - b.frame; });
    });
  }

  function gotoDelta(delta) {
    var frame = task.data.frame;
    var list = delta < 0 ? prevList : nextList;
    var hit = null;
    list.forEach(function (f) { if (f.frame === Number(frame) + delta) hit = f; });
    if (hit) { loadTask(hit.task.id); return; }
    // 窗口内没有：直接按 task id 探测
    probeTask(task.id + delta, frame + delta).then(function (t) {
      if (t) loadTask(t.id);
      else toast('未找到' + (delta < 0 ? '上一帧' : '下一帧'));
    });
  }

  document.getElementById('btn-prev').onclick = function () { gotoDelta(-1); };
  document.getElementById('btn-next').onclick = function () { gotoDelta(1); };
  document.getElementById('btn-jump').onclick = function () {
    var v = parseInt(document.getElementById('jump').value, 10);
    if (!isFinite(v) || v < 0) { toast('输入有效帧号'); return; }
    // 帧号 → task id：先在已加载帧里找，否则按 task id 探测附近
    var hit = null;
    [task].concat(prevList.map(function (f) { return f.task; }), nextList.map(function (f) { return f.task; })).forEach(function (t) {
      if (t && t.data && Number(t.data.frame) === v) hit = t.id;
    });
    if (hit) { loadTask(hit); return; }
    // 从当前 task 线性探测（帧号连续场景）
    var delta = v - Number(task.data.frame);
    var step = delta > 0 ? 1 : -1;
    var cur = Promise.resolve(null);
    for (var d = step; Math.abs(d) <= Math.abs(delta) + 3 && Math.abs(d) <= 12; d += step) {
      (function (d) {
        cur = cur.then(function (found) {
          if (found) return found;
          return probeTask(task.id + d, v).then(function (t) { return t || null; });
        });
      })(d);
    }
    cur.then(function (t) { if (t) loadTask(t.id); else toast('未找到帧 ' + v + '（可先在主页列表点该帧再开查看窗）'); });
  };
  document.getElementById('jump').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('btn-jump').click();
  });

  /* ---------- 启动 ---------- */
  loadLocalFix().then(function () {
    resize();
    if (taskId) loadTask(taskId);
    else loadingEl.textContent = '缺少 task 参数';
  });
})();
