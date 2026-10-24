import json
import csv
import collections
import os
import sys

CAM_INFO = {'cam2': ('数据/raw_cam2.json', 5), 'cam3': ('数据/raw_cam3.json', 6), 'cam4': ('数据/cam4_tasks.json', 7),
            'cam5': ('数据/raw_cam5.json', 8), 'cam6': ('数据/raw_cam6.json', 9), 'cam7': ('数据/raw_cam7.json', 10),
            'cam8': ('数据/raw_cam8.json', 11), 'cam9': ('数据/raw_cam9.json', 12), 'cam10': ('数据/raw_cam10.json', 14),
            'cam11': ('数据/raw_cam11.json', 15), 'cam12': ('数据/raw_cam12.json', 16)}

cam = sys.argv[1]
raw_file, pid = CAM_INFO[cam]

tasks = json.load(open(raw_file))
tasks.sort(key=lambda t: t['data'].get('frame', 0))
f2id = {t['data'].get('frame'): t['id'] for t in tasks}

W, H = 1920.0, 1080.0


def dedup_boxes(bs):
    bs = sorted(bs, key=lambda b: (b.get('number') in (None, ''),))
    kept = []
    for b in bs:
        if any(((b['cx'] - k['cx']) * W / 100) ** 2 + ((b['cy'] - k['cy']) * H / 100) ** 2 < 400 for k in kept):
            continue
        kept.append(b)
    return kept


frames = []
for t in tasks:
    res = (t.get('predictions') or [{}])[0].get('result', [])
    boxes = {}
    for r in res:
        rid = r.get('id')
        b = boxes.setdefault(rid, {'rid': rid})
        if r.get('type') == 'rectanglelabels':
            v = r['value']
            b.update(label=(v.get('rectanglelabels') or [None])[0],
                     cx=v['x'] + v['width'] / 2, cy=v['y'] + v['height'] / 2,
                     w=v['width'], h=v['height'])
        elif r.get('type') == 'textarea':
            b['number'] = (r['value'].get('text') or [None])[0]
    frames.append((t['data'].get('frame'), dedup_boxes([b for b in boxes.values() if b.get('label')])))


def px(b):
    return (b['cx'] * W / 100.0, b['cy'] * H / 100.0)


frame_index = {}
for _f, _bs in frames:
    frame_index[_f] = [(b['cx'], b['cy'], b.get('label'), str(b.get('number') or '').strip()) for b in _bs]


def team_centroid(fr, win=12):
    ax = bx = na = nb = 0.0
    lo, hi = frames[0][0], frames[-1][0]
    for f in range(max(lo, fr - win), min(hi, fr + win) + 1):
        for (cx_, cy_, blab, bnum) in frame_index.get(f, []):
            if blab == 'teamA':
                ax += cx_
                na += 1
            elif blab == 'teamB':
                bx += cx_
                nb += 1
    if not na or not nb:
        return None
    return (ax / na, bx / nb)


def infer_team(fr, x, y):
    votes = []
    c = team_centroid(fr)
    if c:
        votes.append('teamA' if abs(x - c[0]) <= abs(x - c[1]) else 'teamB')
    clue = neighbor_clue(fr, x, y, k=3)
    labs = [t for t in ('teamA', 'teamB') if t in clue]
    if labs:
        votes.append(collections.Counter(labs).most_common(1)[0][0])
    if len(votes) == 2 and votes[0] == votes[1]:
        return votes[0], '动态位置+邻轨一致'
    if len(votes) == 2:
        return '', '动态位置与邻轨不一致,须上站'
    return (votes[0] if votes else ''), '仅单一依据'


def neighbor_clue(fr, x, y, r=150, k=3):
    out = []
    for (bx, by, blab, bnum) in frame_index.get(fr, []):
        if blab not in ('teamA', 'teamB', 'goalkeeperA', 'goalkeeperB'):
            continue
        dx = (bx - x) * W / 100.0
        dy = (by - y) * H / 100.0
        d = (dx * dx + dy * dy) ** 0.5
        if d < r:
            out.append((d, blab, bnum))
    out.sort()
    return '；'.join(f'{blab}#{bnum or "无号"}({d:.0f}px)' for d, blab, bnum in out[:k])


num_team_cnt = collections.defaultdict(collections.Counter)
num_first_frame = {}
for _f, _bs in frames:
    for b in _bs:
        n = str(b.get('number') or '').strip()
        if n and b.get('label') in ('teamA', 'teamB'):
            num_team_cnt[n][b['label']] += 1
            num_first_frame.setdefault(n, _f)

NUM_SUPPORT_MIN = 100
num_purity = {}
for n, c in num_team_cnt.items():
    a, b = c['teamA'], c['teamB']
    tot = a + b
    if tot < NUM_SUPPORT_MIN:
        continue
    num_purity[n] = (a, b, a / tot)
json.dump({k: list(v) for k, v in num_purity.items()}, open(f'数据/num_purity_{cam}.json', 'w'), ensure_ascii=False)

CONSENSUS = '数据/roster_consensus.json'
if os.path.exists(CONSENSUS):
    cons = json.load(open(CONSENSUS))
    num_team = {n: t for n, t in cons['num_team'].items()}
    num_purity = {n: tuple(v) for n, v in cons['num_purity'].items()}
else:
    num_team = {}
    for n, (a, b, pa) in num_purity.items():
        if pa >= 0.9:
            num_team[n] = 'teamA'
        elif pa <= 0.1:
            num_team[n] = 'teamB'
        elif 0.4 <= pa <= 0.6:
            num_team[n] = 'both'
        else:
            num_team[n] = 'teamA' if pa > 0.5 else 'teamB'


tracks = {}
active = []
next_tid = 1
for f, players in frames:
    cand = []
    for ai, (tid, lf, tx, ty) in enumerate(active):
        gap = f - lf
        if gap > 3:
            continue
        cap = 45 + 12 * (gap - 1)
        tlab = tracks[tid]['members'][-1][2]
        for b in players:
            bl = b.get('label')
            if bl and tlab and bl != tlab and 'unknown' not in (bl, tlab):
                continue
            x, y = px(b)
            d = ((x - tx) ** 2 + (y - ty) ** 2) ** 0.5
            if d <= cap:
                cand.append((d, ai, b, x, y))
    cand.sort(key=lambda c: c[0])
    used_tracks, used_boxes = set(), set()
    for d, ai, b, x, y in cand:
        if ai in used_tracks or id(b) in used_boxes:
            continue
        used_tracks.add(ai)
        used_boxes.add(id(b))
        tid = active[ai][0]
        tracks[tid]['members'].append((f, b['rid'], b['label'], b.get('number'), b['cx'], b['cy']))
        active[ai] = (tid, f, x, y)
    for b in players:
        if id(b) in used_boxes:
            continue
        x, y = px(b)
        tracks[next_tid] = {'id': next_tid, 'members': [(f, b['rid'], b['label'], b.get('number'), b['cx'], b['cy'])]}
        active.append((next_tid, f, x, y))
        next_tid += 1
    active = [a for a in active if f - a[1] <= 3]

lens = sorted(len(t['members']) for t in tracks.values())


def runs_of(seq, key):
    out = []
    sentinel = object()
    cur_v, cur_start = sentinel, 0
    for i, item in enumerate(seq):
        v = key(item)
        if v != cur_v:
            if cur_v is not sentinel:
                out.append((cur_v, cur_start, i - 1))
            cur_v, cur_start = v, i
    if cur_v is not sentinel:
        out.append((cur_v, cur_start, len(seq) - 1))
    return out


def ctx_str(rs, cur, ms):
    parts = []
    for v, i, j in rs:
        s = '∅' if v is None else str(v)
        f0, f1 = ms[i][0], ms[j][0]
        rng = f'{f0}' if f0 == f1 else f'{f0}-{f1}'
        seg = f"{s}×{j - i + 1}[{rng}]"
        if (v, i, j) == cur:
            i0, i1 = f2id.get(f0), f2id.get(f1)
            idr = f'{i0}' if i0 == i1 else f'{i0}-{i1}'
            seg = '▶' + seg + f'(ID {idr})'
        parts.append(seg)
    if len(parts) > 12:
        parts = parts[:5] + ['…'] + parts[-6:]
    return ' → '.join(parts)


def dom_num_of(ms):
    c = collections.Counter(str(m[3]).strip() for m in ms if m[3] not in (None, ''))
    return c.most_common(1)[0][0] if c else ''


# 碎片轨迹缝合：同主号码 + 间隔1-30帧 + 新起点距旧终点≤60px（或预测吻合80px内）→ 并回原轨迹
def stitch():
    changed = True
    while changed:
        changed = False
        ends, starts = {}, {}
        for tid_, t in tracks.items():
            ms = t['members']
            ends[tid_] = (ms[-1][0], ms[-1][4] * W / 100.0, ms[-1][5] * H / 100.0)
            starts[tid_] = (ms[0][0], ms[0][4] * W / 100.0, ms[0][5] * H / 100.0)
        for a, (af, ax, ay) in ends.items():
            for b, (bf, bx, by) in starts.items():
                if a == b or a not in tracks or b not in tracks:
                    continue
                if not (1 <= bf - af <= 30):
                    continue
                if ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5 > 60:
                    continue
                na, nb = dom_num_of(tracks[a]['members']), dom_num_of(tracks[b]['members'])
                la = collections.Counter(m[2] for m in tracks[a]['members'] if m[2] not in (None, 'unknown')).most_common(1)
                lb = collections.Counter(m[2] for m in tracks[b]['members'] if m[2] not in (None, 'unknown')).most_common(1)
                if not (na and nb and na == nb):
                    continue
                if la and lb and la[0][0] != lb[0][0]:
                    continue
                tracks[a]['members'].extend(tracks[b]['members'])
                tracks[a]['members'].sort(key=lambda m: m[0])
                del tracks[b]
                changed = True
                break
            if changed:
                break


stitch()

roster_support = collections.Counter()
for t in tracks.values():
    ms = t['members']
    lab = collections.Counter(m[2] for m in ms if m[2] not in (None, 'unknown'))
    nums = collections.Counter(str(m[3]).strip() for m in ms if m[3] is not None and str(m[3]).strip() != '')
    if not lab or not nums:
        continue
    dl, dn = lab.most_common(1)[0][0], nums.most_common(1)[0][0]
    roster_support[(dl, dn)] += nums.most_common(1)[0][1]

roster = collections.defaultdict(set)
for n, t in num_team.items():
    if t in ('teamA', 'both'):
        roster['teamA'].add(n)
    if t in ('teamB', 'both'):
        roster['teamB'].add(n)

review = []
autofix = []
runlen_hist = collections.Counter()

for n, t in num_team.items():
    if t != 'both':
        continue
    a, b, pa = num_purity[n]
    la, lb = num_team_cnt[n]['teamA'], num_team_cnt[n]['teamB']
    ff = num_first_frame.get(n, frames[0][0])
    review.append(dict(track='', track_len=0, f0=ff, f1=ff, label_now='双方', rid='',
                       issue='双方队号码重复(须审核)', pri='P0', num_now=n, num_sug='',
                       ev=f'号码{n}本机位 teamA {la}框 / teamB {lb}框；跨11机位合并A占比{pa * 100:.0f}%→ 若实际仅一队使用该号，另一队所有该号框都错，请优先审核',
                       ctx='', hint=''))

for t in tracks.values():
    ms = t['members']
    n = len(ms)
    lab_c = collections.Counter(m[2] for m in ms if m[2] not in (None, 'unknown'))
    num_c = collections.Counter(str(m[3]).strip() for m in ms if m[3] is not None and str(m[3]).strip() != '')
    dom_lab = lab_c.most_common(1)[0][0] if lab_c else None
    dom_num = num_c.most_common(1)[0][0] if num_c else None
    dom_num_sup = num_c.most_common(1)[0][1] if num_c else 0
    dom_lab_sup = lab_c.most_common(1)[0][1] if lab_c else 0
    numbered = sum(num_c.values())

    def base_row(i, j):
        return dict(track=t['id'], track_len=n, f0=ms[i][0], f1=ms[j][0], label_now=ms[i][2], rid=ms[i][1])

    def num_hint(i, j):
        pk = next((k for k in range(i - 1, -1, -1) if ms[k][3] not in (None, '')), None)
        nk = next((k for k in range(j + 1, n) if ms[k][3] not in (None, '')), None)
        pv = str(ms[pk][3]).strip() if pk is not None else ''
        nx = str(ms[nk][3]).strip() if nk is not None else ''
        pt = f'(帧{ms[pk][0]})' if pk is not None else ''
        nt = f'(帧{ms[nk][0]})' if nk is not None else ''
        return f"前帧同位置={pv or '无号码'}{pt} / 后帧同位置={nx or '无号码'}{nt}"

    numkey = lambda m: str(m[3]).strip() if m[3] is not None and str(m[3]).strip() != '' else None
    nrs = runs_of(ms, numkey)
    for v, i, j in nrs:
        if v is not None:
            own_team = ms[i][2]
            dt = num_team.get(v)
            if dt in ('teamA', 'teamB') and own_team in ('teamA', 'teamB') and dt != own_team:
                a, b, pa = num_purity[v]
                row = base_row(i, j)
                row.update(issue='号码队别不符(疑似队别标错或号码误识)', pri='P1', num_now=v, num_sug='',
                           ctx=ctx_str(nrs, (v, i, j), ms), hint=num_hint(i, j),
                           ev=f'号码{v}全片{pa * 100:.0f}%属于{dt}（A{a}/B{b}），本轨迹标注为{own_team}（{j - i + 1}帧）→队别或号码有一个错')
                review.append(row)
                continue
        if v is None:
            own = ms[i][2]
            bad_roster = own in roster and dom_num not in roster.get(own, set())
            if dom_num and not bad_roster and dom_num_sup >= max(5, numbered * 0.5) and j - i + 1 <= 8:
                row = base_row(i, j)
                row.update(issue='号码缺失(可自动补)', pri='P0', num_now='', num_sug=dom_num, ctx=ctx_str(nrs, (v, i, j), ms), hint=num_hint(i, j))
                review.append(row)
                for k in range(i, j + 1):
                    autofix.append((ms[k][0], ms[k][1], 'number', '', dom_num, '补缺失号码'))
            elif bad_roster:
                row = base_row(i, j)
                row.update(issue='号码缺失(主号码非本队名单,须人工)', pri='P1', num_now='', num_sug='',
                           ctx=ctx_str(nrs, (v, i, j), ms), hint=num_hint(i, j),
                           ev=f'轨迹主号码{dom_num}不在{own}名单')
                review.append(row)
            else:
                row = base_row(i, j)
                row.update(issue='号码缺失(无轨迹依据)', pri='P2', num_now='', num_sug='', ctx=ctx_str(nrs, (v, i, j), ms), hint=num_hint(i, j))
                review.append(row)
            continue
        if dom_num is None or v == dom_num:
            continue
        runlen_hist[j - i + 1] += 1
        strong = dom_num_sup >= max(5, numbered * 0.5)
        other_team = [lt for lt in roster if v in roster[lt] and lt != ms[i][2]]
        dom_nonroster = dom_lab in roster and dom_num not in roster.get(dom_lab, set())
        if strong and not other_team and not dom_nonroster:
            pri, issue, sug = 'P0', '号码闪烁(可自动改)', dom_num
            for k in range(i, j + 1):
                autofix.append((ms[k][0], ms[k][1], 'number', v, dom_num, '轨迹众数纠错'))
        else:
            pri, issue, sug = 'P0', '持续号码冲突(疑似换人/换号)', ''
            if strong and not dom_nonroster:
                issue = '号码冲突(暂缓自动改)'
        if other_team:
            issue += f';该号码属{"/".join(other_team)}名单'
        if dom_nonroster:
            issue += f';主号码{dom_num}非{dom_lab}名单'
        row = base_row(i, j)
        row.update(issue=issue, pri=pri, num_now=v, num_sug=sug,
                   ev=f'轨迹{n}帧/主号码{dom_num}支持{dom_num_sup}/{numbered}', ctx=ctx_str(nrs, (v, i, j), ms), hint=num_hint(i, j))
        review.append(row)

    lrs = runs_of(ms, lambda m: m[2])
    for v, i, j in lrs:
        if v == dom_lab or v is None:
            continue
        if v == 'unknown' or dom_lab is None:
            row = base_row(i, j)
            clue = neighbor_clue(ms[i][0], ms[i][4], ms[i][5])
            sug = dom_lab or ''
            src_note = '轨迹主导队别'
            if not sug:
                sug, why = infer_team(ms[i][0], ms[i][4], ms[i][5])
                src_note = f'动态推断({why})'
            ev_u = (f'队别来源: {src_note}' if sug else '无稳定依据') + '；邻轨线索: ' + (clue or '同帧150px内无已知队别框')
            row.update(issue='unknown待归类', pri='P2', num_now=str(ms[i][3] or ''), num_sug=sug or '',
                       ctx=ctx_str(lrs, (v, i, j), ms), hint=num_hint(i, j), ev=ev_u)
            review.append(row)
            continue
        if dom_lab_sup >= max(5, n * 0.5):
            row = base_row(i, j)
            row.update(issue='队别闪烁(可自动改)', pri='P0', num_now=str(ms[i][3] or ''), num_sug=dom_lab,
                       ev=f'轨迹{n}帧/主队别{dom_lab}支持{dom_lab_sup}', ctx=ctx_str(lrs, (v, i, j), ms), hint=num_hint(i, j))
            review.append(row)
            for k in range(i, j + 1):
                autofix.append((ms[k][0], ms[k][1], 'label', v, dom_lab, '轨迹主队别纠错'))
        else:
            row = base_row(i, j)
            row.update(issue='持续队别冲突', pri='P0', num_now=str(ms[i][3] or ''), num_sug='', ctx=ctx_str(lrs, (v, i, j), ms), hint=num_hint(i, j))
            review.append(row)

# 运动规律二次校验（固定机位：每帧位移小且连续）+ 丢框/离场检测
last_frame = frames[-1][0] if frames else 0
frame_boxes = {}
for tid_, t in tracks.items():
    for m in t['members']:
        frame_boxes.setdefault(m[0], []).append((m[4], m[5], tid_, m[3], m[2]))


def team_counts_at(fr, x, y, r=120, exclude=()):
    c = collections.Counter()
    for (bx, by, btid, bnum, blab) in frame_boxes.get(fr, []):
        if btid in exclude or not blab:
            continue
        bxp, byp = bx * W / 100.0, by * H / 100.0
        if ((bxp - x) ** 2 + (byp - y) ** 2) ** 0.5 < r:
            c[blab] += 1
    return c


def team_delta_txt(end_f, ex, ey, dlab, exclude):
    lo, hi = frames[0][0], frames[-1][0]
    bfr = [team_counts_at(f, ex, ey) for f in range(max(lo, end_f - 5), end_f) if f in frame_boxes]
    afr = [team_counts_at(f, ex, ey) for f in range(end_f + 1, min(hi, end_f + 6) + 1) if f in frame_boxes]
    teams = ('teamA', 'teamB', 'goalkeeperA', 'goalkeeperB')

    def med(cs, t):
        v = sorted(c.get(t, 0) for c in cs)
        return v[len(v) // 2] if v else 0

    before = {t: med(bfr, t) for t in teams}
    after = {t: med(afr, t) for t in teams}
    deltas = {t: after[t] - before[t] for t in teams if before[t] or after[t]}
    lost = [t for t, d in deltas.items() if d < 0]
    bs = '/'.join(f'{t}{before[t]}' for t in teams if before[t]) or '无'
    as_ = '/'.join(f'{t}{after[t]}' for t in teams if after[t]) or '无'
    txt = f'区域(120px)单帧队别计数中位数 消失前5帧[{bs}]→后5帧[{as_}]'
    if lost:
        worst = min(lost, key=lambda t: deltas[t])
        if worst == dlab:
            txt += f'，减少的正是{worst}→与消失轨迹队别一致，确认丢的是{worst}的框'
        else:
            txt += f'，但减少的是{worst}而消失轨迹标为{dlab}→队别(颜色)标注可疑，须人工'
    else:
        txt += '，无队伍减少→该区域框数未变，无法用队别佐证（可能丢的框被同队他人补位或半径外）'
    return txt


def predict(ms, k=3):
    if len(ms) < k + 1:
        return None
    vxs, vys = [], []
    for i in range(len(ms) - k, len(ms)):
        gap = max(ms[i][0] - ms[i - 1][0], 1)
        vxs.append((ms[i][4] - ms[i - 1][4]) * W / 100.0 / gap)
        vys.append((ms[i][5] - ms[i - 1][5]) * H / 100.0 / gap)
    return (ms[-1][4] * W / 100.0, ms[-1][5] * H / 100.0, sum(vxs) / k, sum(vys) / k)


JUMP_MIN, PRED_TOL = 60.0, 60.0
n_jump = n_drop = n_reswitch = n_short = n_edge = n_predok = n_frag = 0

for tid_, t in tracks.items():
    ms = t['members']
    lab = collections.Counter(m[2] for m in ms if m[2] not in (None, 'unknown'))
    dlab = lab.most_common(1)[0][0] if lab else 'unknown'
    dnum = dom_num_of(ms)

    # 1) 轨迹内位置跳变：单帧位移远超该轨迹中位步长 = 框跟错了人
    if len(ms) >= 6:
        perf = []
        for i in range(1, len(ms)):
            gap = max(ms[i][0] - ms[i - 1][0], 1)
            perf.append((((ms[i][4] - ms[i - 1][4]) * W / 100.0) ** 2 +
                         ((ms[i][5] - ms[i - 1][5]) * H / 100.0) ** 2) ** 0.5 / gap)
        med = sorted(perf)[len(perf) // 2]
        for i in range(1, len(ms)):
            if perf[i - 1] > max(JUMP_MIN, 5 * med):
                n_jump += 1
                review.append(dict(track=tid_, track_len=len(ms), f0=ms[i][0], f1=ms[i][0],
                                   label_now=ms[i][2], rid=ms[i][1],
                                   issue='位置跳变(单帧位移超阈,疑似换框/跟错人)', pri='P1',
                                   num_now=str(ms[i][3] or ''), num_sug='',
                                   ev=f'该帧位移{perf[i-1]:.0f}px，轨迹中位步长{med:.0f}px；前帧号码{ms[i-1][3] or "无"}→本帧{ms[i][3] or "无"}',
                                   ctx='', hint=''))

    # 2) 中途结束：先看本人同号框是否仍在附近（在=碎片；不在=真丢框）
    if len(ms) < 10 or sum(1 for m in ms if m[3] not in (None, '')) < 5:
        continue
    end_f = ms[-1][0]
    if last_frame - end_f <= 2:
        continue
    ex, ey = ms[-1][4] * W / 100.0, ms[-1][5] * H / 100.0
    pred = predict(ms, 3)
    base = dict(track=tid_, track_len=len(ms), f0=end_f, f1=end_f, label_now=dlab, rid=ms[-1][1])

    own_again = None
    if dnum:
        for ff in range(end_f + 1, min(end_f + 11, last_frame + 1)):
            for (bx, by, btid, bnum, blab) in frame_boxes.get(ff, []):
                if btid == tid_ or (bnum or '').strip() != dnum:
                    continue
                bxp, byp = bx * W / 100.0, by * H / 100.0
                d = ((bxp - ex) ** 2 + (byp - ey) ** 2) ** 0.5
                if d < 150 and (own_again is None or d < own_again[1]):
                    own_again = (ff, d)
    if own_again:
        n_frag += 1
        review.append(dict(base, issue='轨迹接续(同号框仍在附近,疑碎片)', pri='P2', num_now=dnum, num_sug='',
                           ev=f'轨迹{len(ms)}帧(主号码{dnum})于帧{end_f}结束，但{own_again[0]}帧同号码框仍在{own_again[1]:.0f}px内→关联碎片，非丢框',
                           ctx='', hint=''))
        continue

    best = None
    for ff in range(end_f + 1, min(end_f + 31, last_frame + 1)):
        for (bx, by, btid, bnum, blab) in frame_boxes.get(ff, []):
            if btid == tid_:
                continue
            bxp, byp = bx * W / 100.0, by * H / 100.0
            dp = None
            if pred:
                ppx, ppy = pred[0] + pred[2] * (ff - end_f), pred[1] + pred[3] * (ff - end_f)
                dp = ((bxp - ppx) ** 2 + (byp - ppy) ** 2) ** 0.5
            if (dp is not None and dp < 80) or ((bxp - ex) ** 2 + (byp - ey) ** 2) ** 0.5 < 100:
                if best is None or (dp if dp is not None else 9e9) < best[2]:
                    best = (ff, btid, dp if dp is not None else 9e9, bxp, byp)
    if best:
        ff, btid, dp, bxp, byp = best
        cms = tracks[btid]['members']
        cnum = dom_num_of(cms)
        cstart = cms[0][0]
        predtxt = f'运动预测偏差{dp:.0f}px' if dp < 9e8 else '无运动预测'
        tdtxt = team_delta_txt(end_f, ex, ey, dlab, exclude={tid_})
        if cstart > end_f and dp is not None and dp < PRED_TOL:
            pri, issue, sug = 'P0', '运动吻合(大概率同一人,号码疑误)', dnum
            n_reswitch += 1
            n_predok += 1
            ev = f'轨迹{len(ms)}帧(主号码{dnum or "无"})于帧{end_f}结束，{ff}帧同位置新出现号码{cnum or "无"}的轨迹；{predtxt}→大概率同一人、号码识别错误（仍请人工确认）；{tdtxt}'
        elif cstart > end_f:
            pri, issue, sug = 'P1', '丢框后重现但与运动预测不符(须人工)', ''
            n_reswitch += 1
            ev = f'轨迹{len(ms)}帧(主号码{dnum or "无"})于帧{end_f}结束，{ff}帧同位置新出现号码{cnum or "无"}的轨迹；{predtxt}→偏离预测轨迹，大概率他人或球员变向，须人工；{tdtxt}'
        else:
            pri, issue, sug = 'P1', '丢框后原位被其他球员占位(重叠/串框,须人工)', ''
            n_reswitch += 1
            ev = f'轨迹{len(ms)}帧(主号码{dnum or "无"})于帧{end_f}结束，本人同号框此后再未出现；该位置由号码{cnum or "无"}的轨迹（起始帧{cstart}）占位→原位丢框或被串框，须人工；{tdtxt}'
        review.append(dict(base, issue=issue, pri=pri, num_now=cnum, num_sug=sug,
                           ev=ev, ctx='', hint=''))
    else:
        edge = ms[-1][4] < 3 or ms[-1][4] > 97 or ms[-1][5] < 3 or ms[-1][5] > 97
        if pred:
            ppx, ppy = pred[0] + pred[2] * 30, pred[1] + pred[3] * 30
            predtxt = f'按末速预测30帧后应在({ppx:.0f},{ppy:.0f})px，实际无框'
        else:
            predtxt = ''
        if edge:
            pri, issue = 'P2', '轨迹终止于画面边缘(疑似正常离场)'
            n_edge += 1
        else:
            pri, issue = 'P2', '中途消失且未重现(半场视角可能正常离场)'
            n_drop += 1
        review.append(dict(base, issue=issue, pri=pri, num_now=dnum, num_sug='',
                           ev=f'轨迹{len(ms)}帧(主号码{dnum or "无"})于帧{end_f}后无同位置重现，末位置({ex:.0f},{ey:.0f})px；{predtxt}；{team_delta_txt(end_f, ex, ey, dlab, exclude={tid_})}',
                           ctx='', hint=''))

print(f'  运动校验: 位置跳变{n_jump} | 号码疑误{n_predok} | 须人工{n_reswitch} | 中途消失{n_drop} | 碎片接续{n_frag} | 边缘离场{n_edge}', flush=True)

cntA = [sum(1 for b in pl if b['label'] == 'teamA') for _, pl in frames]
cntB = [sum(1 for b in pl if b['label'] == 'teamB') for _, pl in frames]
for name, cnts in (('teamA', cntA), ('teamB', cntB)):
    med = sorted(cnts)[len(cnts) // 2]
    cur = None
    for i, c in enumerate(cnts):
        if c == 0 and med >= 3:
            if cur is None:
                cur = i
        elif cur is not None:
            review.append(dict(track='', track_len=0, f0=frames[cur][0], f1=frames[i - 1][0], label_now=name,
                               issue=f'{name}整段0检出(半场视角或正常离场)', pri='P2', num_now='', num_sug='',
                               ev=f'全片中位检出数={med}；半场镜头下全队移出画面属正常，仅提示'))
            cur = None
    if cur is not None:
        review.append(dict(track='', track_len=0, f0=frames[cur][0], f1=frames[-1][0], label_now=name,
                           issue=f'{name}整段0检出(半场视角或正常离场)', pri='P2', num_now='', num_sug='',
                           ev=f'全片中位检出数={med}；半场镜头下全队移出画面属正常，仅提示'))

json.dump(review, open(f'数据/review_{cam}.json', 'w'), ensure_ascii=False)
json.dump({k: sorted(v, key=int) for k, v in roster.items()}, open(f'数据/roster_{cam}.json', 'w'), ensure_ascii=False)
json.dump(dict(runlen=sorted(runlen_hist.items()), tracks=len(tracks),
               lens_med=lens[len(lens) // 2], lens_p90=lens[int(len(lens) * 0.9)], lens_max=lens[-1],
               frames=len(frames), boxes=sum(len(p) for _, p in frames)),
          open(f'数据/diag_{cam}.json', 'w'), ensure_ascii=False)
with open(f'数据/autofix_{cam}.csv', 'w', newline='', encoding='utf-8-sig') as fcsv:
    wcsv = csv.writer(fcsv)
    wcsv.writerow(['页面ID', '帧号', '区域ID', '字段', '当前值', '建议值', '依据'])
    for fr, rid, field, cur, sug, why in sorted(autofix):
        wcsv.writerow([f2id.get(fr, ''), fr, rid, field, cur, sug, why])

pri_cnt = collections.Counter(r['pri'] for r in review)
print(f'{cam}: tracks={len(tracks)} review={len(review)} P0={pri_cnt["P0"]} P1={pri_cnt["P1"]} P2={pri_cnt["P2"]} autofix={len(autofix)}', flush=True)
