/*
 * LS 帧检助手 · 共享回写模块（api.js）
 * content.js（侧栏）与 viewer.js（独立查看窗）共用。
 * 只提供：CSRF、通用写请求、项目配置解析、把确认过的建议应用到 task 并回写。
 * 回写规则：只写当前这一个 task；有人工标注走 PATCH，没有则基于机器预测新建（POST）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LSFI_API = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function csrfToken() {
    var m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function apiWrite(url, method, body) {
    return fetch(url, {
      method: method,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRFToken': csrfToken(),
        'X-LSFI': '1'
      },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { }
        return { ok: r.ok, status: r.status, body: j || t };
      });
    });
  }

  function parseLabelConfig(xml) {
    function attrs(tag) {
      var re = new RegExp('<' + tag + '\\b[^>]*>', 'g'), m, out = [];
      while ((m = re.exec(xml))) out.push(m[0]);
      return out;
    }
    function a(s, name) { var m = s.match(new RegExp('\\b' + name + '="([^"]*)"')); return m ? m[1] : null; }
    var rects = attrs('RectangleLabels'), texts = attrs('TextArea');
    return {
      rect: rects.length ? { from_name: a(rects[0], 'name'), to_name: a(rects[0], 'to_name') } : null,
      text: texts.length ? { from_name: a(texts[0], 'name'), to_name: a(texts[0], 'to_name') } : null
    };
  }

  function projectIdFromPath() {
    return (location.pathname.match(/\/projects\/(\d+)/) || [])[1] || null;
  }

  /*
   * 把确认过的建议应用到 task 并回写。
   * task: 完整 task 对象（含 annotations/drafts/predictions）；list: 已确认的建议数组；
   * buildCorrected: core.js 的函数（注入，避免循环依赖）；
   * annIndex: 要修改的标注下标；workSrc: {kind:'annotation'|'draft', index} ——
   *   **写入目标必须与"读取建议时用的那份数据"一致**（草稿读的写草稿，标注读的写标注），
   *   否则删框/改号会落在另一份数据上而失效（框的 id 对不上）。
   * 返回 Promise<{ok, status, body, corrected}>；成功后对应数据源已被就地更新。
   */
  function applyToTask(task, list, buildCorrected, apiBase, annIndex, workSrc) {
    apiBase = apiBase || (location.origin + '/api');
    var drafts = task.drafts || [], anns = task.annotations || [];
    // 草稿路径：读取来源是草稿 → PATCH 该草稿（保持草稿状态，用户自己点 Submit）
    if (workSrc && workSrc.kind === 'draft' && drafts[workSrc.index] && drafts[workSrc.index].id) {
      var dr = drafts[workSrc.index];
      var correctedD = buildCorrected(dr.result || [], list);
      return apiWrite(apiBase + '/drafts/' + dr.id + '/', 'PATCH', { result: correctedD }).then(function (res) {
        if (res.ok) dr.result = correctedD;
        return { ok: res.ok, status: res.status, body: res.body, corrected: correctedD };
      });
    }
    var hasAnn = !!anns.length;
    var idx = (hasAnn && annIndex != null && anns[annIndex]) ? annIndex : 0;
    var base = hasAnn
      ? anns[idx].result
      : (task.predictions && task.predictions.length ? task.predictions[task.predictions.length - 1].result : []);
    var corrected = buildCorrected(base, list);

    var chain;
    if (hasAnn) {
      chain = apiWrite(apiBase + '/annotations/' + anns[idx].id + '/', 'PATCH', { result: corrected });
    } else {
      var pid = projectIdFromPath();
      chain = fetch(apiBase + '/projects/' + pid, { credentials: 'include', headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (proj) {
          var cfg = parseLabelConfig(proj.label_config || '');
          if (!cfg.rect) throw new Error('无法从项目配置解析标签字段名');
          corrected.forEach(function (item) {
            if (item.type === 'rectanglelabels') { item.from_name = item.from_name || cfg.rect.from_name; item.to_name = item.to_name || cfg.rect.to_name; }
            if (item.type === 'textarea' && cfg.text) { item.from_name = item.from_name || cfg.text.from_name; item.to_name = item.to_name || cfg.text.to_name; }
          });
          return apiWrite(apiBase + '/tasks/' + task.id + '/annotations', 'POST', { result: corrected });
        });
    }
    return chain.then(function (res) {
      if (res.ok) {
        if (hasAnn) task.annotations[idx].result = corrected;
        else if (res.body && res.body.id) task.annotations = [res.body];
      }
      return { ok: res.ok, status: res.status, body: res.body, corrected: corrected };
    });
  }

  return {
    csrfToken: csrfToken,
    apiWrite: apiWrite,
    parseLabelConfig: parseLabelConfig,
    projectIdFromPath: projectIdFromPath,
    applyToTask: applyToTask
  };
});
