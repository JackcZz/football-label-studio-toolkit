import json
import csv
import collections
import os

HOST = 'http://58.247.144.181:18099'
OUT = '数据/migu_1014_审查总控台'
CAMS = [('cam2', '数据/raw_cam2.json', 5), ('cam3', '数据/raw_cam3.json', 6), ('cam4', '数据/cam4_tasks.json', 7),
        ('cam5', '数据/raw_cam5.json', 8), ('cam6', '数据/raw_cam6.json', 9), ('cam7', '数据/raw_cam7.json', 10),
        ('cam8', '数据/raw_cam8.json', 11), ('cam9', '数据/raw_cam9.json', 12), ('cam10', '数据/raw_cam10.json', 14),
        ('cam11', '数据/raw_cam11.json', 15), ('cam12', '数据/raw_cam12.json', 16)]
os.makedirs(OUT, exist_ok=True)


def esc(s):
    return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def stage_of(iss):
    if '双方队号码重复' in iss:
        return '0'
    s1 = ('整段0检出', '丢框后原位被其他球员占位', '中途消失且未重现', '丢框后重现但与运动预测不符', '轨迹终止于画面边缘')
    s2 = ('号码缺失', '号码闪烁', '号码冲突', '号码队别不符', '运动吻合')
    s3 = ('队别闪烁', '持续队别冲突', 'unknown待归类', '轨迹接续', '位置跳变')
    if any(k in iss for k in s1):
        return '1'
    if any(k in iss for k in s2):
        return '2'
    if any(k in iss for k in s3):
        return '3'
    return '3'


def explain(r):
    iss = r.get('issue', '')
    sug = r.get('num_sug', '')
    p = []
    if '号码缺失(可自动补)' in iss:
        p.append(f'该框<b>没有识别出号码</b>；同一轨迹其余帧稳定识别为 <b>{sug}</b> → 判定可自动补为 {sug}。')
    elif '号码缺失(无轨迹依据)' in iss:
        p.append('该框没有识别出号码，且所在轨迹太短、无稳定主号码，机器给不出建议值。')
    elif '号码闪烁' in iss:
        p.append(f'同一轨迹中该段号码与前后帧不同，而主号码 <b>{sug}</b> 占轨迹绝大多数帧 → 判定为识别跳变，建议改为 {sug}。')
    elif '号码冲突' in iss:
        p.append('该段号码与轨迹主号码两段都较长：更像<b>换人 / 换号 / 轨迹跟丢后重连</b>，而非单次误读 → 机器不敢自动改，需人工判定。')
    if '双方队号码重复' in iss:
        p.append('该号码<b>同时大量出现在 teamA 和 teamB</b>（比例见证据）→ 若实际只有一队穿这个号，另一队的框全是错的；若确为双方同名号，请审核后在名单里标记。属最高优先级（P0）。')
    if '号码队别不符' in iss:
        p.append('该号码在全片数据中<b>绝大多数属于另一队</b>（纯度比例见证据），而这条轨迹标的是本队 → <b>要么队别(颜色)标错，要么号码识别错</b>，须人工判定改哪一个。')
    if '该号码属' in iss:
        p.append('此号码在本队从未作为主号码出现，却频繁出现在对方队伍 → 疑似<b>队别分类错误</b>。')
    if '非' in iss and '名单' in iss and '主号码' in iss:
        p.append('轨迹主号码不在反推名单内 → 可能是名单未覆盖（替补 / 改号），也可能是持续性误识别。')
    if '队别闪烁' in iss:
        p.append(f'同一轨迹的队别标签短暂跳变，主队别 <b>{sug}</b> 占绝大多数帧 → 建议改为 {sug}。')
    elif '持续队别冲突' in iss:
        p.append('队别标签两段势均力敌：可能球员贴近交叉导致轨迹跟错人 → 需人工判定。')
    if 'unknown待归类' in iss:
        p.append('该框类别被模型判为 <b>unknown</b>（队别无法归类）。<b>「建议值」列此处填的是建议队别</b>，来源三选一：① 同一条轨迹前后的主导队别；② <b>动态位置推断</b>（实时计算两队质心，看该框离哪队质心更近）；③ 邻轨线索（同帧 150px 内最近的已知队别框，队别#号码+距离）。证据里会写明用的是哪种；两种推断不一致时请上站看画面定。')
    if '整段0检出' in iss:
        p.append('该时段该队完全没有检测框（见证据中位检出数）→ 疑似<b>模型漏检段</b>，也可能球员集体离开画面。')
    if '中途消失且未重现' in iss:
        p.append('该球员的检测框<b>自此帧后消失</b>，且后续 30 帧内同一位置没有重新出现。本机位是<b>半场视角</b>：人物走出拍摄范围属正常，请打开该帧确认——画面上人还在 = 漏框需补标；人不在 = 正常离场。')
    if '整段0检出' in iss:
        p.append('该时段该队完全没有检测框。<b>半场视角下全队集体移出画面属正常</b>（攻到另一端），仅提示；如与画面内容不符再排查漏检。')
    elif '丢框后原位被其他球员占位' in iss:
        p.append('已确认<b>本人的同号框此后再未出现</b>（真丢框），而原位由另一号码的轨迹占位 → 就是「人在画面里、框没了」的情形。<b>证据里的「区域队别计数」用颜色指认丢的是哪队的框</b>（减少的队就是真丢的队，不会把 teamA 的丢失误算到 teamB 头上）；若显示「标注可疑」，说明这条轨迹的队别(颜色)本身可能标错。')
    elif '运动吻合' in iss:
        p.append('轨迹中断后，<b>按原运动方向预测的位置与新框吻合</b>，且该位置没有其他球员持续占位 → 大概率是<b>同一人、号码被识别错</b>，建议值供参考（仍请人工确认）。')
    elif '丢框后重现但与运动预测不符' in iss:
        p.append('轨迹中断后原位出现了新框，但<b>不在按原速度预测的轨迹上</b> → 大概率是另一个人，或球员中途变向；原框确已丢失，需人工确认。')
    elif '轨迹接续' in iss:
        p.append('该轨迹结束后，<b>同号码的框仍在附近被检出</b> → 只是关联把一条轨迹切成了碎片，不是丢框，无需处理。')
    elif '轨迹终止于画面边缘' in iss:
        p.append('最后一个框位于画面边缘，大概率是正常走出画面，一般无需处理。')
    if '位置跳变' in iss:
        p.append('固定机位下球员每帧位移很小且连续；<b>该帧位移远超这条轨迹的中位步长</b> → 这一帧的框很可能跟到了别人（或检测抖动），需人工核对这一帧。')
    if '运动吻合' in iss:
        p.append('轨迹中断后，<b>按原运动方向预测的位置与新框吻合</b> → 可确认是同一人：中间那段是丢框，重现段的号码识别错了，建议改回原号码。')
    elif '运动预测不符' in iss:
        p.append('轨迹中断后原位出现了新框，但<b>不在按原速度预测的轨迹上</b> → 大概率是另一个人；原框确已丢失（或人物已离场），需人工确认。')
    return '<br>'.join(p) or '—'


CSS = """
body{font-family:-apple-system,'PingFang SC',sans-serif;color:#2C2C2A;margin:0;line-height:1.5}
header{position:sticky;top:0;background:#fff;border-bottom:0.5px solid #D3D1C7;padding:10px 20px;z-index:5}
h1{font-size:16px;margin:0 0 6px}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px}
.tag{display:inline-block;padding:1px 8px;border-radius:4px;font-size:12px}
.p0{background:#FCEBEB;color:#A32D2D} .p1{background:#FAEEDA;color:#854F0B}
.p2{background:#F1EFE8;color:#5F5E5A} .ok{background:#E1F5EE;color:#0F6E56}
input,select{font-size:13px}
table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border-bottom:0.5px solid #EAE8E0;padding:5px 10px}
th{background:#F6F5F1;text-align:left}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.idcell{font-weight:500}
.sug{color:#0F6E56;font-weight:500}
.iss{font-size:12px;color:#5F5E5A}
tr[data-flick="1"] .iss{color:#A32D2D;font-weight:600}
tr.row{cursor:pointer} tr.row:hover{background:#F6F9FC}
tr.detail{display:none} tr.detail.open{display:table-row}
tr.detail>td{background:#FAFAF7;padding:12px 20px}
.sect{margin:4px 0}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:#F1EFE8;padding:2px 8px;border-radius:4px}
.hint{color:#888780;font-size:12px;margin-left:8px}
a{color:#185FA5}
.tabs{display:flex;gap:8px;margin:6px 0}
.tab{padding:3px 14px;border:0.5px solid #B4B2A9;border-radius:6px;cursor:pointer;font-size:13px}
.tab.on{background:#185FA5;color:#fff;border-color:#185FA5}
#count{color:#5F5E5A}
td.mk{width:56px;text-align:center}
tr.fg1 td{background:#EAF3FB}
tr.fg2 td{background:#EAF3DE}
tr.fg3 td{background:#FAEEDA}
tr.fg4 td{background:#FBEAF0}
tr.fg5 td{background:#E1F5EE}
tr.fg6 td{background:#F5F5F0}
tr.mk-on td{background:#EEEDFE}
tr.mk-on:hover td{background:#E0DEF7}
.mkcnt{color:#534AB7;font-size:12px}
.dbtn{font-size:12px;padding:2px 10px;border:0.5px solid #888780;border-radius:6px;background:#fff;cursor:pointer;color:#444441;white-space:nowrap}
.dbtn:hover{background:#F1EFE8}
tr.mk-on .dbtn{background:#534AB7;border-color:#534AB7;color:#fff}
"""

JS = """
function showTab(name){
  document.getElementById('issues').style.display=name==='issues'?'':'none';
  document.getElementById('frames').style.display=name==='frames'?'':'none';
  document.getElementById('miss').style.display=name==='miss'?'':'none';
  document.getElementById('tissues').className='tab'+(name==='issues'?' on':'');
  document.getElementById('tframes').className='tab'+(name==='frames'?' on':'');
  document.getElementById('tmiss').className='tab'+(name==='miss'?' on':'');
}
function toggle(id){var e=document.getElementById(id);e.classList.toggle('open')}
var FGP=['fg1','fg2','fg3','fg4','fg5','fg6'];
function paintFrames(){
  var cnt={};
  document.querySelectorAll('#itbody tr.row').forEach(function(r){
    if(r.style.display==='none')return;
    cnt[r.dataset.fr]=(cnt[r.dataset.fr]||0)+1;
  });
  var gi=0,col={};
  document.querySelectorAll('#itbody tr.row').forEach(function(r){
    FGP.forEach(function(c){r.classList.remove(c)});
    if(r.style.display==='none')return;
    var k=r.dataset.fr;
    if(cnt[k]>1){
      if(!(k in col)){col[k]=FGP[gi%FGP.length];gi++;}
      r.classList.add(col[k]);
    }
  });
}
var flickMode=false;
function flickOnly(){flickMode=!flickMode;document.getElementById('flickBtn').style.background=flickMode?'#FCEBEB':'';document.getElementById('flickBtn').style.borderColor=flickMode?'#A32D2D':'';apply()}
function apply(){
  var q=document.getElementById('q').value.trim(),iss=document.getElementById('iss').value,stg=document.getElementById('stageSel').value,n=0;
  document.querySelectorAll('#itbody tr.row').forEach(function(r){
    var d=document.getElementById('d'+r.dataset.i);
    var ok=document.getElementById('f'+r.dataset.pri[1]).checked;
    if(iss&&r.dataset.iss!==iss)ok=false;
    if(flickMode&&r.dataset.flick!=='1')ok=false;
    if(stg!=='all'&&r.dataset.stage!==stg&&r.dataset.stage!=='0')ok=false;
    if(q&&r.innerText.indexOf(q)===-1)ok=false;
    r.style.display=ok?'':'none';
    if(!ok&&d)d.classList.remove('open');
    if(ok)n++;
  });
  document.getElementById('count').textContent='问题清单显示 '+n+' 条';
  paintFrames();
}
function applyFrames(){
  var hideOk=document.getElementById('fhide').checked,q=document.getElementById('qf').value.trim(),n=0;
  document.querySelectorAll('#ftbody tr.row').forEach(function(r){
    var ok=true;
    if(hideOk&&r.dataset.st==='ok')ok=false;
    if(r.dataset.st!=='ok'&&!document.getElementById('g'+r.dataset.st[1]).checked)ok=false;
    if(q&&r.innerText.indexOf(q)===-1)ok=false;
    r.style.display=ok?'':'none';
    if(ok)n++;
  });
  document.getElementById('fcount').textContent='全帧总览显示 '+n+' 条';
}
function applyMiss(){
  var q=document.getElementById('qm').value.trim(),ns=document.getElementById('fnosug').checked,n=0;
  document.querySelectorAll('#mtbody tr.row').forEach(function(r){
    var ok=true;
    if(ns&&r.dataset.sug!=='')ok=false;
    if(q&&r.innerText.indexOf(q)===-1)ok=false;
    r.style.display=ok?'':'none';
    if(ok)n++;
  });
  document.getElementById('mcount').textContent='缺号记录显示 '+n+' 条';
}
['f0','f1','f2','iss'].forEach(function(id){var e=document.getElementById(id);if(e)e.addEventListener('input',apply)});
(function(){var e=document.getElementById('stageSel');if(e)e.addEventListener('input',function(){['f0','f1','f2'].forEach(function(id){document.getElementById(id).checked=true});apply()})})();
var qe=document.getElementById('q');if(qe)qe.addEventListener('input',apply);
['g0','g1','g2','fhide'].forEach(function(id){var e=document.getElementById(id);if(e)e.addEventListener('input',applyFrames)});
var qf=document.getElementById('qf');if(qf)qf.addEventListener('input',applyFrames);
var qm=document.getElementById('qm');if(qm)qm.addEventListener('input',applyMiss);
var fns=document.getElementById('fnosug');if(fns)fns.addEventListener('input',applyMiss);
var MS='http://127.0.0.1:18765/api/marks';
var marks={};
function updMk(){var n=0;document.querySelectorAll('.dbtn[data-k]').forEach(function(el){if(marks[el.dataset.k])n++});var e=document.getElementById('mkcnt');if(e)e.textContent='已完成 '+n+' 条'}
function refreshMarks(){document.querySelectorAll('.dbtn[data-k]').forEach(function(el){var on=!!marks[el.dataset.k];el.closest('tr').classList.toggle('mk-on',on);el.textContent=on?'✓ 完成':'完成'});updMk();applyMiss();paintFrames()}
function setMs(t){var e=document.getElementById('mkstate');if(e)e.textContent=t}
function markRow(ev,el){ev.stopPropagation();var k=el.dataset.k;var on=!marks[k];if(on)marks[k]=1;else delete marks[k];el.closest('tr').classList.toggle('mk-on',on);el.textContent=on?'✓ 完成':'完成';updMk();paintFrames();fetch(MS,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(marks)}).then(function(){setMs('已写入本地 marks.json')}).catch(function(){setMs('离线：未保存，需运行 mark_server.py')})}
function pingSrv(){fetch(MS).then(function(r){return r.ok?r.json():{}}).then(function(m){marks=m;refreshMarks();setMs('服务在线，标记已同步')}).catch(function(){setMs('服务离线：请在 程序/ 目录运行 python3 mark_server.py')})}
function stopSrv(){if(!confirm('关闭本地标记服务？关闭期间标记不保存。'))return;fetch(MS,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(marks)}).then(function(){return fetch(MS.replace('/api/marks','/api/shutdown'),{method:'POST'})}).then(function(){setMs('服务已关闭')}).catch(function(){setMs('服务已关闭')})}
fetch(MS).then(function(r){return r.ok?r.json():{}}).then(function(m){marks=m;refreshMarks();setMs('标记已从本地 marks.json 载入')}).catch(function(){setMs('离线：标记不保存，点「开启服务」重试或运行 程序/mark_server.py')});
"""

console_rows = []

for cam, raw, pid in CAMS:
    review = json.load(open(f'数据/review_{cam}.json'))
    roster = json.load(open(f'数据/roster_{cam}.json'))
    diag = json.load(open(f'数据/diag_{cam}.json'))
    autofix_n = sum(1 for _ in open(f'数据/autofix_{cam}.csv')) - 1
    tasks = json.load(open(raw))
    tasks.sort(key=lambda t: t['id'])
    f2id = {t['data'].get('frame'): t['id'] for t in tasks}

    sug_map = {}
    with open(f'数据/autofix_{cam}.csv', encoding='utf-8-sig') as fcsv:
        for row in csv.reader(fcsv):
            if row and row[3] == 'number' and not row[4].strip():
                sug_map[(row[1], row[2])] = row[5]
    ctx_map = {}
    hint_map = {}
    for r in review:
        if r.get('issue', '').startswith('号码缺失'):
            for fr in range(r['f0'], r['f1'] + 1):
                ctx_map[fr] = r.get('ctx', '')
                hint_map[fr] = r.get('hint', '')

    for r in review:
        r['id0'] = f2id.get(r['f0'])
        r['id1'] = f2id.get(r['f1'])
    rows = sorted((r for r in review if r['id0'] is not None), key=lambda r: r['id0'])
    pri_cnt = collections.Counter(r['pri'] for r in review)
    iss_list = sorted({r['issue'].split('(')[0].split(';')[0] for r in rows})

    frame_issues = collections.defaultdict(list)
    for idx, r in enumerate(rows):
        for fr in range(r['f0'], min(r['f1'], r['f0'] + 400) + 1):
            frame_issues[fr].append(idx)

    frames_html = []
    issue_rows_html = []
    miss_rows_html = []
    n_miss = 0
    n_ok = 0
    st_cnt = collections.Counter()
    for t in tasks:
        tid = t['id']
        fr = t['data'].get('frame')
        res = (t.get('predictions') or [{}])[0].get('result', [])
        boxes = {}
        for x in res:
            b = boxes.setdefault(x.get('id'), {'rid': x.get('id')})
            if x.get('type') == 'rectanglelabels':
                b['label'] = (x['value'].get('rectanglelabels') or [''])[0]
                b['x'] = x['value']['x']
                b['y'] = x['value']['y']
            elif x.get('type') == 'textarea':
                b['number'] = (x['value'].get('text') or [''])[0]
        blist = [b for b in boxes.values() if b.get('label')]
        blist = sorted(blist, key=lambda b: (b.get('number') in (None, ''),))
        kept = []
        for b in blist:
            if any(((b['x'] - k['x']) * 19.2) ** 2 + ((b['y'] - k['y']) * 10.8) ** 2 < 400 for k in kept):
                continue
            kept.append(b)
        boxes = {b['rid']: b for b in kept}
        c = collections.Counter(b['label'] for b in kept)
        miss = sum(1 for b in boxes.values() if b.get('label') and not (b.get('number') or '').strip()
                   and b['label'] not in ('unknown', 'referee'))
        ivs = frame_issues.get(fr, [])
        st = min((rows[i]['pri'] for i in ivs), default='ok')
        st_cnt[st] += 1
        url = f'{HOST}/projects/{pid}/data?tab=12&task={tid}'
        for rid, b in boxes.items():
            if b.get('label') in ('teamA', 'teamB') and not (b.get('number') or '').strip():
                n_miss += 1
                sug = sug_map.get((str(fr), rid or ''), '')
                ctxm = ctx_map.get(fr, '')
                if not any(ch.isdigit() for ch in ctxm):
                    ctxm = ''
                hintm = hint_map.get(fr, '')
                mkey = f"{cam}|{tid}|{rid}|缺号"
                miss_rows_html.append(
                    f'<tr class="row" data-sug="{sug}">'
                    f'<td class="mk"><button type="button" class="dbtn" data-k="{esc(mkey)}" onclick="markRow(event,this)">完成</button></td>'
                    f'<td class="num idcell"><a href="{url}" target="_blank">{tid}</a></td>'
                    f'<td class="num">{fr}</td><td class="num">{rid}</td><td>{b["label"]}</td>'
                    f'<td class="num sug">{sug}</td>'
                    f'<td>{esc(hintm) or "—（无前后帧可比）"}</td>'
                    f'<td class="mono">{esc(ctxm) or ""}</td></tr>')
        if ivs:
            lines = ''.join(
                f"<div class='sect'><span class='tag {rows[i]['pri'].lower()}'>{rows[i]['pri']}</span> "
                f"<span class='mono'>ID {rows[i]['id0']}-{rows[i]['id1']}</span> {esc(rows[i]['issue'])}"
                f"<br>{explain(rows[i])}</div>" for i in ivs[:12])
            detail = f"<div class='sect'><b>该帧落在以下问题段内</b>{lines}</div>"
        else:
            detail = "<div class='sect'>无问题段命中。</div>"
        frames_html.append(
            f"""<tr class="row" data-st="{st}" onclick="toggle('fd{tid}')">
<td><span class="tag {st}">{'正常' if st == 'ok' else st}</span></td>
<td class="num idcell">{tid}</td><td class="num">{fr}</td>
<td class="num">{c.get('teamA', 0)}</td><td class="num">{c.get('teamB', 0)}</td>
<td class="num">{c.get('goalkeeperA', 0)}/{c.get('goalkeeperB', 0)}</td>
<td class="num">{c.get('unknown', 0)}</td><td class="num">{miss}</td><td class="num">{len(ivs)}</td></tr>
<tr class="detail" id="fd{tid}"><td colspan="9">
<div class='sect'><b>在线查看</b> <a href='{url}' target='_blank'>在 Label Studio 打开该帧（任务 {tid}）</a></div>
{detail}</td></tr>""")

    for idx, r in enumerate(rows):
        url = f"{HOST}/projects/{pid}/data?tab=12&task={r['id0']}"
        ctx = esc(r.get('ctx', '')) or '—'
        ev = esc(r.get('ev', '')) or '—'
        dur = r['f1'] - r['f0'] + 1
        mk = f"{cam}|{r['id0']}|{r['issue']}|{r.get('num_now', '')}"
        stg = stage_of(r['issue'])
        flick = 1 if any(k in r['issue'] for k in ('号码闪烁', '号码冲突', '运动吻合', '队别闪烁', '持续队别冲突')) else 0
        issue_rows_html.append(f"""<tr class="row" data-pri="{r['pri']}" data-i="{idx}" data-stage="{stg}" data-fr="{r['f0']}" data-flick="{flick}" data-iss="{esc(r['issue'].split('(')[0].split(';')[0])}" onclick="toggle('d{idx}')">
<td><span class="tag {r['pri'].lower()}">{r['pri']}</span></td>
<td class="num idcell">{r['id0']}</td><td class="num">{r['f0']}</td>
<td class="mk"><button type="button" class="dbtn" data-k="{esc(mk)}" onclick="markRow(event,this)">完成</button></td>
<td class="num">{esc(r.get('rid','')) or '—'}</td><td class="num">{dur}</td>
<td>{esc(r.get('label_now',''))}</td><td class="num">{esc(r.get('num_now',''))}</td>
<td class="num sug">{esc(r.get('num_sug',''))}</td><td class="iss">{'⚡' if flick else ''}{esc(r['issue'])}</td></tr>
<tr class="detail" id="d{idx}"><td colspan="10"><div>
<div class="sect"><b>为什么判定有问题</b><br>{explain(r)}</div>
<div class="sect"><b>轨迹上下文</b> <span class="mono">{ctx}</span><br><span class="hint">▶ = 被标记的段 · ∅ = 无号码 · ×N = 连续帧数</span></div>
<div class="sect"><b>关联位置</b> <span class="mono">{esc(r.get('hint', '')) or '—'}</span> <span class="hint">前后帧同一关联位置的号码</span></div>
<div class="sect"><b>证据</b> <span class="mono">{ev}</span></div>
<div class="sect"><b>在线查看</b> <a href="{url}" target="_blank">打开该帧（任务 {r['id0']}）</a>
{(' &nbsp; <a href="../cam4_对比工作站.html?f=' + str(r['f0']) + '" target="_blank">⚖ 三路对比（跳到帧 ' + str(r['f0']) + '）</a>') if cam == 'cam4' else ''}</div>
{f"～ <a href='{HOST}/projects/{pid}/data?tab=12&task={r['id1']}' target='_blank'>段尾 {r['id1']}</a>" if r['id1'] and r['id1'] != r['id0'] else ''}</div>
</div></td></tr>""")

    iss_opts = ''.join(f'<option value="{esc(i)}">{esc(i)}</option>' for i in iss_list)
    boxes = diag['boxes']
    avg = boxes / diag['frames']

    page = f"""<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>{cam} 审查页</title><style>{CSS}</style></head><body>
<header>
<h1><a href="index.html">← 总控台</a> &nbsp; migu_1014_{cam} · {diag['frames']} 帧 / {boxes:,} 框 / 均值 {avg:.1f} 框每帧</h1>
<div class="bar">
<span class="tag p0">P0 {pri_cnt['P0']}</span><span class="tag p1">P1 {pri_cnt['P1']}</span><span class="tag p2">P2 {pri_cnt['P2']}</span>
<span class="tag" style="background:#FCEBEB;color:#A32D2D">teamA/B 缺号待纠错 {n_miss}</span>
<span class="tag ok">正常帧 {st_cnt['ok']}</span>
<span class="hint">自动修正批 {autofix_n} 条 → ../migu_1014_全镜头标注数据/{cam}/auto_fix.csv</span>
</div>
<div class="tabs"><span class="tab on" id="tissues" onclick="showTab('issues')">问题清单</span><span class="tab" id="tframes" onclick="showTab('frames')">全帧总览</span><span class="tab" id="tmiss" onclick="showTab('miss')">缺号待纠错</span></div>
</header>

<div id="issues">
<div class="bar" style="padding:10px 20px">
<label><input type="checkbox" id="f0" checked> <span class="tag p0">P0</span> {pri_cnt['P0']}</label>
<label><input type="checkbox" id="f1" checked> <span class="tag p1">P1</span> {pri_cnt['P1']}</label>
<label><input type="checkbox" id="f2"> <span class="tag p2">P2</span> {pri_cnt['P2']}</label>
<select id="iss"><option value="">全部问题类型</option>{iss_opts}</select>
<select id="stageSel">
<option value="all">全部阶段</option>
<option value="1">阶段1 · 漏框选检查</option>
<option value="2">阶段2 · 号码缺失/错误</option>
<option value="3">阶段3 · 队别与其他</option>
</select>
<input id="q" placeholder="搜索 ID / 帧号 / 号码" size="18"><span id="count"></span><span class="mkcnt" id="mkcnt"></span><span class="hint" id="mkstate"></span>
<button type="button" class="dbtn" id="flickBtn" onclick="flickOnly()">⚡ 闪烁专项</button>
<button type="button" class="dbtn" onclick="pingSrv()">开启服务</button>
<button type="button" class="dbtn" onclick="stopSrv()">关闭服务</button>
<span class="hint">框号仅该帧内序号（每帧随机，勿跨帧当身份）；跨帧身份看 队别+号码+位置</span>
</div>
<table><thead><tr><th style="width:46px">级</th><th style="width:80px">页面 ID</th><th style="width:70px">帧号</th><th style="width:56px">完成</th><th style="width:80px">框号</th><th style="width:60px">段长</th>
<th style="width:90px">队别</th><th style="width:70px">当前号码</th><th style="width:70px">建议值</th><th>问题类型（点击行展开原因）</th></tr></thead>
<tbody id="itbody">{''.join(issue_rows_html)}</tbody></table>
</div>

<div id="frames" style="display:none">
<div class="bar" style="padding:10px 20px">
<label><input type="checkbox" id="fhide"> 隐藏正常帧</label>
<label><input type="checkbox" id="g0" checked> <span class="tag p0">P0</span></label>
<label><input type="checkbox" id="g1" checked> <span class="tag p1">P1</span></label>
<label><input type="checkbox" id="g2" checked> <span class="tag p2">P2</span></label>
<input id="qf" placeholder="搜索 ID / 帧号" size="16"><span id="fcount"></span>
</div>
<table><thead><tr><th style="width:60px">状态</th><th style="width:80px">页面 ID</th><th style="width:70px">帧号</th>
<th>teamA</th><th>teamB</th><th>GK A/B</th><th>unknown</th><th>缺号框</th><th>问题段数</th></tr></thead>
<tbody id="ftbody">{''.join(frames_html)}</tbody></table>
</div>

<div id="miss" style="display:none">
<div class="bar" style="padding:10px 20px">
<span class="tag p0">teamA/teamB 有队别无球衣号 = 待纠错（守门员已忽略）</span>
<label><input type="checkbox" id="fnosug"> 只看无建议值（必人工比对）</label>
<input id="qm" placeholder="搜索 ID / 帧号 / 框号" size="16"><span id="mcount"></span>
<span class="hint">框号 = 该帧第几个框选（每帧随机，勿跨帧当身份） · 「关联位置号码」= 前后帧同一位置那个人是几号，照此补 · 点 ID 直达该帧</span>
</div>
<table><thead><tr><th style="width:56px">完成</th><th style="width:80px">页面 ID</th><th style="width:70px">帧号</th>
<th style="width:80px">框号</th><th style="width:90px">队别</th><th style="width:70px">建议号码</th>
<th style="width:230px">关联位置号码（前帧/后帧同一位置是几号，照此改）</th><th>轨迹上下文</th></tr></thead>
<tbody id="mtbody">{''.join(miss_rows_html)}</tbody></table>
</div>
<script>{JS}</script>
</body></html>"""
    open(f'{OUT}/{cam}.html', 'w').write(page)
    console_rows.append((cam, pid, diag['frames'], boxes, avg, pri_cnt, autofix_n, roster, st_cnt, n_miss))
    print(f'{cam} page done: {len(rows)} issues, {st_cnt["ok"]} ok frames, {n_miss} missing-number boxes', flush=True)

tr = ''.join(
    f"""<tr onclick="location.href='{c}.html'" class="row">
<td class="idcell"><a href="{c}.html">{c}</a></td><td class="num">{p}</td><td class="num">{nf}</td>
<td class="num">{bx:,}</td><td class="num">{a:.1f}</td>
<td class="num">{pc['P0']}</td><td class="num">{pc['P1']}</td><td class="num">{pc['P2']}</td>
<td class="num">{af}</td><td class="num" style="color:#A32D2D">{nm:,}</td><td>{', '.join(n + ('*' if n in shared else '') for n in sorted(ro.get('teamA', []), key=int))}</td><td>{', '.join(n + ('*' if n in shared else '') for n in sorted(ro.get('teamB', []), key=int))}</td></tr>"""
    for c, p, nf, bx, a, pc, af, ro, sc, nm in console_rows
    for shared in [set(ro.get('teamA', [])) & set(ro.get('teamB', []))])

tot = lambda i: sum(r[i] for r in console_rows)
index = f"""<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>migu_1014 审查总控台</title><style>{CSS}
tr.row{{cursor:pointer}} tr.row:hover{{background:#F6F9FC}}</style></head><body>
<header><h1>migu_1014 审查总控台 · 11 机位 / 82,500 帧 / {tot(3):,} 框</h1>
<div class="bar"><span class="hint">点击机位进入该镜头审查页 · 数据为模型预测结果 · 图片在 Label Studio 在线查看</span></div></header>
<div style="padding:14px 20px">
<table><thead><tr><th>机位</th><th>项目ID</th><th>帧数</th><th>框数</th><th>框/帧</th>
<th><span class="tag p0">P0</span></th><th><span class="tag p1">P1</span></th><th><span class="tag p2">P2</span></th>
<th>自动修正</th><th style="color:#A32D2D">缺号(teamA/B)</th><th>teamA 名单</th><th>teamB 名单</th></tr></thead>
<tbody>{tr}</tbody></table>
<p class="hint">P0 = 机器已给建议值，扫一眼确认；P1 = 必须人工判定；P2 = 低风险提示。自动修正批 CSV 在 migu_1014_全镜头标注数据/各机位/auto_fix.csv。<br>名单按「号码→队别纯度」分离（某号码 ≥90% 出现在某队 = 该队专属；40-60% = 两队共有，标 *）；出现在错误队别的框会进入 P1「号码队别不符」。</p>
</div></body></html>"""
open(f'{OUT}/index.html', 'w').write(index)
print('console done')
