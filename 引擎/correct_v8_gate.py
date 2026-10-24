"""按"只参考上一帧 244 数据"的规则，修正 6506-6510 并生成写入 payload。

规则（用户 2026-10-22 明确口径）：
  1. 当前帧来源：有 244 标注用标注，没有用凉白开预测起稿；
  2. 唯一参考 = 上一帧的 244 数据（6505 起，逐帧传递我刚写好的结果）；
  3. 删：unknown 框；与上一帧同位置匹配不到的框（疑似误检）；
  4. 补号：无号框 → 上一帧同位置框的号码；改号/改标签：与上一帧对齐（保留本帧位置）；
  5. 补框：上一帧有、本帧没有 → 按上一帧位置补上；
  6. 重复框（同标签重叠且同抢一个上一帧框）→ 保留更近的，删另一个。
"""
import json, math

RAW = json.load(open('数据/raw_9189_9251.json', encoding='utf-8'))

def parse(result):
    """result -> (boxes, rect_items_by_id, text_items_by_id)"""
    rects, texts = [], []
    for it in result:
        if it.get('type') == 'rectanglelabels':
            v = it.get('value') or {}
            rects.append({
                'rid': str(it['id']), 'item': it,
                'label': (v.get('rectanglelabels') or [None])[0],
                'x': v.get('x'), 'y': v.get('y'), 'w': v.get('width'), 'h': v.get('height')
            })
        elif it.get('type') in ('textarea', 'text', 'richtext', 'number'):
            v = it.get('value') or {}
            if v.get('number') is not None:
                t = str(v['number'])
            else:
                t = v.get('text')
                t = ''.join(t) if isinstance(t, list) else (t or '')
            texts.append({'id': str(it['id']), 'parent': it.get('parent_id') if it.get('parent_id') is None else str(it.get('parent_id')), 't': str(t).strip()})
    for b in rects:
        b['n'] = ''
        for t in texts:
            if t['id'] == b['rid'] or (t['parent'] and t['parent'] == b['rid']):
                b['n'] = t['t']
        b['cx'] = b['x'] + b['w'] / 2
        b['cy'] = b['y'] + b['h'] / 2
    return rects

def dist(a, b):
    return math.hypot(a['cx'] - b['cx'], a['cy'] - b['cy'])

def match_prev(cur, prev):
    """cur box -> (prev idx, dist)；同号优先(容差25)，否则同标签(容差6)"""
    best, bd = None, None
    for i, p in enumerate(prev):
        same = bool(cur['n']) and cur['n'] == p['n'] and cur['label'] == p['label']  # v4: 同号必须同标签
        if not same and cur['label'] != p['label']:
            continue
        d = dist(cur, p)
        tol = CLAIM_TOL  # v8: 身份认领门槛（超过=误识别框→删+补框，不再直接补号）
        if d > tol:
            continue
        if bd is None or d < bd:
            bd, best = d, i
    return best, bd

def correct(cur_boxes, prev_boxes):
    """返回 (修正后框列表, 动作日志)"""
    out, log = [], []
    used = set()
    # v5 两阶段匹配：第一轮同号同标签绝对优先（不受位置远近影响），第二轮才按位置
    pre_match = {}
    for i, b in enumerate(cur_boxes):
        if not b['n']:
            continue
        best, bd = None, None
        for j, p in enumerate(prev_boxes):
            if j in pre_match.values():
                continue
            if b['n'] == p['n'] and b['label'] == p['label']:
                d = dist(b, p)
                if d > CLAIM_TOL:  # v8: 同号也必须贴近上一帧位置，防止远处误检框抢号
                    continue
                if bd is None or d < bd:
                    bd, best = d, j
        if best is not None:
            pre_match[i] = best
    # v8b 第二轮：全局贪心按距离配对（最近的优先认领，防止左侧远框抢先）
    pairs = []
    for i, b in enumerate(cur_boxes):
        if i in pre_match or (b['label'] or '') == 'unknown':
            continue
        for j, p in enumerate(prev_boxes):
            if j in pre_match.values():
                continue
            if b['label'] != p['label']:
                continue
            d = dist(b, p)
            if d <= CLAIM_TOL:
                pairs.append((d, i, j))
    pairs.sort()
    greedy = {}
    used_i, used_j = set(pre_match), set(pre_match.values())
    for d, i, j in pairs:
        if i in used_i or j in used_j:
            continue
        greedy[i] = j
        used_i.add(i)
        used_j.add(j)
    order = sorted(range(len(cur_boxes)), key=lambda i: (0 if cur_boxes[i]['n'] else 1, cur_boxes[i]['cx']))
    for i in order:
        b = cur_boxes[i]
        if (b['label'] or '') == 'unknown':
            log.append(('删', f"unknown @({b['cx']:.1f},{b['cy']:.1f})"))
            continue
        mi = pre_match.get(i, greedy.get(i))
        if mi is None:
            log.append(('删', f"{b['label']}#{b['n'] or '无号'} @({b['cx']:.1f},{b['cy']:.1f}) 上一帧无对应"))
            continue
        if mi in used:
            log.append(('删', f"{b['label']}#{b['n'] or '无号'} @({b['cx']:.1f},{b['cy']:.1f}) 重复框（同位置已有）"))
            continue
        used.add(mi)
        p = prev_boxes[mi]
        if not p['n']:
            log.append(('删', f"{b['label']}#{b['n'] or '无号'} @({b['cx']:.1f},{b['cy']:.1f}) 上一帧也无号，不保留"))
            continue
        nb = dict(b)
        if b['n'] != p['n']:
            log.append(('号', f"@({b['cx']:.1f},{b['cy']:.1f}) {b['n'] or '无号'}→{p['n']}"))
        if b['label'] != p['label']:
            log.append(('签', f"@({b['cx']:.1f},{b['cy']:.1f}) {b['label']}→{p['label']}"))
        nb['label'], nb['n'] = p['label'], p['n']
        out.append(nb)
    for i, p in enumerate(prev_boxes):
        if i in used:
            continue
        if not p['n']:
            continue   # 无号框一律不补（用户：没删框的问题根源）
        nb = dict(p)
        nb['rid'] = None   # 强制生成新 id（沿用上一帧 id 会与本帧框撞车 → LS 存时吞框）
        if USE_INTERP:
            fp = fill_pos(p['label'], p['n'], CUR_FRAME, {'x': p['x'], 'y': p['y'], 'w': p['w'], 'h': p['h']})
            nb['x'], nb['y'], nb['w'], nb['h'] = fp['x'], fp['y'], fp['w'], fp['h']
            nb['cx'] = nb['x'] + nb['w'] / 2
            nb['cy'] = nb['y'] + nb['h'] / 2
        out.append(nb)
        log.append(('补', f"{p['label']}#{p['n'] or '无号'} @({nb['cx']:.1f},{nb['cy']:.1f}) 上一帧有、本帧缺" + ("（插值补位）" if USE_INTERP else "")))
    return out, log

def build_result(boxes, src_items, frame):
    """用原始条目做模板，生成完整 LS result 数组（保留原 id，新增框用新 id）"""
    rect_tpl = next((i for i in src_items if i.get('type') == 'rectanglelabels'), None)
    text_tpl = next((i for i in src_items if i.get('type') in ('textarea', 'text', 'richtext')), None)
    ow = rect_tpl.get('original_width', 1920) if rect_tpl else 1920
    oh = rect_tpl.get('original_height', 1080) if rect_tpl else 1080
    out = []
    used_ids = set()
    for k, b in enumerate(boxes):
        rid = b.get('rid') or ('lsfi_' + str(frame) + '_' + str(k))
        if rid in used_ids:
            rid = 'lsfi_' + str(frame) + '_' + str(k) + '_' + str(len(used_ids))
        used_ids.add(rid)
        out.append({
            'id': rid, 'type': 'rectanglelabels',
            'from_name': rect_tpl.get('from_name', 'label'), 'to_name': rect_tpl.get('to_name', 'image'),
            'value': {'x': b['x'], 'y': b['y'], 'width': b['w'], 'height': b['h'], 'rectanglelabels': [b['label']]},
            'original_width': ow, 'original_height': oh, 'image_rotation': 0
        })
        if b['n']:
            out.append({
                'id': rid, 'type': 'textarea',
                'from_name': text_tpl.get('from_name', 'number') if text_tpl else 'number',
                'to_name': text_tpl.get('to_name', 'image') if text_tpl else 'image',
                'value': {'text': [str(b['n'])]}
            })
    return out


# ===== v6 插值补框：批量 >100 帧时，缺框位置取前后最近的凉白开真实检出做线性插值 =====
BATCH_N = 9250 - 9190 + 1
CLAIM_TOL = 2.0  # v8b 认领门槛：真实漂移0-0.7 / 误识别框2.7-5.0，取2.0居中
USE_INTERP = False  # v5 补框（贴上一帧位置），v6 插值已弃用
detect_map = {}
if USE_INTERP:
    for ff in range(9190, 9251):
        frx = RAW.get(str(ff))
        if not frx or not frx.get('pred'):
            continue
        for bb in parse(frx['pred']['result']):
            if bb['n'] and (bb['label'] or '') != 'unknown':
                detect_map.setdefault((bb['label'], bb['n']), {})[ff] = (bb['x'], bb['y'], bb['w'], bb['h'])

def fill_pos(label, n, frame, fallback):
    """缺框补位：前后最近真实检出线性插值；无检出数据时用 fallback（上一帧位置）"""
    dm = detect_map.get((label, n))
    if not dm:
        return fallback
    frames = sorted(dm)
    before = max((ff for ff in frames if ff <= frame), default=None)
    after = min((ff for ff in frames if ff >= frame), default=None)
    if before is not None and after is not None and before != after:
        t = (frame - before) / (after - before)
        pa, pb = dm[before], dm[after]
        return {k: pa[i] + (pb[i] - pa[i]) * t for i, k in enumerate(('x', 'y', 'w', 'h'))}
    ref = before if before is not None else after
    if ref is None:
        return fallback
    px = dm[ref]
    return {'x': px[0], 'y': px[1], 'w': px[2], 'h': px[3]}

# 逐帧修正：6506 的上一帧是 6505 的 244 标注；之后每帧用我刚写好的结果
prev_boxes = parse(RAW['9189']['ann']['result'])
payloads = {}
report = []
report.append('基准帧 9189（用户修正后的 244 标注）【正向·凉白开位置·v6 插值强制】：' + ', '.join(f"{b['label']}#{b['n']}" for b in sorted(prev_boxes, key=lambda x: x['cx'])))

for f in range(9190, 9251):
    fr = RAW[str(f)]
    src = fr['pred'] or fr['ann']   # 本批规则：位置以凉白开原始预测为准（此前数据跑错了）
    src_kind = 'pred(凉白开位置)'
    cur = parse(src['result'])
    globals()['CUR_FRAME'] = f
    fixed, log = correct(cur, prev_boxes)
    nums = sorted([b['n'] for b in fixed if b['n']], key=int)
    report.append(f"\n帧 {f}（{src_kind}起稿 {len(cur)} 框 → 修正后 {len(fixed)} 框，号码 {nums}）")
    for act, what in log:
        report.append(f"   [{act}] {what}")
    payloads[str(f)] = {
        'taskId': fr['id'],
        'annId': fr['ann']['id'] if fr['ann'] else None,
        'result': build_result(fixed, src['result'], f),
        'summary': f"{len(cur)}框→{len(fixed)}框, 动作{len(log)}个"
    }
    prev_boxes = fixed

json.dump(payloads, open('数据/write_payloads_9190_9250_v2.json', 'w'), ensure_ascii=False, indent=1)
print('\n'.join(report))
print('\n=== payload 已生成 ===')
