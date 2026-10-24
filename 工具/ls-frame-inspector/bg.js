/*
 * LS 帧检助手 · 后台（bg.js）
 * 原则：**绝不崩溃**——所有 chrome.* 调用都先判存在。
 * 功能：
 *   1) 点工具栏图标 → 注入 core/api/content → 打开面板；**结果直接显示在图标上**（OK / ! + 悬停说明）；
 *   2) 安装/启动时检查已打开的平台页，脚本缺失就补注入，版本不一致才重载。
 */
var MATCHES = [
  'http://58.247.144.181:18099/*',
  'https://58.247.144.181:18099/*',
  'http://localhost/*',
  'http://127.0.0.1/*'
];
var FILES = ['core.js', 'api.js', 'content.js'];

// 把结果写在图标上，并写进悬停标题（用户不用开控制台就能看到原因）
function report(state, detail) {
  var text = state === 'ok' ? 'OK' : (state === 'busy' ? '…' : '!');
  var color = state === 'ok' ? '#0e8a5f' : (state === 'busy' ? '#2456c8' : '#c0392b');
  try { if (chrome.action && chrome.action.setBadgeText) chrome.action.setBadgeText({ text: text }); } catch (e) { }
  try { if (chrome.action && chrome.action.setBadgeBackgroundColor) chrome.action.setBadgeBackgroundColor({ color: color }); } catch (e) { }
  try {
    if (chrome.action && chrome.action.setTitle) {
      chrome.action.setTitle({ title: '帧检助手 · ' + (detail || '') });
    }
  } catch (e) { }
  console.log('[帧检助手/bg] ' + state + ' ' + (detail || ''));
}

function inject(tabId) {
  if (!chrome.scripting || !chrome.scripting.executeScript) return Promise.reject(new Error('缺少 scripting 权限'));
  return chrome.scripting.executeScript({ target: { tabId: tabId }, files: FILES });
}

// 往页面里放一条可见横幅，证明"后台→页面"这条链路通了
function banner(tabId, text, color) {
  if (!chrome.scripting || !chrome.scripting.executeScript) return Promise.resolve();
  return chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: function (msg, bg) {
      try {
        var old = document.getElementById('lsfi-diag-banner');
        if (old) old.remove();
        var d = document.createElement('div');
        d.id = 'lsfi-diag-banner';
        d.textContent = msg;
        d.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:2147483647;' +
          'background:' + bg + ';color:#fff;font:12px -apple-system,"PingFang SC",sans-serif;' +
          'padding:6px 14px;border-radius:14px;box-shadow:0 4px 14px rgba(0,0,0,.25);pointer-events:none';
        document.body.appendChild(d);
        setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 4000);
        return 'banner-ok';
      } catch (e) { return 'banner-fail:' + e.message; }
    },
    args: [text, color]
  });
}

function openPanel(tabId) {
  if (!chrome.scripting || !chrome.scripting.executeScript) return Promise.reject(new Error('缺少 scripting 权限'));
  return chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: function () {
      return (typeof window.__LSFI_OPEN === 'function') ? window.__LSFI_OPEN() : 'no-script';
    }
  });
}

function verify() {
  try {
    if (!chrome.tabs || !chrome.tabs.query || !chrome.scripting) return;
    var ver = chrome.runtime.getManifest().version;
    chrome.tabs.query({ url: MATCHES }, function (tabs) {
      (tabs || []).forEach(function (tab) {
        if (!tab || !tab.id) return;
        try {
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: function () { return window.__LSFI_VER || null; }
          }).then(function (results) {
            var v = (results && results[0]) ? results[0].result : null;
            if (v === ver) return;
            if (v == null) {
              inject(tab.id).then(function () { return openPanel(tab.id); }).catch(function () { });
              return;
            }
            try { chrome.tabs.reload(tab.id); } catch (e) { }
          }).catch(function () { });
        } catch (e) { }
      });
    });
  } catch (e) { }
}

// 图标点击：注入 + 打开 + 把结果写回图标
try {
  if (chrome.action && chrome.action.onClicked) {
    chrome.action.onClicked.addListener(function (tab) {
      if (!tab || !tab.id) { report('err', '没有可用的标签页'); return; }
      report('busy', '正在打开…');
      var url = tab.url || '';
      var allowed = MATCHES.some(function (m) {
        var p = m.replace(/\*/g, '');
        return url.indexOf(p.replace(/\/$/, '')) === 0;
      });
      if (!allowed) {
        report('err', '当前页面不在授权范围：' + url);
        return;
      }
      // 先看页面里有没有脚本在跑：有就只开面板，**绝不重复注入**
      // （重复注入会让新旧两个实例并存，互相删面板、版本号跳来跳去）
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function () { return window.__LSFI_VER || null; }
      }).then(function (res) {
        var has = (res && res[0]) ? res[0].result : null;
        if (has) {
          return openPanel(tab.id).then(function (r) {
            var v = (r && r[0]) ? r[0].result : '';
            if (v === 'ok') report('ok', '面板已打开（页面脚本 v' + has + '）');
            else report('ok', '脚本在跑（v' + has + '），若面板没出来请按 F5');
          }).catch(function (e) {
            report('err', '打开失败：' + (e && e.message ? e.message : e));
          });
        }
        return inject(tab.id).then(function () {
          return banner(tab.id, '帧检助手：脚本已注入 ✓', '#0e8a5f');
        }).then(function () {
          return openPanel(tab.id);
        }).then(function (r) {
          var res2 = (r && r[0]) ? r[0].result : '';
          if (res2 === 'ok') report('ok', '已打开面板');
          else if (res2 === 'no-script') report('err', '脚本注入了但未初始化（请 F5 后重试）');
          else report('ok', String(res2 || '已注入'));
        }).catch(function (e) {
          report('err', '注入失败：' + (e && e.message ? e.message : e));
          banner(tab.id, '帧检助手注入失败：' + (e && e.message ? e.message : e), '#c0392b').catch(function () { });
        });
      }).catch(function (e) {
        report('err', '检查失败：' + (e && e.message ? e.message : e));
      });
    });
  }
} catch (e) { }

try { chrome.runtime.onInstalled.addListener(function () { report('ok', '已安装/更新到 v' + chrome.runtime.getManifest().version); verify(); }); } catch (e) { }
try { chrome.runtime.onStartup.addListener(function () { verify(); }); } catch (e) { }
