import base64
import io
import json
import subprocess

import sys

_args = sys.argv[1:]
W, H = 1920, 1080
FPS = 25
TRAIL_WIN = 100
TRAIL_MAXD = 60
_MP4_OUT = '数据/cam4_animation.mp4'
_WRITE_HTML = True
if '--no-html' in _args:
    _WRITE_HTML = False
if '--size' in _args:
    _s = int(_args[_args.index('--size') + 1])
    W, H = _s, _s * 9 // 16
if '--out' in _args:
    _MP4_OUT = _args[_args.index('--out') + 1]
LAB = {'teamA': 0, 'teamB': 1, 'goalkeeperA': 2, 'goalkeeperB': 3, 'unknown': 4, 'referee': 5}
RGB = {0: (229, 72, 77), 1: (62, 99, 221), 2: (173, 139, 0), 3: (138, 154, 0), 4: (56, 158, 13), 5: (27, 25, 24)}
LC = {v: k for k, v in LAB.items()}

tasks = json.load(open('数据/cam4_tasks.json'))
tasks.sort(key=lambda t: t['data'].get('frame', 0))
f2id = {t['data'].get('frame'): t['id'] for t in tasks}

frames = []
for t in tasks:
    fr = t['data'].get('frame')
    res = (t.get('predictions') or [{}])[0].get('result', [])
    boxes = {}
    for r in res:
        b = boxes.setdefault(r.get('id'), {})
        if r.get('type') == 'rectanglelabels':
            v = r['value']
            b.update(label=(v.get('rectanglelabels') or [''])[0], x=v['x'], y=v['y'], w=v['width'], h=v['height'])
        elif r.get('type') == 'textarea':
            b['number'] = (r['value'].get('text') or [''])[0]
    blist = [b for b in boxes.values() if b.get('label')]
    blist = sorted(blist, key=lambda b: (b.get('number') in (None, ''),))
    kept = []
    for b in blist:
        if any(((b['x'] - k['x']) * 19.2) ** 2 + ((b['y'] - k['y']) * 10.8) ** 2 < 400 for k in kept):
            continue
        kept.append(b)
    frames.append([fr, f2id.get(fr), [[LAB.get(b['label'], 4), str(b.get('number', '') or '').strip(),
                                       round(b['x'], 2), round(b['y'], 2), round(b['w'], 2), round(b['h'], 2)]
                                      for b in kept]])

json.dump(frames, open('数据/cam4_frames.json', 'w'), ensure_ascii=False)
print('frames:', len(frames), 'boxes:', sum(len(f[2]) for f in frames))


def compute_trails(i, win=TRAIL_WIN, maxd=TRAIL_MAXD):
    trs = []
    lo = max(0, i - win + 1)
    for n in range(lo, i + 1):
        pairs = []
        for bi, b in enumerate(frames[n][2]):
            x, y = b[2] / 100 * W, b[3] / 100 * H
            for ti, tr in enumerate(trs):
                if tr[0] != b[0]:
                    continue
                p = tr[1][-1]
                d = (p[0] - x) ** 2 + (p[1] - y) ** 2
                if d < maxd * maxd:
                    pairs.append((d, bi, ti))
        pairs.sort()
        ab, at = {}, {}
        for d, bi, ti in pairs:
            if bi in ab or ti in at:
                continue
            ab[bi], at[ti] = ti, bi
        cur = [None] * len(frames[n][2])
        for bi, b in enumerate(frames[n][2]):
            x, y = b[2] / 100 * W, b[3] / 100 * H
            if bi in ab:
                tr = trs[ab[bi]]
                tr[1].append((x, y))
                if len(tr[1]) > win:
                    tr[1].pop(0)
                cur[bi] = tr
            else:
                cur[bi] = [b[0], [(x, y)]]
        trs = [c for c in cur if c]
    return trs


bg_b64 = base64.b64encode(open('数据/cam4_bg.jpg', 'rb').read()).decode()

html = """<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>cam4 轨迹回放</title>
<style>
body{font-family:-apple-system,'PingFang SC',sans-serif;color:#2C2C2A;margin:0;background:#F6F5F1}
header{padding:10px 20px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
h1{font-size:16px;margin:0}
canvas{border:1px solid #B4B2A9;display:block;margin:0 20px;max-width:calc(100% - 40px)}
.ctl{display:flex;gap:8px;align-items:center;font-size:13px}
button{font-size:13px;padding:4px 14px;border:0.5px solid #888780;border-radius:6px;background:#fff;cursor:pointer}
input[type=range]{width:400px}
.leg{display:flex;gap:12px;font-size:12px;margin-left:auto}
.sw{display:inline-block;width:11px;height:11px;border-radius:2px;margin-right:4px;vertical-align:-1px}
#info{font-variant-numeric:tabular-nums;color:#5F5E5A;font-size:13px}
</style></head><body>
<header>
<h1>migu_1014_cam4 · 真实画面轨迹回放（7500 帧 / 300 秒 / 固定机位背景）</h1>
<div class="ctl">
<button id="pp">▶ 播放</button>
<input type="range" id="sl" min="0" max="__MAX__" value="0">
<select id="sp"><option value="0.5">0.5x</option><option value="1" selected>1x</option><option value="2">2x</option><option value="4">4x</option></select>
<label><input type="checkbox" id="tr" checked> 轨迹线</label>
<select id="tl"><option value="40">轨迹2秒</option><option value="100" selected>轨迹4秒</option><option value="200">轨迹8秒</option></select>
</div>
<div class="leg">
<span><span class="sw" style="background:#E5484D"></span>teamA</span>
<span><span class="sw" style="background:#3E63DD"></span>teamB</span>
<span><span class="sw" style="background:#AD8B00"></span>门将A</span>
<span><span class="sw" style="background:#8A9A00"></span>门将B</span>
<span><span class="sw" style="background:#389E0D"></span>unknown</span>
</div>
</header>
<canvas id="cv" width="__W__" height="__H__"></canvas>
<div style="padding:8px 20px"><span id="info"></span></div>
<script>
var F=__DATA__;
var cv=document.getElementById('cv'),ctx=cv.getContext('2d');
var W=cv.width,H=cv.height,i=0,playing=false,last=0,acc=0;
var RGB=[[229,72,77],[62,99,221],[173,139,0],[138,154,0],[56,158,13],[27,25,24]];
var LC=['teamA','teamB','goalkeeperA','goalkeeperB','unknown','referee'];
var bg=new Image();bg.src='data:image/jpeg;base64,__BG__';
function trails(win){
  var trs=[];
  for(var n=Math.max(0,i-win+1);n<=i;n++){
    var pairs=[];
    F[n][2].forEach(function(b,bi){
      var x=b[2]/100*W,y=b[3]/100*H;
      trs.forEach(function(tr,ti){
        if(tr[0]!==b[0])return;
        var p=tr[1][tr[1].length-1];
        var d=(p[0]-x)*(p[0]-x)+(p[1]-y)*(p[1]-y);
        if(d<3600)pairs.push([d,bi,ti]);
      });
    });
    pairs.sort(function(a,b){return a[0]-b[0]});
    var ab={},at={};
    pairs.forEach(function(pr){if(!(pr[1] in ab)&&!(pr[2] in at)){ab[pr[1]]=pr[2];at[pr[2]]=pr[1];}});
    var cur=new Array(F[n][2].length);
    F[n][2].forEach(function(b,bi){
      var x=b[2]/100*W,y=b[3]/100*H;
      if(bi in ab){
        var tr=trs[ab[bi]];tr[1].push([x,y]);if(tr[1].length>win)tr[1].shift();cur[bi]=tr;
      }else cur[bi]=[b[0],[[x,y]]];
    });
    trs=cur.filter(function(c){return c;});
  }
  return trs;
}
function render(){
  ctx.drawImage(bg,0,0,W,H);
  var win=+document.getElementById('tl').value;
  if(document.getElementById('tr').checked){
    trails(win).forEach(function(tr){
      var c=RGB[tr[0]]||RGB[4];
      for(var k=1;k<tr[1].length;k++){
        ctx.strokeStyle='rgb('+c[0]+','+c[1]+','+c[2]+')';
        ctx.globalAlpha=0.12+0.5*k/tr[1].length;
        ctx.lineWidth=2.5;
        ctx.beginPath();ctx.moveTo(tr[1][k-1][0],tr[1][k-1][1]);ctx.lineTo(tr[1][k][0],tr[1][k][1]);ctx.stroke();
      }
      ctx.globalAlpha=1;
    });
  }
  F[i][2].forEach(function(b){
    var x=b[2]/100*W,y=b[3]/100*H,w=b[4]/100*W,h=b[5]/100*H;
    var c=RGB[b[0]]||RGB[4];
    ctx.strokeStyle='rgb('+c[0]+','+c[1]+','+c[2]+')';ctx.lineWidth=2.5;
    ctx.strokeRect(x,y,w,h);
    ctx.fillStyle='rgb('+c[0]+','+c[1]+','+c[2]+')';
    ctx.font='bold 20px -apple-system,PingFang SC,sans-serif';
    var label=b[1]||LC[b[0]];
    var tw=ctx.measureText(label).width+8;
    ctx.fillRect(x,y-22,tw,22);
    ctx.fillStyle='#fff';ctx.fillText(label,x+4,y-4);
  });
  ctx.fillStyle='rgba(0,0,0,.55)';ctx.fillRect(18,18,330,34);
  ctx.fillStyle='#fff';ctx.font='15px ui-monospace,Menlo,monospace';
  ctx.fillText('frame '+F[i][0]+'  ID '+F[i][1]+'  boxes '+F[i][2].length,26,41);
  document.getElementById('info').textContent='帧 '+F[i][0]+' · 页面 ID '+F[i][1]+' · 检测框 '+F[i][2].length+' 个 · 进度 '+(i+1)+'/'+F.length;
  document.getElementById('sl').value=i;
}
function tick(ts){
  if(playing){
    if(!last)last=ts;
    acc+=(ts-last)*parseFloat(document.getElementById('sp').value);
    last=ts;
    while(acc>=1000/__FPS__){acc-=1000/__FPS__;i++;}
    if(i>=F.length){i=F.length-1;playing=false;document.getElementById('pp').textContent='▶ 播放';}
    render();
  }else last=0;
  requestAnimationFrame(tick);
}
document.getElementById('pp').onclick=function(){playing=!playing;this.textContent=playing?'⏸ 暂停':'▶ 播放';last=0;};
document.getElementById('sl').oninput=function(){i=+this.value;render();};
['sp','tl'].forEach(function(id){document.getElementById(id).onchange=function(){last=0;render();};});
document.getElementById('tr').onchange=render;
if(bg.complete)render();else bg.onload=render;
requestAnimationFrame(tick);
</script></body></html>"""
html = html.replace('__DATA__', json.dumps(frames, ensure_ascii=False, separators=(',', ':')))
html = html.replace('__BG__', bg_b64).replace('__MAX__', str(len(frames) - 1))
html = html.replace('__W__', str(W)).replace('__H__', str(H)).replace('__FPS__', str(FPS))
if _WRITE_HTML:
    open('数据/cam4_animation.html', 'w').write(html)
    print('html saved:', round(len(html) / 1e6, 1), 'MB')

# ---------- MP4 ----------
from PIL import Image, ImageDraw, ImageFont

fp = None
for p in ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf']:
    try:
        fp = ImageFont.truetype(p, 22)
        break
    except Exception:
        continue
fsm = ImageFont.truetype(fp.path, 17) if fp else ImageFont.load_default()
bg_img = Image.open('数据/cam4_bg.jpg').convert('RGB').resize((W, H))
_fp = ImageFont.truetype(fp.path, max(10, 22 * W // 1920))
_fsm = ImageFont.truetype(fp.path, max(9, 17 * W // 1920))


def pil_frame(n):
    img = bg_img.copy()
    tl = ImageDraw.Draw(img, 'RGBA')
    for tr in compute_trails(n):
        c = RGB[tr[0]]
        pts = tr[1]
        for k in range(1, len(pts)):
            a = int(30 + 130 * k / len(pts))
            tl.line([pts[k - 1], pts[k]], fill=c + (a,), width=3)
    d = ImageDraw.Draw(img)
    S = W / 1920.0
    lw = max(1, round(3 * S))
    for b in frames[n][2]:
        x, y, w, h = b[2] / 100 * W, b[3] / 100 * H, b[4] / 100 * W, b[5] / 100 * H
        c = RGB[b[0]]
        d.rectangle([x, y, x + w, y + h], outline=c, width=lw)
        lab = b[1] or LC[b[0]]
        fnt = _fp if S < 1 else fp
        tw = d.textlength(lab, font=fnt)
        ch = 26 * S
        d.rectangle([x, y - ch, x + tw + 10 * S, y], fill=c)
        d.text((x + 5 * S, y - ch + 2 * S), lab, fill=(255, 255, 255), font=fnt)
    d.rectangle([18 * S, 18 * S, 430 * S, 60 * S], fill=(0, 0, 0, 150))
    d.text((30 * S, 28 * S), f"frame {frames[n][0]}  ID {frames[n][1]}  boxes {len(frames[n][2])}",
           fill=(255, 255, 255), font=_fsm if S < 1 else fsm)
    return img


enc = subprocess.Popen(
    ['/Users/caoyouqing/.workbuddy/binaries/ffmpeg/ffmpeg', '-y', '-f', 'image2pipe', '-framerate', str(FPS),
     '-i', '-', '-vcodec', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-preset', 'veryfast',
     '-movflags', '+faststart', _MP4_OUT],
    stdin=subprocess.PIPE)
for n in range(len(frames)):
    buf = io.BytesIO()
    pil_frame(n).save(buf, 'JPEG', quality=90)
    enc.stdin.write(buf.getvalue())
    if n % 1500 == 0:
        print('rendered', n, flush=True)
enc.stdin.close()
enc.wait()
print('mp4 done, rc =', enc.returncode)
