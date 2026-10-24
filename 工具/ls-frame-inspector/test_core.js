/* core.js 纯函数单测：node test_core.js */
'use strict';
const C = require('./core.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}

function rect(id, label, x, y, w, h) {
  return { id, type: 'rectanglelabels', value: { x, y, width: w, height: h, rectanglelabels: [label] } };
}
function num(id, text) {
  return { id, type: 'textarea', value: { text: [text] } };
}

// ---- mock task：帧 5203，机器预测 6 框（1 个缺号、1 个重复号） ----
const task = {
  id: 38013,
  data: { frame: 5203, image: '/YOUR_DATA_PATH/?d=/x.jpg' },
  predictions: [{
    model_version: '凉白开', score: 0.5, created_at: '2026-10-15T10:00:00Z',
    result: [
      rect('r1', 'teamA', 30, 50, 4, 9), num('r1', '25'),
      rect('r2', 'teamA', 45, 55, 4, 9), num('r2', '3'),
      rect('r3', 'teamB', 60, 52, 4, 9), num('r3', '46'),
      rect('r4', 'teamB', 12, 60, 4, 9),               // 缺号
      rect('r5', 'goalkeeperA', 2, 40, 3, 8), num('r5', '14'),
      rect('r6', 'teamA', 70, 58, 4, 9), num('r6', '25')  // 与 r1 同号重复
    ]
  }],
  annotations: []
};

console.log('[1] parseSource');
const src = C.parseSource(task, 'prediction', 0);
ok(src && src.boxes.length === 6, '解析出 6 个框');
ok(src.boxes.filter(b => b.label === 'teamA').length === 3, 'teamA 3 个');
ok(src.boxes.find(b => b.label === 'teamB' && !b.number) != null, 'teamB 缺号框被保留');
const b25 = src.boxes.filter(b => b.number === '25');
ok(b25.length === 2, '25 号出现 2 次');
const r1 = src.boxes.find(b => Math.abs(b.cx - 32) < 0.01 && b.label === 'teamA');
ok(r1 && r1.number === '25', 'r1 框与号码 25 正确配对');
ok(src.boxes[0].label === 'goalkeeperA' || src.boxes[0].label === 'teamA', '按队别排序');
ok(C.parseSource(task, 'annotation', 0) === null, '无人工标注时返回 null');

console.log('[2] qcIssues');
const qc = C.qcIssues(src.boxes);
ok(qc.some(s => s.includes('缺号 1')), '检出缺号 1 个');
ok(qc.some(s => s.includes('25') && s.includes('重复')), '检出 25 号重复');
ok(C.parseSource({ __missing: true }, 'prediction', 0) === null, 'missing task 返回 null');

console.log('[3] diffBoxes');
// 上一帧：与当前相比，teamA#25 消失、新增 teamB#46、teamB 缺号框号码变成 7
const prev = {
  boxes: [
    { label: 'teamA', number: '25', x: 30, y: 50, w: 4, h: 9, cx: 32, cy: 54.5 },
    { label: 'teamA', number: '3', x: 45, y: 55, w: 4, h: 9, cx: 47, cy: 59.5 },
    { label: 'teamB', number: '46', x: 61, y: 52, w: 4, h: 9, cx: 63, cy: 56.5 },
    { label: 'teamB', number: '7', x: 12, y: 60, w: 4, h: 9, cx: 14, cy: 64.5 },
    { label: 'goalkeeperA', number: '14', x: 2, y: 40, w: 3, h: 8, cx: 3.5, cy: 44 },
    { label: 'teamB', number: '9', x: 80, y: 58, w: 4, h: 9, cx: 82, cy: 62.5 }  // 上帧有、当前无
  ]
};
const d = C.diffBoxes(src, prev);
ok(d.gone.length === 1 && d.gone[0].number === '9', '检出消失框 teamB#9');
ok(d.appeared.length === 1 && d.appeared[0].label === 'teamA' && d.appeared[0].number === '25', '检出新出现框 teamA#25');
ok(d.numChanged.length === 1 && d.numChanged[0].prev.number === '7' && d.numChanged[0].cur.number === '', '检出号码变化 7→缺号');
ok(C.diffBoxes(null, prev) === null, '空输入返回 null');

console.log('[4] summarize');
const txt = C.summarize({
  taskId: 38013, frame: 5203, curName: '凉白开', curBoxes: src.boxes,
  qc: qc, prevFrame: 5202, nextFrame: 5204, diffPrev: d, diffNext: null
});
ok(txt.includes('帧 5203') && txt.includes('task 38013'), '摘要含帧号与 task id');
ok(txt.includes('缺号') && txt.includes('消失') === false && txt.includes('上帧有当前无'), '摘要含质检与帧间差异');
console.log('---- 摘要示例 ----\n' + txt + '\n------------------');

console.log('[5] suggestFixes（基于前后帧的修正建议）');
// 当前帧：teamB 缺号（前后帧都是 7）；teamA#25 闪烁（前后帧都是 3）；缺一个 teamB#9（前后帧都有）；多一个 referee（前后帧都无）
const curS = {
  boxes: [
    { rid: 'a', label: 'teamA', number: '25', x: 30, y: 50, w: 4, h: 9, cx: 32, cy: 54.5 },
    { rid: 'b', label: 'teamB', number: '', x: 12, y: 60, w: 4, h: 9, cx: 14, cy: 64.5 },
    { rid: 'c', label: 'referee', number: '', x: 50, y: 45, w: 3, h: 8, cx: 51.5, cy: 49 },
    { rid: 'd', label: 'goalkeeperA', number: '14', x: 2, y: 40, w: 3, h: 8, cx: 3.5, cy: 44 }
  ]
};
const nb = (label, number, cx, cy) => ({ rid: 'x', label, number, x: cx - 2, y: cy - 4.5, w: 4, h: 9, cx, cy });
const prevS = { human: true, boxes: [nb('teamA', '3', 32, 54.5), nb('teamB', '7', 14, 64.5), nb('goalkeeperA', '14', 3.5, 44), nb('teamB', '9', 80, 62.5)] };
const nextS = { human: true, boxes: [nb('teamA', '3', 32.5, 54.5), nb('teamB', '7', 14.5, 64.5), nb('goalkeeperA', '14', 3.5, 44), nb('teamB', '9', 80.5, 62.5)] };
const sug = C.suggestFixes(curS, prevS, nextS);
const t = (s) => s.type;
ok(sug.some(s => t(s) === 'fill_number' && s.number === '7' && s.conf === 'high'), '补号建议：teamB 缺号 → 7（high）');
ok(sug.some(s => t(s) === 'fix_number' && s.number === '3' && s.box.number === '25' && s.conf === 'high'), '改号建议：25 → 3（high）');
ok(sug.some(s => t(s) === 'add_box' && s.box.label === 'teamB' && s.box.number === '9'), '补框建议：teamB#9 前后帧都有本帧无');
ok(sug.some(s => t(s) === 'del_box' && s.box.label === 'referee'), '删框建议：referee 前后帧都无');
ok(!sug.some(s => t(s) === 'fill_number' && s.box.label === 'goalkeeperA'), '有号的门将不产生补号建议');
ok(C.suggestFixes(null, prevS, nextS).length === 0, '当前帧为空返回空建议');

console.log('[6] buildCorrectedResult（回写数据生成）');
const origResult = [
  { id: 'a', type: 'rectanglelabels', from_name: 'label', to_name: 'image', value: { x: 30, y: 50, width: 4, height: 9, rectanglelabels: ['teamA'] } },
  { id: 'b', type: 'rectanglelabels', from_name: 'label', to_name: 'image', value: { x: 12, y: 60, width: 4, height: 9, rectanglelabels: ['teamB'] } },
  { id: 'c', type: 'rectanglelabels', from_name: 'label', to_name: 'image', value: { x: 50, y: 45, width: 3, height: 8, rectanglelabels: ['referee'] } },
  { id: 'd', type: 'rectanglelabels', from_name: 'label', to_name: 'image', value: { x: 2, y: 40, width: 3, height: 8, rectanglelabels: ['goalkeeperA'] } },
  { id: 'd', type: 'textarea', from_name: 'number', to_name: 'image', value: { text: ['14'] } }
];
const toApply = sug.filter(s => s.type !== 'del_box'); // 应用补号/改号/补框，不删 referee
const fixed = C.buildCorrectedResult(origResult, toApply);
const rectsB = fixed.filter(r => r.type === 'rectanglelabels');
const textsB = fixed.filter(r => r.type === 'textarea');
ok(rectsB.length === origResult.filter(r => r.type === 'rectanglelabels').length + 1, '补框后矩形 +1');
ok(textsB.filter(x => x.id === 'b').length === 1 && textsB.find(x => x.id === 'b').value.text[0] === '7', '缺号框 b 补上号码 7');
ok(textsB.find(x => x.id === 'a').value.text[0] === '3', '闪烁框 a 改为 3');
const newRect = rectsB.find(r => r.rectanglelabelsTrue === undefined && r.value.rectanglelabels[0] === 'teamB' && r.id !== 'b');
ok(!!newRect && newRect.value.width > 0, '新增补框矩形字段完整');
const fixed2 = C.buildCorrectedResult(origResult, sug.filter(s => s.type === 'del_box'));
ok(fixed2.filter(r => r.type === 'rectanglelabels').length === 3, '删框后矩形 -1（referee 被移除）');
ok(fixed2.filter(r => r.id === 'a').length === 1, '删框只删 referee，其他不动');

console.log('[7] estimatePage / probeOrder（跳转搜索）');
ok(C.estimatePage(0, 100) === 1 && C.estimatePage(99, 100) === 1 && C.estimatePage(100, 100) === 2, '页码估算正确');
ok(C.estimatePage(5204, 100) === 53, '帧 5204 → 第 53 页');
ok(C.estimatePage(-5, 100) === 1 && C.estimatePage('x', 100) === 1, '非法帧号兜底为第 1 页');
var po = C.probeOrder(53, 2);
ok(po[0] === 53 && po.indexOf(52) >= 0 && po.indexOf(54) >= 0 && po.indexOf(51) >= 0 && po.indexOf(55) >= 0, '探测顺序以估计页为中心左右扩张');
ok(C.probeOrder(1, 2).every(function (p) { return p >= 1; }), '探测页码不小于 1');

console.log('[8] suggestFixesWindow（前后各 5 帧众数投票）');
var nb2 = function (label, number, cx, cy) { return { label: label, number: number, x: cx - 2, y: cy - 4.5, w: 4, h: 9, cx: cx, cy: cy }; };
var curW = { boxes: [nb2('teamB', '', 14, 64.5), nb2('teamA', '25', 32, 54.5), nb2('referee', '', 50, 49)] };
var pL = [], nL = [];
for (var wi = 1; wi <= 5; wi++) {
  pL.push({ human: true, boxes: [nb2('teamB', wi <= 4 ? '7' : '9', 14, 64.5), nb2('teamA', '3', 32, 54.5)] });
  nL.push({ human: true, boxes: [nb2('teamB', '7', 14, 64.5), nb2('teamA', '3', 32, 54.5)] });
}
var sw = C.suggestFixesWindow(curW, pL, nL);
ok(sw.some(function (s) { return s.type === 'fill_number' && s.number === '7' && s.conf === 'high'; }), '窗口众数补号 7（9 票压过 1 票的 9）');
ok(sw.some(function (s) { return s.type === 'fix_number' && s.number === '3' && s.box.number === '25'; }), '窗口众数改号 25→3');
ok(sw.some(function (s) { return s.type === 'del_box' && s.box.label === 'referee'; }), '窗口内一帧都没有 → 删框建议');
ok(!sw.some(function (s) { return s.type === 'add_box'; }), '本帧已有同位置框 → 不产生补框建议');
// 只有 1 帧邻域出现 → 不够补框证据
var sw2 = C.suggestFixesWindow(curW, [pL[0]], []);
ok(!sw2.some(function (s) { return s.type === 'add_box'; }), '邻域仅 1 帧 → 不补框（需前后都有）');
ok(C.wrapLocalResult([{ id: 'a', type: 'rectanglelabels', value: { x: 1, y: 1, width: 2, height: 2, rectanglelabels: ['teamA'] } }]).__local === true, '本地修正包装为伪 task');

console.log('[9] 权重规则（用户场景：相邻帧主导）');
// 场景A：5205 多出 teamB#14，5204/5206 都没有，只有远帧 5202 有 → 必须提示误检（不能当正常信号）
var curA = { boxes: [nb2('teamB', '14', 60, 52), nb2('teamA', '3', 32, 54.5)] };
var prevA = [
  { boxes: [nb2('teamA', '3', 32, 54.5)] },                        // [0]=5204 无 teamB@60
  { boxes: [nb2('teamA', '3', 32, 54.5)] },                        // [1]=5203
  { boxes: [nb2('teamB', '14', 60, 52), nb2('teamA', '3', 32, 54.5)] } // [2]=5202 远帧有
];
var nextA = [
  { boxes: [nb2('teamA', '3', 32, 54.5)] },                        // [0]=5206 无
  { boxes: [nb2('teamA', '3', 32, 54.5)] },
  { boxes: [nb2('teamA', '3', 32, 54.5)] }
];
var sugA = C.suggestFixesWindow(curA, prevA, nextA);
ok(sugA.some(function (s) { return s.type === 'del_box' && s.box.number === '14'; }), '邻帧都没有、仅远帧有 → 仍提示误检（降档 mid）');
ok(!sugA.some(function (s) { return s.type === 'fill_number' && s.box.number === '14'; }), '误检框不会被拿去给别帧当补号证据');

// 场景B：本帧缺一个框，只有前一帧有（后一帧没有）→ 仍要标出来（中置信，漏检或已退场由人判断）
var curB = { boxes: [nb2('teamA', '3', 32, 54.5)] };
var prevB = [{ boxes: [nb2('teamA', '3', 32, 54.5), nb2('teamB', '9', 80, 62.5)] }];
var nextB = [{ boxes: [nb2('teamA', '3', 32, 54.5)] }];
var sugB = C.suggestFixesWindow(curB, prevB, nextB);
ok(sugB.some(function (s) { return s.type === 'add_box' && s.box.number === '9' && s.conf === 'mid'; }), '仅前一帧有的框 → 仍提示补框（中置信，可能是漏检或退场）');
ok(sugB.some(function (s) { return s.type === 'add_box' && s.reason.indexOf('退场') >= 0; }), '依据里写明"漏检或已退场，请判断"');

// 场景C：两侧相邻帧都有 → 补框高置信
var prevC = [{ boxes: [nb2('teamA', '3', 32, 54.5), nb2('teamB', '9', 80, 62.5)] }];
var nextC = [{ boxes: [nb2('teamA', '3', 32, 54.5), nb2('teamB', '9', 80.5, 62.5)] }];
var sugC = C.suggestFixesWindow(curB, prevC, nextC);
ok(sugC.some(function (s) { return s.type === 'add_box' && s.box.number === '9' && s.conf === 'high'; }), '前后相邻帧都有 → 补框高置信');

// 场景D：号码只有远帧有 → 不猜；相邻帧有 → 高置信
var curD = { boxes: [nb2('teamA', '', 32, 54.5)] };
var prevD1 = [{ boxes: [nb2('teamA', '3', 32, 54.5)] }, { boxes: [nb2('teamA', '9', 32, 54.5)] }]; // [0]=3, [1]=9(远)
var nextD1 = [{ boxes: [nb2('teamA', '3', 32, 54.5)] }];
ok(C.suggestFixesWindow(curD, prevD1, nextD1).some(function (s) { return s.type === 'fill_number' && s.number === '3' && s.conf === 'high'; }), '相邻帧一致 → 补号高置信');
var prevD2 = [{ boxes: [nb2('teamA', '', 32, 54.5)] }, { boxes: [nb2('teamA', '9', 32, 54.5)] }]; // 只有远帧有号
var nextD2 = [{ boxes: [nb2('teamA', '', 32, 54.5)] }];
ok(!C.suggestFixesWindow(curD, prevD2, nextD2).some(function (s) { return s.type === 'fill_number'; }), '只有远帧有号码 → 不猜（权重不足）');

console.log('[10] nextUnsubmitted（找最近未提交帧）');
ok(C.nextUnsubmitted(10, { 11: true, 12: false, 13: false }, 1, 300) === 12, '向后找到第一个未提交');
ok(C.nextUnsubmitted(10, { 9: false }, -1, 300) === 9, '向前找到第一个未提交');
ok(C.nextUnsubmitted(10, { 11: true, 12: true }, 1, 5) === null, '范围内都已提交返回 null');
ok(C.nextUnsubmitted(10, {}, 1, 300) === null, '无数据返回 null（不瞎猜）');
ok(C.nextUnsubmitted(10, null, 1, 300) === null, '空表返回 null');

console.log('[11] 人工确认帧权重（用户原则：已提交=人工确认≈权威）');
// 场景A：当前帧是人工确认的 17 → 不得提示改号（人工值不许擅改）
var curH = { boxes: [nb2('teamA', '17', 32, 54.5)], human: true };
var prevM = [{ boxes: [nb2('teamA', '46', 32, 54.5)] }];
var nextM = [{ boxes: [nb2('teamA', '46', 32, 54.5)] }];
ok(!C.suggestFixesWindow(curH, prevM, nextM).some(function (s) { return s.type === 'fix_number'; }), '当前帧人工确认 → 不提示改号');

// 场景B：前一帧人工确认"没有 teamB14"，后一帧机器"有" → 仍提示误检（人工赢）
var curB2 = { boxes: [nb2('teamB', '14', 60, 52)], human: false };
var prevB2 = [{ boxes: [nb2('teamA', '3', 32, 54.5)], human: true }];   // 人工确认，无 teamB@60
var nextB2 = [{ boxes: [nb2('teamA', '3', 32, 54.5), nb2('teamB', '14', 60, 52)] }]; // 机器有
var sugB2 = C.suggestFixesWindow(curB2, prevB2, nextB2);
ok(sugB2.some(function (s) { return s.type === 'del_box' && s.box.number === '14'; }), '人工帧说没有、机器帧说有 → 仍提示误检');
ok(sugB2.some(function (s) { return s.reason.indexOf('人工标注') >= 0; }), '依据里注明上一帧是人工标注');
ok(sugB2.some(function (s) { return s.type === 'del_box' && s.conf === 'high'; }), '人工帧背书 → 高置信');

console.log('[18] 删框收敛：只认"与上一帧强比对"（多帧投票删已下线）');
// 场景A：本帧有这个号，上一帧里同队同号在别处（球员移动了 30%）→ 绝不能提示删框
var curMv = { boxes: [nb2('teamA', '25', 70, 50)] };
var prevMv = [{ boxes: [nb2('teamA', '25', 40, 50), nb2('teamA', '24', 20, 50)], human: true }];
var sugMv = C.suggestFixesWindow(curMv, prevMv, []);
ok(!sugMv.some(function (s) { return s.type === 'del_box'; }), '球员移动（上一帧有同号）→ 不提示删框');

// 场景B：上一帧同位置有框但标签不同 → 那是改标签候选，不能当误检删掉
var curLb = { boxes: [nb2('teamA', '', 60, 52)] };
var prevLb = [{ boxes: [nb2('teamB', '15', 60, 52)], human: true }];
var sugLb = C.suggestFixesWindow(curLb, prevLb, []);
ok(!sugLb.some(function (s) { return s.type === 'del_box'; }), '上一帧位置有人（标签不同）→ 不提示删框');
ok(sugLb.some(function (s) { return s.type === 'fix_label'; }), '改为提示修改标签');

// 场景C：上一帧该位置啥都没有 → 严格模式下提示删框
var curFp = { boxes: [nb2('teamB', '', 90, 20)] };
var prevFp = [{ boxes: [nb2('teamA', '3', 32, 54.5)], human: true }];
var nextFp = [{ boxes: [nb2('teamB', '', 90, 20)] }];   // 后一帧机器仍有 → 旧规则不会删
var sugFp = C.suggestFixesWindow(curFp, prevFp, nextFp);
ok(sugFp.some(function (s) { return s.type === 'del_box'; }), '上一帧该位置空 → 严格模式仍提示删框');

// 场景D：多帧投票删下线 —— 邻帧有支持时不再刷"疑似误检"
var curOk = { boxes: [nb2('teamA', '', 32, 54.5)] };
var prevOk = [{ boxes: [nb2('teamB', '7', 80, 60)] }];      // 位置不同
var nextOk = [{ boxes: [nb2('teamA', '', 32, 54.5)] }];     // 后一帧有 → 旧规则会保留，新规则仍保留
var sugOk = C.suggestFixesWindow(curOk, prevOk, nextOk);
// 严格模式下：上一帧没有 → 会提示删；切到宽松模式结果一致（因为 forW>0 被兜底规则排除）
ok(sugOk.some(function (s) { return s.type === 'del_box'; }), '上一帧缺失 → 提示删框（与旧行为一致）');

// 场景E：宽松模式只在"所有邻帧都没有"时追加提示
var curLo = { boxes: [nb2('teamA', '', 10, 10), nb2('teamB', '', 50, 50)] };
var prevLo = [{ boxes: [nb2('teamB', '', 50, 50)] }];
var nextLo = [{ boxes: [nb2('teamB', '', 50, 50)] }];
var sStrict = C.suggestFixesWindow(curLo, prevLo, nextLo);                 // 严格：teamA@10 删
var sLoose = C.suggestFixesWindow(curLo, prevLo, nextLo, 6, 10, { delMode: 'loose' });
ok(sStrict.filter(function (s) { return s.type === 'del_box'; }).length === 1, '严格模式只出 1 条删框');
ok(sLoose.filter(function (s) { return s.type === 'del_box'; }).length === 1, '宽松模式不重复追加（该删的严格模式已经删了）');

// 场景F：上一帧缺数据但下一帧有 → 用下一帧兜底，不误删
var curNx = { boxes: [nb2('teamA', '', 32, 54.5)] };
var nextNx = [{ boxes: [nb2('teamA', '', 32, 54.5)], human: true }];
var sugNx = C.suggestFixesWindow(curNx, [], nextNx);
ok(!sugNx.some(function (s) { return s.type === 'del_box'; }), '无上一帧数据时用下一帧兜底 → 不误删');

// 场景G：待删的框不再叠加"补号"标记
var curDl = { boxes: [nb2('teamA', '', 90, 20)] };
var prevDl = [{ boxes: [nb2('teamA', '7', 30, 50)], human: true }];
var nextDl = [{ boxes: [nb2('teamB', '9', 60, 60)] }];
var sugDl = C.suggestFixesWindow(curDl, prevDl, nextDl);
ok(sugDl.some(function (s) { return s.type === 'del_box'; }), '上一帧无此位置 → 删框');
ok(!sugDl.some(function (s) { return (s.type === 'fill_number' || s.type === 'need_number') && s.box.cx === 90; }), '待删框不再补号');

console.log('[19] 重叠删收敛：号码不同 = 两个球员叠加，绝不删（6114 帧教训）');
// 场景A：teamA#25 与 teamA#3 中心差 1.6%（号码不同）→ 两个真人站得近，不提示删
var curOv = { boxes: [nb2('teamA', '25', 84.3, 48.5), nb2('teamA', '3', 85.9, 48.5), nb2('teamB', '15', 80, 40)] };
var prevOv = [{ boxes: [nb2('teamA', '25', 84, 48), nb2('teamA', '3', 86, 48), nb2('teamB', '15', 80, 40)], human: true }];
var sugOv = C.suggestFixesWindow(curOv, prevOv, []);
ok(!sugOv.some(function (s) { return s.type === 'del_box'; }), '同标签不同号（1.6% 近）→ 不提示删框');
// 场景B：同标签同号（#7 和 #7）中心差 1.5% → 真·重复检测，删掉更小的那个
var curDp = { boxes: [nb2('teamA', '7', 50, 50), nb2('teamA', '7', 51.5, 50)] };
curDp.boxes[0].w = 6; curDp.boxes[0].h = 12;   // 大的
curDp.boxes[1].w = 5; curDp.boxes[1].h = 10;   // 小的
var prevDp = [{ boxes: [nb2('teamA', '7', 50, 50)], human: true }];
var sugDp = C.suggestFixesWindow(curDp, prevDp, []);
ok(sugDp.some(function (s) { return s.type === 'del_box' && s.box.w === 5; }), '同标签同号重叠 → 删掉更小的那个');
// 场景C：一个有号一个没号，中心很近 → 存疑，不自动删（交给人眼）
var curMx = { boxes: [nb2('teamB', '18', 81.5, 40), nb2('teamB', '', 83.6, 40)] };
var prevMx = [{ boxes: [nb2('teamB', '18', 81.5, 40), nb2('teamB', '15', 90, 60)], human: true }];
var sugMx = C.suggestFixesWindow(curMx, prevMx, []);
ok(!sugMx.some(function (s) { return s.type === 'del_box' && s.box.number === '18'; }), '有号框 + 近邻无号框 → 不自动删有号框');

// 场景C：人工确认的前邻帧号码为 46，机器远帧为 30 → 补号按人工的来
var curC2 = { boxes: [nb2('teamA', '', 32, 54.5)], human: false };
var prevC2 = [{ boxes: [nb2('teamA', '46', 32, 54.5)], human: true }];
var nextC2 = [{ boxes: [nb2('teamA', '30', 32, 54.5)] }];
var sugC2 = C.suggestFixesWindow(curC2, prevC2, nextC2);
ok(sugC2.some(function (s) { return s.type === 'fill_number' && s.number === '46'; }), '人工邻帧号码压过机器邻帧');

// 场景D：当前帧人工 + 只有机器证据 -> 仍提示补框（中置信，注明邻帧只有机器预测证据）
var curD3 = { boxes: [nb2('teamA', '3', 32, 54.5)], human: true };
var prevD3 = [{ boxes: [nb2('teamA', '3', 32, 54.5), nb2('teamB', '9', 80, 62.5)] }];  // 机器
var nextD3 = [{ boxes: [nb2('teamA', '3', 32, 54.5), nb2('teamB', '9', 80, 62.5)] }];  // 机器
ok(C.suggestFixesWindow(curD3, prevD3, nextD3).some(function (s) { return s.type === 'add_box' && s.box.number === '9' && s.conf === 'mid'; }), '人工帧 + 纯机器证据 -> 仍提示补框（中置信）');
var prevD4 = [{ boxes: [nb2('teamA', '3', 32, 54.5), nb2('teamB', '9', 80, 62.5)], human: true }]; // 人工有
ok(C.suggestFixesWindow(curD3, prevD4, nextD3).some(function (s) { return s.type === 'add_box' && s.box.number === '9'; }), '人工帧 + 有人工证据 → 补框');

// 场景E：bestSourceOf 选最新的人工标注（多份标注时）
var taskMulti = {
  annotations: [
    { id: 1, created_at: '2026-10-19T10:00:00Z', updated_at: '2026-10-19T10:00:00Z', was_cancelled: false, result: [] },
    { id: 2, created_at: '2026-10-19T11:00:00Z', updated_at: '2026-10-20T01:50:00Z', was_cancelled: false, result: [] }
  ],
  predictions: [{ model_version: 'x', result: [] }]
};
ok(C.bestSourceOf(taskMulti).index === 1, '多份标注选 updated_at 最新的');
taskMulti.annotations[1].was_cancelled = true;
ok(C.bestSourceOf(taskMulti).index === 0, '最新的被取消则选次新');
delete taskMulti.annotations;
ok(C.bestSourceOf(taskMulti).kind === 'prediction', '当前帧无 244 标注 → 回退凉白开预测（起稿参考）');
ok(C.bestHumanSourceOf(taskMulti) === null, '邻帧证据：无 244 标注 → 返回 null，凉白开不进对比');

console.log('[12] motionCheck（帧间框区域对比）');
// 正常移动（0.3%）→ 无异常
var curMo = { boxes: [nb2('teamA', '25', 32.3, 54.5)] };
var prevMo = { boxes: [nb2('teamA', '25', 32, 54.5)] };
ok(C.motionCheck(curMo, prevMo).length === 0, '位移 0.3% → 正常，无异常');
// 大跳变（10%）→ 跳变异常
var curMoJ = { boxes: [nb2('teamA', '25', 42, 54.5)] };
var mJ = C.motionCheck(curMoJ, prevMo);
ok(mJ.length === 1 && mJ[0].level === 'jump' && mJ[0].dist > 9, '位移 10% → 跳变异常');
// 面积突变（+60%）→ 异常
var curMoS = { boxes: [{ label: 'teamA', number: '25', x: 30, y: 50, w: 6.4, h: 14.4, cx: 33.2, cy: 57.2 }] };
ok(C.motionCheck(curMoS, prevMo).some(function (m) { return m.reason.indexOf('面积') >= 0; }), '框面积 +60% → 异常');
// 同位置换号 → 身份错配提示
var curMoN = { boxes: [nb2('teamA', '30', 32, 54.5)] };
ok(C.motionCheck(curMoN, prevMo).some(function (m) { return m.reason.indexOf('身份错配') >= 0; }), '同位置 25→30 → 身份错配提示');
// 偏快（2%）→ fast
var curMoF = { boxes: [nb2('teamA', '25', 34, 54.5)] };
var mF = C.motionCheck(curMoF, prevMo);
ok(mF.length === 1 && mF[0].level === 'fast', '位移 2% → 偏快提示');
ok(C.motionCheck(curMo, null).length === 0, '无前一帧返回空');

console.log('[13] 号码框的两种挂法（同 id / parent_id）');
// 人工标注写法：textarea 自带 id + parent_id 指向框
var annTask = {
  annotations: [{
    id: 9, created_at: '2026-10-20T02:00:00Z', updated_at: '2026-10-20T02:00:00Z', was_cancelled: false,
    result: [
      { id: 'r1', type: 'rectanglelabels', from_name: 'label', to_name: 'image', value: { x: 20, y: 50, width: 2, height: 6, rectanglelabels: ['teamB'] } },
      { id: 't1', type: 'textarea', parent_id: 'r1', from_name: 'number', to_name: 'image', value: { text: ['7'] } },
      { id: 'r2', type: 'rectanglelabels', from_name: 'label', to_name: 'image', value: { x: 40, y: 50, width: 2, height: 6, rectanglelabels: ['teamA'] } },
      { id: 't2', type: 'textarea', parent_id: 'r2', from_name: 'number', to_name: 'image', value: { text: ['19'] } }
    ]
  }],
  predictions: []
};
var annSrc = C.parseSource(annTask, 'annotation', 0);
ok(annSrc.boxes.length === 2, 'parent_id 写法：框数正确（号码框不被当成框）');
ok(annSrc.boxes.filter(function (b) { return b.number; }).length === 2, 'parent_id 写法：号码全部解析到（不再误判缺号）');

// 用人工标注的 parent_id 写法：改号应改到对应的 textarea，删框应连号码框一起删
var fixedPid = C.buildCorrectedResult(annTask.annotations[0].result, [
  { type: 'fix_number', box: { rid: 'r1' }, number: '8' }
]);
var t1 = fixedPid.filter(function (r) { return r.id === 't1'; })[0];
ok(t1 && t1.value.text[0] === '8', 'parent_id 写法：改号正确写入原号码框');
var afterDel = C.buildCorrectedResult(annTask.annotations[0].result, [
  { type: 'del_box', box: { rid: 'r1' } }
]);
ok(!afterDel.some(function (r) { return r.id === 'r1' || r.parent_id === 'r1'; }), 'parent_id 写法：删框同时删掉它的号码框');

// 机器预测写法（同 id）仍要正常
var predTask = {
  annotations: [],
  predictions: [{
    model_version: '凉白开', result: [
      { id: 'p1', type: 'rectanglelabels', value: { x: 10, y: 10, width: 2, height: 6, rectanglelabels: ['teamA'] } },
      { id: 'p1', type: 'textarea', value: { text: ['5'] } }
    ]
  }]
};
ok(C.parseSource(predTask, 'prediction', 0).boxes[0].number === '5', '同 id 写法：机器预测号码仍正常');

console.log('[14] 互斥：疑似误检的框不再提示补号（用户场景：上一帧压根没这个框）');
var curX = { boxes: [nb2('teamB', '', 48, 17), nb2('teamA', '24', 40, 35)] };
var prevX = [{ boxes: [nb2('teamA', '24', 40, 35)], human: true }];                                  // 人工确认：此处无 teamB
var nextX = [{ boxes: [nb2('teamA', '24', 40, 35), nb2('teamB', '46', 49, 18)] }];                   // 机器：同位置有 teamB#46
var sugX = C.suggestFixesWindow(curX, prevX, nextX);
ok(sugX.some(function (s) { return s.type === 'del_box' && s.box.label === 'teamB'; }), '上一帧人工无此框 → 提示删框');
ok(!sugX.some(function (s) { return s.type === 'fill_number' && s.box.label === 'teamB'; }), '同一框不再提示补号（互斥）');

console.log('[15] unknown 标签规则（默认删除，可切换为保留）');
// 场景A（默认 unknownDel=true）：unknown 框一律提示删除，哪怕上一帧同位置也有
var curU = { boxes: [nb2('unknown', '', 70, 20), nb2('teamA', '7', 32, 54.5)] };
var prevU = [{ boxes: [nb2('teamA', '7', 32, 54.5), nb2('unknown', '', 70, 20), nb2('teamB', '9', 80, 62.5)] }];
var nextU = [{ boxes: [nb2('teamA', '7', 32, 54.5), nb2('unknown', '', 70.2, 20), nb2('teamB', '9', 80, 62.5)] }];
var sugU = C.suggestFixesWindow(curU, prevU, nextU);
ok(sugU.some(function (s) { return s.type === 'del_box' && /^unknown$/i.test(s.box.label); }), '默认：unknown 框提示删除');
ok(!sugU.some(function (s) { return s.type === 'add_box' && /^unknown$/i.test(s.box.label); }), 'unknown 框不作为补框候选');
ok(C.qcIssues(curU.boxes).some(function (t) { return t.indexOf('unknown') >= 0; }), '质检提示点名 unknown 框');
// 场景B（unknownDel=false）：unknown 保留，交给与上一帧强比对 / 改标签
var sugUKeep = C.suggestFixesWindow(curU, prevU, nextU, 6, 10, { unknownDel: false });
ok(!sugUKeep.some(function (s) { return s.type === 'del_box' && /^unknown$/i.test(s.box.label); }), '关闭后：上一帧同位置有 → unknown 不删');
// 场景C（unknownDel=false）：上一帧该位置空 → 仍走强比对提示删框
var curU2 = { boxes: [nb2('unknown', '', 70, 20)] };
var prevU2 = [{ boxes: [nb2('teamA', '7', 32, 54.5)], human: true }];
var sugU2 = C.suggestFixesWindow(curU2, prevU2, [], 6, 10, { unknownDel: false });
ok(sugU2.some(function (s) { return s.type === 'del_box' && /^unknown$/i.test(s.box.label); }), '关闭后：上一帧该位置空 → 提示删（强比对）');
// 场景D（unknownDel=false）：上一帧同位置是带号码的 teamB → 改标签而不是删
var curU3 = { boxes: [nb2('unknown', '', 80, 62.5)] };
var prevU3 = [{ boxes: [nb2('teamB', '15', 80, 62.5)], human: true }];
var sugU3 = C.suggestFixesWindow(curU3, prevU3, [], 6, 10, { unknownDel: false });
ok(sugU3.some(function (s) { return s.type === 'fix_label' && s.label === 'teamB' && s.number === '15'; }), '关闭后：unknown + 上一帧同位置有号 → 改标签');
ok(!sugU3.some(function (s) { return s.type === 'del_box'; }), '同上 → 不提示删框');

console.log('[16] 权重：前一帧主导（约 75%）');
var curP = { boxes: [nb2('teamA', '', 32, 54.5)] };
var prevP = [{ boxes: [nb2('teamA', '46', 32, 54.5)] }];   // 前一帧：46
var nextP = [{ boxes: [nb2('teamA', '19', 32, 54.5)] }];   // 后一帧：19
var sugP = C.suggestFixesWindow(curP, prevP, nextP);
ok(sugP.some(function (s) { return s.type === 'fill_number' && s.number === '46' && s.conf === 'high'; }), '前一帧(46)压过后一帧(19)');
var sugP2 = C.suggestFixesWindow(curP, [], nextP);
ok(!sugP2.some(function (s) { return s.type === 'fill_number' && s.conf === 'high'; }), '只有后一帧（权重 0.17）→ 最高只给"中"，不给高置信');

console.log('[17] 缺号必须显式标记（不允许场上出现无号码的框）');
// 邻帧同位置都没号码 → 也要出一条 need_number 提醒
var curN2 = { boxes: [nb2('teamA', '', 32, 54.5)] };
var prevN2 = [{ boxes: [nb2('teamA', '', 32, 54.5)] }];
var nextN2 = [{ boxes: [nb2('teamA', '', 32.3, 54.5)] }];
var sugN2 = C.suggestFixesWindow(curN2, prevN2, nextN2);
ok(sugN2.some(function (s) { return s.type === 'need_number'; }), '邻帧也无号码 → 出 need_number 标记');
ok(!sugN2.some(function (s) { return s.type === 'fill_number'; }), '同时不冒出无依据的补号');
// 疑似误检的缺号框：只提示删框，不再叠加缺号标记
var curN3 = { boxes: [nb2('teamB', '', 70, 20)] };
var prevN3 = [{ boxes: [], human: true }];
var nextN3 = [{ boxes: [] }];
var sugN3 = C.suggestFixesWindow(curN3, prevN3, nextN3);
ok(sugN3.some(function (s) { return s.type === 'del_box'; }), '疑似误检 → 提示删框');
ok(!sugN3.some(function (s) { return s.type === 'need_number'; }), '已判删框的缺号框不再叠加缺号标记');

console.log('[20] 数据源一致性（6129 帧教训：草稿/标注时间竞争 + 证据链）');
// 场景A：草稿比标注新 → 以草稿为准（用户眼里看到的是草稿）
var taskDA = {
  annotations: [{ id: 1, updated_at: '2026-10-21T10:00:00Z', was_cancelled: false, result: [] }],
  drafts: [{ id: 9, updated_at: '2026-10-21T12:00:00Z', was_cancelled: false, result: [] }],
  predictions: []
};
var bsDA = C.bestSourceOf(taskDA);
ok(bsDA && bsDA.kind === 'draft', '草稿比标注新 → 读草稿');
// 场景B：标注比草稿新 → 读标注
var taskDB = {
  annotations: [{ id: 1, updated_at: '2026-10-21T13:00:00Z', was_cancelled: false, result: [] }],
  drafts: [{ id: 9, updated_at: '2026-10-21T12:00:00Z', was_cancelled: false, result: [] }],
  predictions: []
};
ok(C.bestSourceOf(taskDB).kind === 'annotation', '标注比草稿新 → 读标注');
// 场景C：草稿解析出来必须算人工帧（否则邻帧草稿被当机器降权）
var srcDC = C.parseSource(taskDA, 'draft', 0);
ok(srcDC && srcDC.human === true && srcDC.name === '草稿·未提交', '草稿 = 人工帧 + 名字标注"草稿·未提交"');
// 场景D：补号建议带证据链（哪个帧、哪个框、距离、人工/机器）
var curEv = { boxes: [nb2('teamB', '', 83.3, 42.1)] };
var prevEv = [{ boxes: [nb2('teamB', '46', 82, 43)], human: true, frameNo: 6128 }];
var sugEv = C.suggestFixesWindow(curEv, prevEv, []);
var fillEv = sugEv.filter(function (s) { return s.type === 'fill_number'; })[0];
ok(fillEv && fillEv.number === '46', '补号建议照常出（46）');
ok(fillEv && Array.isArray(fillEv.evidence) && fillEv.evidence.length === 1, '带证据链');
ok(fillEv && fillEv.evidence[0].frameNo === 6128 && fillEv.evidence[0].num === '46' && fillEv.evidence[0].human === true, '证据链含帧号/号码/人工标记');

console.log('[21] number 类型号码控件（b47 事件：机器预测继承的写法）');
var taskNum = { annotations: [{
  id: 1, updated_at: '2026-10-21T12:55:50Z', was_cancelled: false,
  result: [
    { id: 'player_10', type: 'rectanglelabels', from_name: 'label', to_name: 'image',
      value: { x: 85.9, y: 37.3, width: 0.8, height: 3.1, rectanglelabels: ['teamB'] } },
    { id: 'player_10', type: 'number', from_name: 'number', to_name: 'image', origin: 'prediction-changed',
      value: { x: 85.9, y: 37.3, width: 0.8, height: 3.1, rotation: 0, number: 47 } },
    { id: 'player_11', type: 'rectanglelabels', from_name: 'label', to_name: 'image',
      value: { x: 81.8, y: 39.9, width: 0.4, height: 3.5, rectanglelabels: ['teamB'] } },
    { id: 'player_11', type: 'textarea', from_name: 'number', to_name: 'image',
      value: { text: ['46'] } }
  ]
}], drafts: [], predictions: [] };
var srcNum = C.parseSource(taskNum, 'annotation', 0);
var b10 = srcNum.boxes.filter(function (b) { return b.rid === 'player_10'; })[0];
var b11 = srcNum.boxes.filter(function (b) { return b.rid === 'player_11'; })[0];
ok(b10 && b10.number === '47', 'number 控件的 47 能解析到（不再误判缺号）');
ok(b11 && b11.number === '46', 'textarea 的 46 照常解析');
var stNum = C.parseSourceStats(taskNum, 'annotation', 0);
ok(stNum && stNum.texts === 2 && stNum.withNumber === 2, '统计：号码控件 2 个 / 有号 2 个');
// 写入：对 number 控件的框改号 → 只改 value.number，不破坏位置字段
var corrected = C.buildCorrectedResult(taskNum.annotations[0].result, [
  { type: 'fix_number', box: { rid: 'player_10', label: 'teamB', number: '47' }, number: '12', conf: 'high', reason: 'test' }
]);
var numItem = corrected.filter(function (r) { return r.type === 'number' && r.id === 'player_10'; })[0];
ok(numItem && numItem.value.number === 12, 'number 控件写入后 value.number 更新');
ok(numItem && numItem.value.width === 0.8 && numItem.value.height === 3.1, 'number 控件的位置字段保留');
ok(corrected.filter(function (r) { return r.type === 'textarea'; }).length === 1, '没有额外生成 textarea');

console.log('[22] 补框定位只认紧邻帧（贴边快跑球员不再被旧位置拖偏，6331 帧教训）');
var curP = { boxes: [nb2('teamA', '3', 60, 50)] };
var prevP = [{ boxes: [nb2('teamA', '8', 99.7, 44.3), nb2('teamA', '3', 60, 50)] },
             { boxes: [nb2('teamA', '8', 80.3, 44), nb2('teamA', '3', 60, 50)] }];
var nextP = [{ boxes: [nb2('teamA', '8', 99.7, 44.2), nb2('teamA', '3', 60, 50)] }];
var sugP = C.suggestFixesWindow(curP, prevP, nextP);
var abP = sugP.filter(function (s) { return s.type === 'add_box' && s.box.number === '8'; })[0];
ok(!!abP, '贴边缺框照常提示补框（#8）');
ok(abP && Math.abs(abP.box.cx - 99.7) < 1.5, '补框位置 = 紧邻帧位置（≈99.7），不被 3-5 帧前的旧位置拖偏');

console.log('[23] 改号双保险：弱投票/纯机器投票不许动已填的号（6451 帧教训：46 被后帧凉白开的 0.17 改成 31）');
// 场景A：本帧机器填了 46；上一帧 244 该位置无匹配；后帧凉白开投 31（仅 0.17）→ 不出改号
var curF2 = { boxes: [nb2('teamB', '46', 90, 43)] };
var prevF2 = [{ human: true, boxes: [nb2('teamB', '7', 30, 60)] }];
var nextF2 = [{ boxes: [nb2('teamB', '31', 92, 43)] }];
var sugF3 = C.suggestFixesWindow(curF2, prevF2, nextF2);
ok(!sugF3.some(function (s) { return s.type === 'fix_number'; }), '弱投票（0.17 机器）不改已填的 46');
// 场景B：上一帧 244 同位置明确是 31 → 改号照常出（人工背书）
var prevF3 = [{ human: true, boxes: [nb2('teamB', '31', 90.5, 43)] }];
var sugF4 = C.suggestFixesWindow(curF2, prevF3, nextF2);
ok(sugF4.some(function (s) { return s.type === 'fix_number' && s.number === '31' && s.conf === 'high'; }), '人工帧背书 → 改号 46→31 照常');

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
