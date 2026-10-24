/*
 * LS 帧检助手 · 核心纯函数（core.js）
 * 只做解析/对比/质检判断，不碰 DOM 和网络，可在 Node 下单测。
 * 坐标口径：Label Studio 百分比（0-100），x/y 为左上角，w/h 为宽高。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LSFI_CORE = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var LABEL_ORDER = ['teamA', 'teamB', 'goalkeeperA', 'goalkeeperB', 'referee', 'unknown'];
  /* 算法构建号：content.js 会校验它与预期一致，防止页面缓存了旧 core.js
   * （版本错配=面板显示新版、算法跑旧版，number 类型等新解析全部失效）。
   * 1=初版  2=证据链/草稿竞争  3=number 类型号码控件支持（b47 事件）*/
  var CORE_BUILD = 3;

  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  function labelRank(l) {
    var i = LABEL_INDEX[l];
    return i == null ? 99 : i;
  }
  var LABEL_INDEX = {};
  LABEL_ORDER.forEach(function (l, i) { LABEL_INDEX[l] = i; });

  function boxCmp(a, b) {
    if (a.label !== b.label) {
      var ra = labelRank(a.label), rb = labelRank(b.label);
      if (ra !== rb) return ra - rb;
      return a.label < b.label ? -1 : 1;
    }
    var an = a.number || '~', bn = b.number || '~';
    return an < bn ? -1 : an > bn ? 1 : 0;
  }

  /*
   * 把一个 task 的某个来源（prediction 或 annotation）解析成框列表。
   * LS 的号码框（textarea）有两种挂法，必须都支持：
   *   ① 与 rectanglelabels 用**相同 id**（机器预测常见写法）
   *   ② 自己的 id + **parent_id 指向框的 id**（在 LS 编辑器里手动"给框加文本"就是这种）
   * 只认 ① 会把人工标注的号码全判成"缺号"，从而误报补号。
   */
  function parseSource(task, kind, index) {
    if (!task || task.__missing || task.__error || task.__unrelated) return null;
    var arr = kind === 'prediction' ? task.predictions
      : (kind === 'draft' ? (task.drafts || []) : task.annotations);
    var s = arr && arr[index];
    if (!s || !Array.isArray(s.result)) return null;
    var byId = {}, texts = [];
    for (var i = 0; i < s.result.length; i++) {
      var r = s.result[i];
      if (!r || r.id == null) continue;
      if (r.type === 'rectanglelabels') {
        var v = r.value || {};
        var b = byId[r.id] || (byId[r.id] = { rid: r.id });
        b.label = (v.rectanglelabels || [null])[0] || null;
        b.x = num(v.x); b.y = num(v.y); b.w = num(v.width); b.h = num(v.height);
      } else if (r.type === 'textarea' || r.type === 'text' || r.type === 'richtext' || r.type === 'number') {
        // 号码控件兼容四种写法：
        //   textarea/text/richtext → value.text（数组或字符串）
        //   number（机器预测继承的 per-region 号码标签，6160 帧实锤）→ value.number
        //   ⚠ number 类型曾长期漏解析 → 框被误判"缺号"、补号建议刷屏（b47 事件）
        var tv = r.value || {};
        var tt = (tv.number != null) ? String(tv.number)
          : (Array.isArray(tv.text) ? tv.text.join('') : (tv.text == null ? '' : String(tv.text)));
        texts.push({
          id: r.id,
          parent: r.parent_id == null ? null : r.parent_id,
          from: r.from_name || '',
          text: String(tt).trim()
        });
      }
    }
    // 号码配对：先按"同 id"，再按 parent_id（编辑器写法）
    texts.forEach(function (tx) {
      if (!tx.text) return;
      var t = byId[tx.id];
      if (t && !t.number) t.number = tx.text;
    });
    texts.forEach(function (tx) {
      if (!tx.text) return;
      if (tx.parent == null) return;
      var t = byId[tx.parent];
      if (t && !t.number) t.number = tx.text;
    });
    // 兜底配对：还有"没配上"的文本控件，且只有 1 个框缺号 → 直接挂上去
    // （某些 LS 版本文本框既不同 id 也没 parent_id，只有位置先后关系）
    var rest = texts.filter(function (tx) {
      return tx.text && (byId[tx.id] == null || !byId[tx.id].number) &&
        (tx.parent == null || byId[tx.parent] == null || !byId[tx.parent].number);
    });
    if (rest.length === 1) {
      var noNum = Object.keys(byId).filter(function (k) { return byId[k].label && !byId[k].number; });
      if (noNum.length === 1 && byId[noNum[0]]) byId[noNum[0]].number = rest[0].text;
    }
    var boxes = Object.keys(byId).map(function (k) { return byId[k]; })
      .filter(function (b) { return b.label && b.w > 0 && b.h > 0; })
      .map(function (b) {
        return {
          rid: b.rid, label: b.label, number: b.number || '',
          x: b.x, y: b.y, w: b.w, h: b.h,
          cx: b.x + b.w / 2, cy: b.y + b.h / 2
        };
      });
    boxes.sort(boxCmp);
    return {
      kind: kind, index: index,
      // 草稿也是人工数据（用户在编辑器里改的），否则邻帧草稿会被当机器帧降权，投票全乱
      human: (kind === 'annotation' || kind === 'draft') || !!task.__human,
      name: s.model_version || (kind === 'annotation' ? '人工标注' : (kind === 'draft' ? '草稿·未提交' : '预测')),
      created: s.created_at || null,
      updated: s.updated_at || s.created_at || null,
      score: (s.score == null ? null : s.score),
      boxes: boxes
    };
  }

  /*
   * 帧间对比：把 cur 的每个框匹配到 prev（同队别 + 中心距 <= maxDist，默认 6 个百分点）。
   * 注意：坐标为百分比（0-100），maxDist 同单位；25fps 下球员帧间位移通常 <2，6 为安全上限。
   * 返回 { gone:[prev有cur无], appeared:[cur有prev无], numChanged:[{cur,prev}], rows:[...] }
   */
  function diffBoxes(cur, prev, maxDist) {
    if (!cur || !prev) return null;
    if (maxDist == null) maxDist = 6;
    var used = {};
    var rows = [];
    for (var i = 0; i < cur.boxes.length; i++) {
      var c = cur.boxes[i];
      var best = -1, bestCost = Infinity;
      for (var j = 0; j < prev.boxes.length; j++) {
        if (used[j]) continue;
        var p = prev.boxes[j];
        if (p.label !== c.label) continue;
        var d = Math.sqrt((p.cx - c.cx) * (p.cx - c.cx) + (p.cy - c.cy) * (p.cy - c.cy));
        if (d > maxDist) continue;
        var cost = d + (p.number && c.number && p.number === c.number ? -2 : 0);
        if (cost < bestCost) { bestCost = cost; best = j; }
      }
      if (best >= 0) {
        used[best] = true;
        var pb = prev.boxes[best];
        rows.push({ cur: c, prev: pb, numChanged: !!pb.number && pb.number !== c.number });
      } else {
        rows.push({ cur: c, prev: null, numChanged: false });
      }
    }
    var gone = prev.boxes.filter(function (_, j) { return !used[j]; });
    var appeared = rows.filter(function (r) { return !r.prev; }).map(function (r) { return r.cur; });
    var numChanged = rows.filter(function (r) { return r.numChanged; });
    return { gone: gone, appeared: appeared, numChanged: numChanged, rows: rows };
  }

  /* 单帧质检提示（返回字符串数组） */
  function qcIssues(boxes) {
    var issues = [];
    if (!boxes || !boxes.length) { issues.push('本帧 0 个框（整帧漏检？）'); return issues; }
    // unknown 标签：队别/号码都判不出来，业务上基本都要删，单独点名
    var unk = boxes.filter(function (b) { return /^unknown$/i.test(b.label || ''); });
    if (unk.length) {
      issues.push('含 ' + unk.length + ' 个 unknown 标签框（多数应删除）');
    }
    var noNum = boxes.filter(function (b) { return !b.number; });
    if (noNum.length) {
      issues.push('缺号 ' + noNum.length + ' 个：' + noNum.map(function (b) { return b.label; }).join('、'));
    }
    var byNum = {};
    boxes.forEach(function (b) {
      if (!b.number) return;
      (byNum[b.number] = byNum[b.number] || []).push(b);
    });
    Object.keys(byNum).forEach(function (n) {
      if (byNum[n].length > 1) {
        issues.push('号码 ' + n + ' 本帧重复 ' + byNum[n].length + ' 次（' +
          byNum[n].map(function (b) { return b.label; }).join('/') + '）');
      }
    });
    var a = boxes.filter(function (b) { return b.label === 'teamA'; }).length;
    var b2 = boxes.filter(function (b) { return b.label === 'teamB'; }).length;
    if ((a + b2) >= 3 && (a === 0 || b2 === 0)) {
      issues.push('队别严重失衡：teamA ' + a + ' / teamB ' + b2);
    }
    var edge = boxes.filter(function (b) {
      return b.x < 1.5 || b.y < 1.5 || (b.x + b.w) > 98.5 || (b.y + b.h) > 98.5;
    });
    if (edge.length) issues.push(edge.length + ' 个框贴边（边缘离场？）');
    return issues;
  }

  /* 标签计数，如 "teamA 4 · teamB 2 · goalkeeperA 1" */
  function labelCounts(boxes) {
    var m = {};
    boxes.forEach(function (b) { m[b.label] = (m[b.label] || 0) + 1; });
    return LABEL_ORDER.filter(function (l) { return m[l]; })
      .map(function (l) { return l + ' ' + m[l]; }).join(' · ') || '无';
  }

  function fmtBox(b) {
    return b.label + (b.number ? ' #' + b.number : '(缺号)') +
      ' @(' + b.cx.toFixed(1) + ',' + b.cy.toFixed(1) + ')';
  }

  /*
   * 生成可复制的文本摘要（供人工记录/贴群）。
   * ctx: { taskId, frame, cur:{name,boxes}, prev, next, diffPrev, diffNext, qc }
   */
  function summarize(ctx) {
    var L = [];
    L.push('帧 ' + (ctx.frame == null ? '?' : ctx.frame) + ' · task ' + ctx.taskId + ' · 来源 ' + ctx.curName);
    L.push('检出 ' + ctx.curBoxes.length + ' 框（' + labelCounts(ctx.curBoxes) + '）');
    if (ctx.qc && ctx.qc.length) L.push('质检提示：' + ctx.qc.join('；'));
    if (ctx.diffPrev) {
      L.push('较上一帧(' + ctx.prevFrame + ')：' +
        (ctx.diffPrev.gone.length ? '上帧有当前无[' + ctx.diffPrev.gone.map(fmtBox).join(', ') + '] ' : '') +
        (ctx.diffPrev.appeared.length ? '当前新增[' + ctx.diffPrev.appeared.map(fmtBox).join(', ') + '] ' : '') +
        (ctx.diffPrev.numChanged.length ? '号码变化[' + ctx.diffPrev.numChanged.map(function (r) {
          return r.prev.label + ' ' + r.prev.number + '→' + (r.cur.number || '空');
        }).join(', ') + ']' : ''));
    }
    if (ctx.diffNext) {
      L.push('较下一帧(' + ctx.nextFrame + ')：' +
        (ctx.diffNext.gone.length ? '当前有下帧无[' + ctx.diffNext.gone.map(fmtBox).join(', ') + '] ' : '') +
        (ctx.diffNext.appeared.length ? '下帧新增[' + ctx.diffNext.appeared.map(fmtBox).join(', ') + '] ' : '') +
        (ctx.diffNext.numChanged.length ? '号码变化[' + ctx.diffNext.numChanged.map(function (r) {
          return r.prev.label + ' ' + r.prev.number + '→' + (r.cur.number || '空');
        }).join(', ') + ']' : ''));
    }
    return L.join('\n');
  }

  /*
   * 邻帧权重（按用户业务口径）：**前一帧占绝对主导（约 90%）**，后一帧次之，
   * 更远帧迅速衰减。依据：视频逐帧切换，前一帧与当前帧的连续性最强（用户要求"上一帧权重 90 以上"）。
   */
  var W_PREV = [0.90, 0.05, 0.03, 0.015, 0.005];
  var W_NEXT = [0.17, 0.03, 0.01, 0.005, 0.003];
  /*
   * 人工确认帧（已提交标注/本地修正）的权重：接近权威（95-99%），
   * 同样遵循"前侧 > 后侧"。
   */
  var HUMAN_W_PREV = [0.99, 0.90, 0.84, 0.78, 0.72];
  var HUMAN_W_NEXT = [0.80, 0.62, 0.52, 0.46, 0.42];
  function wPrev(i) { return W_PREV[Math.min(i, W_PREV.length - 1)]; }
  function wNext(i) { return W_NEXT[Math.min(i, W_NEXT.length - 1)]; }
  function wHuman(i, isPrev) {
    var a = isPrev ? HUMAN_W_PREV : HUMAN_W_NEXT;
    return a[Math.min(i, a.length - 1)];
  }

  /* 人工数据源（YOUR_ACCOUNT_ID 的标注/草稿，本地修正也算）——不含凉白开机器预测。 */
  function humanSourceOf(task) {
    if (!task || task.__missing || task.__error || task.__unrelated) return null;
    if (task.__local) return { kind: 'prediction', index: 0, human: true };
    var anns = task.annotations || [];
    // 用户口径：以 YOUR_ACCOUNT_ID 这个账号的最新标注为主；有 244 的标注就只在其中挑最新的，
    // 只有完全没有 244 的标注时才退回"任意账号的最新标注"。
    function byUser(a) {
      var u = a && (a.completed_by || a.created_by || a.user);
      return u && u.username ? String(u.username) : null;
    }
    var USER = 'YOUR_ACCOUNT_ID';
    var best = -1, bestTs = -1;
    for (var i = 0; i < anns.length; i++) {
      var a = anns[i];
      if (a.was_cancelled) continue;
      var ts = Date.parse(a.updated_at || a.created_at || '') || 0;
      if (ts >= bestTs) { bestTs = ts; best = i; }
    }
    // 若存在 244 的标注，且当前挑出的最新标注不是 244 的 → 改在 244 的标注里挑最新
    if (best >= 0 && byUser(anns[best]) !== USER) {
      var hasUser = false;
      for (var j = 0; j < anns.length; j++) { if (byUser(anns[j]) === USER) { hasUser = true; break; } }
      if (hasUser) {
        best = -1; bestTs = -1;
        for (var k = 0; k < anns.length; k++) {
          var a2 = anns[k];
          if (a2.was_cancelled || byUser(a2) !== USER) continue;
          var ts2 = Date.parse(a2.updated_at || a2.created_at || '') || 0;
          if (ts2 >= bestTs) { bestTs = ts2; best = k; }
        }
      }
    }
    var drafts = task.drafts || [];
    var db = -1, dbTs = -1;
    for (var d = 0; d < drafts.length; d++) {
      var dr = drafts[d];
      if (!dr || dr.was_cancelled) continue;
      var dts = Date.parse(dr.updated_at || dr.created_at || '') || 0;
      if (dts >= dbTs) { dbTs = dts; db = d; }
    }
    // 草稿比最新标注新 → 用户正在改还没提交，以草稿为准
    if (db >= 0 && dbTs > bestTs) return { kind: 'draft', index: db, human: true };
    if (best >= 0) return { kind: 'annotation', index: best, human: true };
    if (db >= 0) return { kind: 'draft', index: db, human: true };
    return null;
  }

  /* 当前帧来源：优先 244 的标注/草稿；没有（未提交）→ 回退凉白开机器预测做起稿参考。 */
  function bestSourceOf(task) {
    var h = humanSourceOf(task);
    if (h) return h;
    if (task && !task.__missing && !task.__error && !task.__unrelated &&
        task.predictions && task.predictions.length)
      return { kind: 'prediction', index: task.predictions.length - 1, human: false };
    return null;
  }

  /* 邻帧证据来源：只用 244 的标注/草稿，凉白开一律不进邻帧对比（用户口径）。 */
  function bestHumanSourceOf(task) {
    return humanSourceOf(task);
  }

  /*
   * 基于前后帧生成"修正建议"。cur/prev/next 为 parseSource 的返回值（或 null）。
   * conf: high(相邻帧证据) / mid(远帧弱证据或单侧) / low(很弱，需人判)
   */
  function suggestFixes(cur, prev, next, maxDist) {
    return suggestFixesWindow(cur, prev ? [prev] : [], next ? [next] : [], maxDist);
  }

  /*
   * 窗口版建议（带邻帧权重）。prevList/nextList 为邻帧数组，[0] 是最近邻帧。
   * 规则：
   *   补号/改号：同位置框的号码按权重投票，≥0.4（有相邻帧背书）=high，≥0.1=mid，否则不猜
   *   补框：候选框（取自最近前一帧）的加权出现率 ≥0.4 才建议，≥0.8=high
   *   删框：**前一帧和后一帧都没有**同位置框 → 高置信误检嫌疑（远帧有也不算数，只降档）
   */
  function suggestFixesWindow(cur, prevList, nextList, maxDist, presenceTol, opts) {
    if (!cur) return [];
    // delMode: 'strict'（默认，只与上一帧强比对）/ 'loose'（再加"所有邻帧都没有"的兜底）
    var delMode = (opts && opts.delMode) || 'strict';
    // unknownDel: unknown 标签默认删除（true 默认；false 保留、按上一帧强比对/改标签处理）
    var unknownDel = (opts && opts.unknownDel != null) ? opts.unknownDel : true;
    // 给每个框编"本帧同队第几个"（按 x 从左到右）——画布上的标识（如 teamB14）用户要靠它找框
    (function () {
      var byLabel = {};
      cur.boxes.forEach(function (b) {
        var k = b.label || '?';
        (byLabel[k] = byLabel[k] || []).push(b);
      });
      Object.keys(byLabel).forEach(function (k) {
        var arr = byLabel[k].slice().sort(function (a, b) { return a.cx - b.cx; });
        arr.forEach(function (b, i) { b.seq = i + 1; b.seqTotal = arr.length; });
      });
    })();
    if (maxDist == null) maxDist = 6;
    // 补框用的"存在性匹配"阈值：球员两帧间常移动 8~12%，6% 太紧会误报缺失
    if (presenceTol == null) presenceTol = Math.max(maxDist, 10);
    var prev = prevList || [], next = nextList || [];
    var curHuman = !!cur.human;

    function matchIn(frame, b) {
      if (!frame) return null;
      var best = null, bd = Infinity;
      for (var i = 0; i < frame.boxes.length; i++) {
        var p = frame.boxes[i];
        var sameNum = !!(p.number && b.number && p.number === b.number);
        // 球衣号码相同 → 就是同一个球员（标签里的序号 teamB4/teamB7 只是识别顺序，会变，不能当标识）
        if (!sameNum && p.label !== b.label) continue;
        var d = Math.sqrt((p.cx - b.cx) * (p.cx - p.cx) + (p.cy - b.cy) * (p.cy - b.cy));
        var tol = sameNum ? Math.max(maxDist, 25) : maxDist;
        if (d > tol) continue;
        var cost = (sameNum ? d * 0.25 : d) + (p.label === b.label ? -1 : 0);
        if (cost < bd) { bd = cost; best = p; }
      }
      return best;
    }

    // 该帧该用的权重：人工确认帧用 HUMAN_W_*（≈权威），机器帧用 W_PREV/W_NEXT（衰减）
    function wOf(frame, i, isPrev) {
      if (frame && frame.human) return wHuman(i, isPrev);
      return isPrev ? wPrev(i) : wNext(i);
    }

    // 号码加权投票 + 存在/不存在证据统计（附证据链：哪个帧、哪个框、距离多少）
    function votesFor(b) {
      var counts = {}, forW = 0, againstW = 0, humanFor = false, humanAgainst = false, evs = [];
      function scan(list, isPrev) {
        list.forEach(function (f, i) {
          var m = matchIn(f, b);
          var w = wOf(f, i, isPrev);
          if (m) {
            forW += w;
            if (f.human) humanFor = true;
            if (m.number) {
              counts[m.number] = (counts[m.number] || 0) + w;
              evs.push({
                side: isPrev ? 'prev' : 'next', idx: i, frameNo: (f.frameNo != null ? f.frameNo : null),
                label: m.label, num: String(m.number), cx: m.cx, cy: m.cy,
                d: Math.sqrt((m.cx - b.cx) * (m.cx - b.cx) + (m.cy - b.cy) * (m.cy - b.cy)),
                human: !!f.human, w: w
              });
            }
          } else {
            againstW += w;
            if (f.human) humanAgainst = true;
          }
        });
      }
      scan(prev, true);
      scan(next, false);
      var best = null, bw = 0;
      Object.keys(counts).forEach(function (k) { if (counts[k] > bw) { bw = counts[k]; best = k; } });
      // 证据链只保留"投给最终号码"的那些，按帧距排序（最近的帧最可信）
      var evidence = evs.filter(function (e) { return best != null && e.num === String(best); })
        .sort(function (a, c) { return ((a.side === 'prev' ? 0 : 1) - (c.side === 'prev' ? 0 : 1)) || (a.idx - c.idx); });
      return { best: best, bw: bw, forW: forW, againstW: againstW, humanFor: humanFor, humanAgainst: humanAgainst, evidence: evidence };
    }

    var out = [];
    // 同一支队（teamA/teamB/goalkeeperA）内球衣号码唯一——本帧已有同队同号的框？
    function idxOf(b) { for (var i = 0; i < cur.boxes.length; i++) { if (cur.boxes[i] === b) return i; } return -1; }
    function numTaken(label, num, exceptBox) {
      if (!num) return null;
      for (var i = 0; i < cur.boxes.length; i++) {
        var c = cur.boxes[i];
        if (c === exceptBox) continue;
        if (c.label === label && String(c.number) === String(num)) return c;
      }
      return null;
    }
    // 某帧里有没有"同队同号"的球员（号码是唯一标识，用来证明"这人其实在，只是移动了"）
    function numInFrame(frame, label, num) {
      if (!frame || !num) return null;
      for (var i = 0; i < frame.boxes.length; i++) {
        var p = frame.boxes[i];
        if (p.label === label && String(p.number) === String(num)) return p;
      }
      return null;
    }
    // 先对每个框算一次证据，先定"疑似误检"，再定号码——避免同一个框既提示删框又提示补号
    var boxVotes = cur.boxes.map(function (b, idx) { return { b: b, v: votesFor(b), idx: idx }; });
    var delSet = {};

    /* ================= 阶段 1：删框（先定删哪些，删完才谈补号/补框） ================= */
    // 规则 1：unknown 标签默认删除（可切换：面板底部「unknown:默认删/保留」）。
    //   用户口径（凉白开机器预测的 unknown 是垃圾框）：默认提示删除；关闭后按规则 3 与上一帧强比对处理。
    if (unknownDel) {
      boxVotes.forEach(function (item) {
        if (!/^unknown$/i.test(item.b.label || '')) return;
        if (delSet[item.idx]) return;
        delSet[item.idx] = true;
        out.push({
          type: 'del_box', box: item.b,
          conf: curHuman ? 'mid' : 'high',
          reason: '标签为 unknown（队别/号码都判不出），默认删除（可在底部「unknown」开关切换为保留）'
        });
      });
    }
    // 规则 2：同标签近距离重叠 → 同一球员被重复检测。
    //   **只有"同号"才是真重复**（同队球衣号不重复 → 两个框号码不同 = 两个不同的球员叠加，不能删！
    //    教训（6114 帧）：teamA#25 与 teamA#3 中心差 1.6%、teamB#18 与 teamB#15 差 2.1%，
    //    是两个球员站得近/遮挡，旧规则却挑了一个删 → 全部误伤）。
    for (var di = 0; di < cur.boxes.length; di++) {
      if (delSet[di]) continue;
      for (var dj = di + 1; dj < cur.boxes.length; dj++) {
        if (delSet[dj]) continue;
        var da = cur.boxes[di], db = cur.boxes[dj];
        if (da.label !== db.label) continue;
        // 两个都有号且号码不同 → 两个不同的球员（遮挡/站得近），跳过
        if (da.number && db.number && String(da.number) !== String(db.number)) continue;
        // 只有一个有号、另一个没号 → 存疑（可能重复也可能是两个人），交给人眼，不自动提示
        if (!da.number || !db.number) continue;
        var dd = Math.sqrt((da.cx - db.cx) * (da.cx - db.cx) + (da.cy - db.cy) * (da.cy - db.cy));
        if (dd > 4) continue;
        var victimIdx = (da.w * da.h <= db.w * db.h) ? di : dj;
        var victim = cur.boxes[victimIdx], keep = cur.boxes[victimIdx === di ? dj : di];
        delSet[victimIdx] = true;
        out.push({
          type: 'del_box', box: victim, conf: 'high',
          reason: '与 ' + keep.label + (keep.number ? ' #' + keep.number : '') +
            ' 中心仅差 ' + dd.toFixed(1) + '% 且标签、号码都相同 —— 同一球员被重复检测，建议删除此框'
        });
        break;
      }
    }
    // 规则 3（默认唯一的"疑似误检"来源）：**与上一帧强比对**
    //   上一帧这个位置上"没有任何框"（不论什么标签）→ 判定误检。
    //   · 位置上有框但标签不同 → 那是"改标签"候选（交给下面的 fix_label），不能当误检删掉
    //   · 球衣号码是唯一标识：上一帧里有同队同号（哪怕位置移动很大）→ 真人在移动，绝不删
    //   旧的多帧加权投票删（ratio<0.35）默认关掉——它会在每一帧刷出一大片"疑似误检"，
    //   用户明确要求"其他的我眼睛看一下吧"，只留与上一帧强比对这一条。
    var refFrame = prev[0] || null, refIsPrev = true;
    if (!refFrame && next.length) { refFrame = next[0]; refIsPrev = false; }
    if (refFrame) {
      boxVotes.forEach(function (item) {
        if (delSet[item.idx]) return;
        var b = item.b;
        // 号码唯一标识：上一帧出现过同队同号 → 真人在移动
        if (b.number && numInFrame(refFrame, b.label, b.number)) return;
        // 位置上有任何框（不论标签）→ 不是误检
        var nearD = Infinity;
        for (var fi = 0; fi < refFrame.boxes.length; fi++) {
          var p = refFrame.boxes[fi];
          var sameNum = !!(p.number && b.number && String(p.number) === String(b.number));
          var d0 = Math.sqrt((p.cx - b.cx) * (p.cx - b.cx) + (p.cy - b.cy) * (p.cy - b.cy));
          if (d0 > (sameNum ? Math.max(presenceTol, 25) : presenceTol)) continue;
          if (d0 < nearD) nearD = d0;
        }
        if (nearD < Infinity) return;
        delSet[item.idx] = true;
        out.push({
          type: 'del_box', box: b,
          conf: refFrame.human ? 'high' : 'mid',
          reason: '与' + (refIsPrev ? '上一帧' : '下一帧') + (refFrame.human ? '（人工标注）' : '') +
            '强比对：该帧 ' + b.cx.toFixed(0) + '%,' + b.cy.toFixed(0) + '% 附近（容差 ' +
            presenceTol + '%）没有任何框，本帧却有 ' + b.label +
            (b.number ? ' #' + b.number : '') + ' → 判定为误检，建议删除'
        });
      });
    }
    // 规则 4（宽松模式，默认关闭；面板「删框:严格/宽松」可切换）：
    //   所有邻帧同位置都没有 → 才提示一件。比旧的 ratio<0.35 收敛得多，仅作兜底。
    if (delMode === 'loose') {
      boxVotes.forEach(function (item) {
        if (delSet[item.idx]) return;
        var v = item.v;
        if (v.forW > 0) return;                 // 任何邻帧有 → 不提示，交给人眼
        if (!(v.forW + v.againstW)) return;     // 根本没有邻帧数据
        delSet[item.idx] = true;
        out.push({
          type: 'del_box', box: item.b, conf: v.humanAgainst ? 'mid' : 'low',
          reason: '宽松模式：所有相邻帧同位置都没有此框（证据缺失，请自行确认）'
        });
      });
    }

    // 改标签：上一帧同位置是另一个标签（且号码对得上）→ 本帧标签判错了，改标签即可
    // （实例：6006 的两个框被判成 unknown，上一帧同位置是 teamB15 → 应"改标签"而不是"删了再补"）
    if (prev.length) {
      cur.boxes.forEach(function (c) {
        if (delSet[cur.boxes.indexOf(c)]) return;
        var pb = null, bd = Infinity;
        prev[0].boxes.forEach(function (p) {
          var d = Math.sqrt((p.cx - c.cx) * (p.cx - c.cx) + (p.cy - c.cy) * (p.cy - c.cy));
          var sameNum = !!(p.number && c.number && p.number === c.number);
          var tol = sameNum ? Math.max(maxDist, 25) : presenceTol;
          if (d > tol) return;
          if (d < bd) { bd = d; pb = p; }
        });
        if (!pb || pb.label === c.label) return;
        var sameNum2 = !!(pb.number && c.number && pb.number === c.number);
        if (!sameNum2 && !pb.number) return;   // 上一帧也没号 → 不敢断定是同一个人
        if (delSet[cur.boxes.indexOf(c)]) return;
        delSet[cur.boxes.indexOf(c)] = true;
        out.push({
          type: 'fix_label', box: c, label: pb.label, number: pb.number || c.number || '',
          conf: sameNum2 ? 'high' : 'mid',
          reason: '上一帧同位置（相距 ' + bd.toFixed(1) + '%）是 ' + pb.label +
            (pb.number ? ' #' + pb.number : '') + '，本帧标成 ' + c.label +
            ' —— 标签判错，改成 ' + pb.label + ' 即可（比删了再补更稳）'
        });
      });
    }

    // 号码类建议：疑似误检的框不再补号/改号；当前帧人工确认的不擅自改
    boxVotes.forEach(function (item) {
      var b = item.b, v = item.v;
      if (delSet[item.idx]) return;
      if (/^unknown$/i.test(b.label || '')) return;   // unknown 框由删框/改标签接管，不提补号
      if (!b.number) {
        // 号码唯一：本帧同队已经有人用了这个投票号码 → 不能补（补了就是重复号），改为让人填
        var takenBy = (v.best && v.bw >= 0.1) ? numTaken(b.label, v.best, b) : null;
        if (takenBy) {
          out.push({
            type: 'need_number', box: b, conf: 'low', hint: '',
            reason: '本帧缺号；邻帧投票给的 ' + v.best + ' 号已被同队 ' +
              takenBy.cx.toFixed(0) + '%,' + takenBy.cy.toFixed(0) + '% 的框占用（同队球衣号不重复）——请人工填号'
          });
        } else if (v.bw >= 0.4) {
          out.push({ type: 'fill_number', box: b, number: v.best, conf: 'high', evidence: v.evidence, reason: (v.humanFor ? '人工确认帧' : '相邻帧') + '同位置号码为 ' + v.best + '（权重 ' + v.bw.toFixed(2) + '）' });
        } else if (v.bw >= 0.1) {
          out.push({ type: 'fill_number', box: b, number: v.best, conf: 'mid', evidence: v.evidence, reason: '较远邻帧同位置多为 ' + v.best + '（权重仅 ' + v.bw.toFixed(2) + '，请斟酌）' });
        } else {
          // 邻帧完全匹配不到号码 → 也必须标出来（场上不允许存在无号码的框）
          // hint：邻帧弱证据里最可能的号（权重不足不出补号建议，但可以预填在下拉里供人参考）
          out.push({ type: 'need_number', box: b, conf: 'low', hint: v.best || '', reason: '本帧缺号，邻帧也未匹配到号码——请人工补号' });
        }
      }
      if (!curHuman && v.best && v.best !== b.number) {
        // 改号必须双保险（6451 帧教训：后帧凉白开的 0.17 弱投票就把已填的 46 改成 31）：
        //   ① 权重 ≥0.4（有相邻帧背书，弱投票一律不动已填的号）
        //   ② 至少一帧**人工数据**支持新号（机器 vs 机器的分歧不配改号）
        var humanBacked = (v.evidence || []).some(function (e) { return e.human; });
        if (v.bw >= 0.4 && humanBacked) {
          out.push({ type: 'fix_number', box: b, number: v.best, conf: 'high', evidence: v.evidence, reason: (v.humanFor ? '人工确认帧' : '相邻帧') + '同位置均为 ' + v.best + '（权重 ' + v.bw.toFixed(2) + '），本帧为 ' + b.number });
        }
      }
    });

    // 补框：前侧或后侧任一有相邻帧即可作为候选来源
    var src = prev[0] || next[0];
    if (src) {
      // 一对一贪心匹配：同一个"当前帧框"只能配一个"上一帧框"（距离最近的优先）。
      // 否则叠加的两名球员会被误判成"已经配上了"（实例：5873 的 teamA#?@(99,41) 被 5874 的
      // teamA#8@(97,45) 抢先配上，而 teamA#8 真正该配的是 5873 的 teamA#8@(97,45)）。
      var pairs = [];
      src.boxes.forEach(function (p, pi) {
        if (/^unknown$/i.test(p.label || '')) return;
        cur.boxes.forEach(function (c, ci) {
          var sameNum = !!(p.number && c.number && p.number === c.number);
          // unknown 框也算"占着位置"（没认出队别的真人）：按位置就能配对，别再提示补框重复加一个
          var cIsUnk = /^unknown$/i.test(c.label || '');
          if (!sameNum && c.label !== p.label && !cIsUnk) return;
          var d = Math.sqrt((c.cx - p.cx) * (c.cx - p.cx) + (c.cy - p.cy) * (c.cy - p.cy));
          var tol = sameNum ? Math.max(presenceTol, 25) : presenceTol;
          if (d > tol) return;
          pairs.push({ pi: pi, ci: ci, d: sameNum ? d * 0.25 : d });
        });
      });
      pairs.sort(function (a, b) { return a.d - b.d; });
      var usedPrev = {}, usedCur = {};
      pairs.forEach(function (pr) {
        if (usedPrev[pr.pi] || usedCur[pr.ci]) return;
        usedPrev[pr.pi] = true; usedCur[pr.ci] = true;
      });
      src.boxes.forEach(function (p, pi) {
        if (/^unknown$/i.test(p.label || '')) return; // unknown 框不拿来当补框候选
        if (usedPrev[pi]) return;
        // 位置只取**紧邻帧**（上一帧/下一帧）的匹配位置做平均：
        // 球员在跑动时，3-5 帧前的位置早就过时了（6331 帧实锤：贴边 teamA#8 真实在 x≈99.4，
        // 全窗口平均算出 90.7）。更远的帧只参与号码投票，不参与定位。
        var xs = 0, ys = 0, ws = 0, hs = 0, wsum = 0, nums = {}, cnt = 0, presPrev = 0, presNext = 0, humanFor = false;
        prev.forEach(function (f, i) {
          var m = matchIn(f, p);
          if (m) {
            var w = wOf(f, i, true);
            if (i === 0) { xs += m.x; ys += m.y; ws += m.w; hs += m.h; wsum += 1; }
            cnt++; presPrev += w;
            if (f.human) humanFor = true;
            if (m.number) nums[m.number] = (nums[m.number] || 0) + w;
          }
        });
        next.forEach(function (f, i) {
          var m = matchIn(f, p);
          if (m) {
            var w = wOf(f, i, false);
            if (i === 0) { xs += m.x; ys += m.y; ws += m.w; hs += m.h; wsum += 1; }
            cnt++; presNext += w;
            if (f.human) humanFor = true;
            if (m.number) nums[m.number] = (nums[m.number] || 0) + w;
          }
        });
        // 补框门槛：左侧（上一帧）必须有；右侧有就是"确定漏检"（高置信），
        // 右侧没有就是"可能进场/退场"（中置信，仍然标出来供人判断）
        var hasPrev1 = prev[0] ? !!matchIn(prev[0], p) : false;
        var hasNext1 = next[0] ? !!matchIn(next[0], p) : false;
        if (!hasPrev1 || !cnt) return;
        // 人工帧上若只有机器证据 → 仍要提示（用户要求"缺框就说"），但降为中置信并注明
        var machineOnly = curHuman && !humanFor;
        var num = '', bn = 0;
        Object.keys(nums).forEach(function (k) { if (nums[k] > bn) { bn = nums[k]; num = k; } });
        // 上一帧同位置到底有没有匹配到、有没有号码 —— 决定提示文案，也决定要不要兜底找号
        var p0 = prev[0] ? matchIn(prev[0], p) : null;
        var prevHadBox = !!p0;
        var prevNum = (p0 && p0.number) ? String(p0.number) : '';
        var numFrom = '';
        if (num) {
          numFrom = '相邻帧同位置号码投票';
        } else if (prevNum) {
          num = prevNum; numFrom = '上一帧同位置';
        } else {
          // 兜底：在前后帧里找"同队、离得最近且有号码"的框，作为参考号码
          var ref = null, refD = 1e9;
          prev.concat(next).forEach(function (f) {
            (f.boxes || []).forEach(function (b) {
              if (b.label !== p.label || !b.number) return;
              var d = Math.sqrt((b.cx - p.cx) * (b.cx - p.cx) + (b.cy - p.cy) * (b.cy - p.cy));
              if (d < 12 && d < refD) { refD = d; ref = b; }
            });
          });
          if (ref) { num = String(ref.number); numFrom = '就近同队框参考（相距 ' + refD.toFixed(1) + '%）'; }
        }
        // 号码唯一性：本帧同队已经有人用这个号 → 不是"漏检"，是重复/误检，不补
        if (num && numTaken(p.label, num, null)) return;
        // 删框先定、补框后算：补的位置若正好压在一个"待删框"上 → 不补（否则删了又补，白打架）
        var ncx = xs / wsum + (ws / wsum) / 2, ncy = ys / wsum + (hs / wsum) / 2, clashDel = false;
        cur.boxes.forEach(function (c, ci) {
          if (clashDel || !delSet[ci]) return;
          var dcd = Math.sqrt((c.cx - ncx) * (c.cx - ncx) + (c.cy - ncy) * (c.cy - ncy));
          if (dcd < 6) clashDel = true;
        });
        if (clashDel) return;
        var conf0 = machineOnly ? 'mid' : (hasNext1 ? 'high' : 'mid');
        out.push({
          type: 'add_box', conf: conf0,
          box: { label: p.label, x: xs / wsum, y: ys / wsum, w: ws / wsum, h: hs / wsum, cx: xs / wsum + ws / wsum / 2, cy: ys / wsum + hs / wsum / 2, number: num, numFrom: numFrom, prevHadBox: prevHadBox, prevNum: prevNum },
          reason: (hasNext1
            ? '上一帧与下一帧同位置都有 ' + p.label + (num ? ' #' + num : '') + '，本帧缺失（疑似漏检）'
            : '上一帧同位置有 ' + p.label + (num ? ' #' + num : '') + '，本帧没有（漏检或已退场，请判断）') +
            (machineOnly ? '；注意：本帧是人工标注，邻帧只有机器预测证据，请确认是否漏标' : '') +
            (num ? '；号码来源：' + numFrom : (prevHadBox ? '；上一帧该框没有号码' : '；上一帧同位置没匹配到该框'))
        });
      });
    }
    return out;
  }

  /* 把本地修正后的 result 包装成"伪 task"（人工确认性质，权重按人工算） */
  function wrapLocalResult(result, name) {
    return { __local: true, __human: true, predictions: [{ model_version: name || '本地修正版', result: result }], annotations: [] };
  }

  /*
   * 把已确认的建议应用到原始 LS result 数组，生成可回写的 result。
   * result: task.annotation/prediction 的 result 原样数组；applied: 建议数组（已确认的那些）。
   */
  function buildCorrectedResult(origResult, applied) {
    var res = JSON.parse(JSON.stringify(origResult || []));
    var rectTpl = null, textTpl = null, textUsesParent = false;
    for (var i = 0; i < res.length; i++) {
      if (res[i].type === 'rectanglelabels' && !rectTpl) rectTpl = res[i];
      if (res[i].type === 'textarea' && !textTpl) {
        textTpl = res[i];
        textUsesParent = res[i].parent_id != null;
      }
    }
    // 找某框的号码框：同 id，或 parent_id 指向它（编辑器写法）
    // number 类型（机器预测继承的号码标签）也算号码框
    function findText(rid) {
      for (var k = 0; k < res.length; k++) {
        var r = res[k];
        if (r.type !== 'textarea' && r.type !== 'number') continue;
        if (r.id === rid) return r;
        if (r.parent_id != null && r.parent_id === rid) return r;
      }
      return null;
    }
    function newId() { return 'lsfi_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
    // 按现有写法新建号码框（人工标注是 parent_id 式，机器预测是同 id 式）
    function makeText(rid, num) {
      var t = { type: 'textarea', from_name: textTpl.from_name, to_name: textTpl.to_name, value: { text: [num] } };
      if (textUsesParent) { t.id = newId(); t.parent_id = rid; }
      else t.id = rid;
      return t;
    }

    // 同队球衣号码唯一：写入时如发现重复，跳过并记录（防止批量应用造出重复号）
    var dupSkipped = [];
    var usedNums = {};
    for (var ui = 0; ui < res.length; ui++) {
      var ur = res[ui];
      if (ur.type !== 'rectanglelabels') continue;
      var lab = (ur.value && ur.value.rectanglelabels && ur.value.rectanglelabels[0]) || '';
      var tx = null;
      for (var tj = 0; tj < res.length; tj++) {
        var t2 = res[tj];
        if (t2.type !== 'textarea' && t2.type !== 'number') continue;
        if (String(t2.id) === String(ur.id) || (t2.parent_id != null && String(t2.parent_id) === String(ur.id))) { tx = t2; break; }
      }
      var num2 = '';
      if (tx && tx.type === 'number' && tx.value && tx.value.number != null) num2 = String(tx.value.number).trim();
      else if (tx && tx.value && tx.value.text) num2 = String(tx.value.text[0] || '').trim();
      if (lab && num2) usedNums[lab + '|' + num2] = true;
    }

    for (var j = 0; j < applied.length; j++) {
      var s = applied[j];
      if ((s.type === 'fill_number' || s.type === 'fix_number') && s.number) {
        var key = (s.box.label || '') + '|' + String(s.number);
        if (usedNums[key]) {
          dupSkipped.push({ box: s.box, number: s.number });
          continue;   // 同队已有这个号 → 跳过，不写入
        }
        usedNums[key] = true;
      }
      if (s.type === 'fill_number' || s.type === 'fix_number') {
        var rid = s.box.rid;
        var t = findText(rid);
        if (t && t.type === 'number') {
          // number 类型号码框：只改 value.number，保留它的位置字段
          t.value = t.value || {};
          t.value.number = Number(s.number);
        } else if (t) {
          t.value = { text: [s.number] };
        } else if (textTpl) {
          res.push(makeText(rid, s.number));
        }
      } else if (s.type === 'fix_label') {
        // 改标签：只改 rectanglelabels 的取值，号码/位置不动
        for (var q = 0; q < res.length; q++) {
          if (res[q].type !== 'rectanglelabels') continue;
          if (String(res[q].id) !== String(s.box.rid)) continue;
          res[q].value = res[q].value || {};
          res[q].value.rectanglelabels = [s.label];
          break;
        }
      } else if (s.type === 'del_box') {
        // 框和它的号码框一起删（号码框可能是 parent_id 挂法）
        res = res.filter(function (r) { return r.id !== s.box.rid && r.parent_id !== s.box.rid; });
      } else if (s.type === 'add_box') {
        if (!rectTpl) continue;
        var nid = newId();
        res.push({
          id: nid, type: 'rectanglelabels',
          from_name: rectTpl.from_name, to_name: rectTpl.to_name,
          value: { x: s.box.x, y: s.box.y, width: s.box.w, height: s.box.h, rectanglelabels: [s.box.label] }
        });
        if (s.box.number && textTpl) res.push(makeText(nid, s.box.number));
      }
    }
    if (dupSkipped.length) { try { res.__dupSkipped = dupSkipped; } catch (e) { } }
    return res;
  }

  /*
   * 跳转搜索辅助：按帧号估算列表页码（页内帧均匀分布时），以及探测页码顺序。
   */
  function estimatePage(frame, pageSize) {
    pageSize = pageSize || 100;
    var f = Number(frame);
    if (!isFinite(f) || f < 0) return 1;
    return Math.floor(f / pageSize) + 1;
  }

  function probeOrder(est, spread) {
    spread = spread || 2;
    est = Number(est) || 1;
    var out = [est];
    for (var d = 1; d <= spread; d++) {
      if (est - d >= 1) out.push(est - d);
      out.push(est + d);
    }
    return out;
  }

  /* 从当前帧向某一侧找最近的未提交帧（submitted: {帧号: bool}） */
  function nextUnsubmitted(fromFrame, submitted, dir, limit) {
    if (!submitted) return null;
    dir = dir || 1; limit = limit || 300;
    var f = Number(fromFrame) + dir;
    if (!isFinite(f)) return null;
    var end = f + dir * limit;
    while (dir > 0 ? f <= end : f >= end) {
      if (submitted[f] === false) return f;
      f += dir;
    }
    return null;
  }

  /*
   * 运动连续性检测：对比当前帧与前一帧同位置框的位移/大小变化。
   * 帧间差距小 = 正常移动；差距大 = 疑似问题（跳变/误检/身份错配）。
   * 返回 [{box, prev, dist, sizeRatio, level, reason}]，level: ok 不返回 / fast / jump
   * 距离单位为百分比（0-100）。默认：位移 >3%=跳变，>1.5%=偏快，面积变化 >40%=异常。
   */
  function motionCheck(cur, prev, opts) {
    if (!cur || !prev) return [];
    opts = opts || {};
    var maxDist = opts.maxDist != null ? opts.maxDist : 6;
    var wideDist = opts.wideDist != null ? opts.wideDist : 20; // 松匹配：抓大跳变
    var jumpAt = opts.jumpAt != null ? opts.jumpAt : 3;
    var fastAt = opts.fastAt != null ? opts.fastAt : 1.5;
    var sizeJump = opts.sizeJump != null ? opts.sizeJump : 0.4;

    function findMatch(b, radius) {
      var best = null, bd = Infinity, sameNum = false;
      prev.boxes.forEach(function (p) {
        if (p.label !== b.label) return;
        var d = Math.sqrt((p.cx - b.cx) * (p.cx - b.cx) + (p.cy - b.cy) * (p.cy - b.cy));
        if (d > radius) return;
        var cost = d + (p.number && b.number && p.number === b.number ? -2 : 0);
        if (cost < bd) { bd = cost; best = p; sameNum = !!(p.number && b.number && p.number === b.number); }
      });
      return best ? { box: best, sameNum: sameNum } : null;
    }

    var out = [];
    cur.boxes.forEach(function (b) {
      // 先紧匹配（正常移动），配不上再松匹配（大跳变也要抓出来）
      var m = findMatch(b, maxDist) || findMatch(b, wideDist);
      if (!m) return; // 本帧新增的框由 add_box 逻辑负责
      var best = m.box, sameNum = m.sameNum;
      var dist = Math.sqrt((best.cx - b.cx) * (best.cx - b.cx) + (best.cy - b.cy) * (best.cy - b.cy));
      var prevArea = best.w * best.h;
      var sizeRatio = prevArea > 0 ? Math.abs(b.w * b.h - prevArea) / prevArea : 0;
      var level = 'ok';
      var reasons = [];
      if (dist > jumpAt) { level = 'jump'; reasons.push('位移 ' + dist.toFixed(1) + '%（阈值 ' + jumpAt + '%）'); }
      else if (dist > fastAt) { level = 'fast'; reasons.push('位移 ' + dist.toFixed(1) + '% 偏快'); }
      if (sizeRatio > sizeJump) {
        if (level === 'ok') level = 'fast';
        reasons.push('框面积变化 ' + (sizeRatio * 100).toFixed(0) + '%');
      }
      if (!sameNum && best.number && b.number && best.number !== b.number) {
        if (level !== 'jump') level = 'fast';
        reasons.push('同位置号码由 ' + best.number + ' 变为 ' + b.number + '（身份错配？）');
      }
      if (level !== 'ok') {
        out.push({ box: b, prev: best, dist: dist, sizeRatio: sizeRatio, level: level, reason: reasons.join('；') });
      }
    });
    // 跳变排前面
    out.sort(function (a, b2) { return (a.level === 'jump' ? 0 : 1) - (b2.level === 'jump' ? 0 : 1); });
    return out;
  }

  // 解析统计（诊断用：到底读到了几个框、几个有号、几个文本控件）
  function parseSourceStats(task, kind, index) {
    var arr = kind === 'prediction' ? task.predictions
      : (kind === 'draft' ? (task.drafts || []) : task.annotations);
    var s = arr && arr[index];
    if (!s || !Array.isArray(s.result)) return null;
    var rect = 0, texts = 0, matched = 0;
    for (var i = 0; i < s.result.length; i++) {
      var r = s.result[i];
      if (!r) continue;
      if (r.type === 'rectanglelabels') rect++;
      else if (r.type === 'textarea' || r.type === 'text' || r.type === 'richtext' || r.type === 'number') texts++;
    }
    var src = parseSource(task, kind, index);
    if (src) matched = src.boxes.filter(function (b) { return b.number; }).length;
    return { rects: rect, texts: texts, withNumber: matched, total: src ? src.boxes.length : 0 };
  }

  return {
    CORE_BUILD: CORE_BUILD,
    LABEL_ORDER: LABEL_ORDER,
    parseSource: parseSource,
    parseSourceStats: parseSourceStats,
    diffBoxes: diffBoxes,
    qcIssues: qcIssues,
    labelCounts: labelCounts,
    fmtBox: fmtBox,
    summarize: summarize,
    suggestFixes: suggestFixes,
    suggestFixesWindow: suggestFixesWindow,
    bestSourceOf: bestSourceOf,
    bestHumanSourceOf: bestHumanSourceOf,
    wrapLocalResult: wrapLocalResult,
    buildCorrectedResult: buildCorrectedResult,
    estimatePage: estimatePage,
    probeOrder: probeOrder,
    nextUnsubmitted: nextUnsubmitted,
    motionCheck: motionCheck
  };
});
