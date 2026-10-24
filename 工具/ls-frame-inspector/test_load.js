/*
 * 加载自检：在最小 DOM 桩里真实执行 core.js / api.js / content.js，
 * 断言"脚本确实跑到底了"（版本标记已设置、常驻标志已创建、__LSFI_OPEN 可用）。
 * 用途：防止再出现"顶层多余 return / 括号失衡"之类导致整段代码不执行的坑。
 *   node test_load.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function el(tag) {
  const n = {
    tagName: (tag || 'div').toUpperCase(), children: [], style: {}, dataset: {},
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] == null ? null : this._attrs[k]; },
    removeAttribute(k) { delete this._attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { return c; }, remove() { }, insertBefore(c) { this.children.push(c); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 340, bottom: 340, right: 600 }; },
    closest() { return null; }, contains() { return false; }, focus() { }, click() { },
    attachShadow() { const s = el('shadow'); s.getElementById = () => el('stub'); return s; },
    get firstChild() { return this.children[0] || null; },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; },
    set textContent(v) { this._txt = v; }, get textContent() { return this._txt || ''; },
    set className(v) { this._cn = v; }, get className() { return this._cn || ''; }
  };
  return n;
}

const version = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')).version;
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name); }
}

const doc = {
  readyState: 'complete', body: el('body'), head: el('head'), documentElement: el('html'),
  createElement: el, createElementNS: (ns, t) => el(t), createTextNode: (t) => ({ textContent: t }),
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  addEventListener() { }, removeEventListener() { }, contains: () => false, activeElement: null
};
const chromeStub = {
  runtime: { id: 'x', getManifest: () => ({ version }), sendMessage: (m, cb) => cb && cb({ version }), onMessage: { addListener() { } }, lastError: null },
  storage: { session: { get: (k, cb) => cb && cb({}), set() { }, remove() { } }, local: { get: (k, cb) => cb && cb({}), set() { } } }
};
const sb = {
  console: { log() { }, warn() { }, error() { }, info() { } },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval, Promise, JSON, Math, Date, Object, Array,
  String, Number, Boolean, RegExp, Error, Map, Set, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  location: { href: 'http://YOUR_LABEL_STUDIO_HOST/projects/7/data?task=1', origin: 'http://YOUR_LABEL_STUDIO_HOST', pathname: '/projects/7/data', search: '?task=1' },
  document: doc, chrome: chromeStub, navigator: { clipboard: null, userAgent: 'node' },
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => { },
  URL, URLSearchParams, Blob: function () { }, MouseEvent: function () { }, KeyboardEvent: function () { },
  Event: function () { }, PointerEvent: function () { },
  XMLHttpRequest: function () { this.open = () => { }; this.send = () => { }; this.addEventListener = () => { }; },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  innerWidth: 1440, innerHeight: 900, addEventListener() { }, removeEventListener() { }, postMessage() { }
};
sb.window = sb; sb.globalThis = sb;

console.log('[加载自检] 连续执行 core.js / api.js / content.js');
const ctx = vm.createContext(sb);
let loadErr = null;
for (const f of ['core.js', 'api.js', 'content.js']) {
  try { vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f }); }
  catch (e) { loadErr = f + ': ' + e.message; break; }
}
ok(!loadErr, '三个脚本无异常执行' + (loadErr ? '（' + loadErr + '）' : ''));
ok(sb.__LSFI_VER === version, '版本标记已写入（' + sb.__LSFI_VER + ' 应等于 ' + version + '）');
ok(typeof sb.__LSFI_OPEN === 'function', '手动打开入口 __LSFI_OPEN 存在');
ok(doc.body.children.length > 0, '常驻标志已创建（说明脚本执行到了末尾）');

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
