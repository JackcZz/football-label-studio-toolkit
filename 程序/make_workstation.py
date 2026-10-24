import json
import sys

FPS = 25
F0 = 4500

review = json.load(open('数据/review_cam4.json'))
f2id = {t['data'].get('frame'): t['id'] for t in json.load(open('数据/cam4_tasks.json'))}

alerts = []
for r in review:
    alerts.append([r['f0'], {'P0': 0, 'P1': 1, 'P2': 2}.get(r['pri'], 2),
                   r['issue'].split('(')[0].split(';')[0], str(r.get('ctx', ''))[:150],
                   f2id.get(r['f0']), r.get('num_sug', ''), str(r.get('ev', ''))[:200]])
alerts.sort()

by_frame = {}
for a in alerts:
    by_frame.setdefault(a[0], []).append(a)

orig = sys.argv[1] if len(sys.argv) > 1 else 'cam4_original.mp4'

html = """<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>cam4 三路对比工作站</title>
<style>
body{font-family:-apple-system,'PingFang SC',sans-serif;color:#2C2C2A;margin:0;background:#F6F5F1}
header{padding:10px 20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;background:#fff;border-bottom:0.5px solid #D3D1C7}
h1{font-size:16px;margin:0}
button{font-size:13px;padding:4px 12px;border:0.5px solid #888780;border-radius:6px;background:#fff;cursor:pointer}
button:hover{background:#F1EFE8}
input[type=range]{width:340px}
select{font-size:13px}
.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:12px 20px}
.panel{background:#fff;border:0.5px solid #D3D1C7;border-radius:8px;padding:8px}
.panel h3{font-size:13px;margin:2px 0 6px;display:flex;justify-content:space-between}
.panel h3 span{color:#888780;font-weight:400;font-size:11px}
video{width:100%;background:#000;border-radius:4px;display:block}
.miss{background:#FAEEDA;color:#854F0B;font-size:12px;padding:10px;border-radius:4px;text-align:center}
#bar{padding:8px 20px;font-size:13px;color:#5F5E5A}
#alerts{padding:0 20px 20px}
.acard{background:#fff;border:0.5px solid #D3D1C7;border-left-width:3px;border-radius:6px;padding:8px 12px;margin:6px 0;font-size:13px}
.a0{border-left-color:#E5484D}.a1{border-left-color:#D69A00}.a2{border-left-color:#888780}
.tag{display:inline-block;padding:0 6px;border-radius:3px;font-size:11px;margin-right:6px}
.t0{background:#FCEBEB;color:#A32D2D}.t1{background:#FAEEDA;color:#854F0B}.t2{background:#F1EFE8;color:#5F5E5A}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#5F5E5A}
a{color:#185FA5}
.kbd{font-size:11px;color:#888780}
</style></head><body>
<header>
<h1>YOUR_PROJECT_cam4 · 三路同步对比工作站</h1>
<button id="pp">▶ 播放</button>
<button onclick="step(-1)">◀ 上一帧</button>
<button onclick="step(1)">下一帧 ▶</button>
<input type="range" id="sl" min="0" max="7499" value="0">
<select id="sp"><option value="0.5">0.5x</option><option value="1" selected>1x</option><option value="2">2x</option></select>
<button onclick="jumpAlert(-1)">⏮ 上一问题帧</button>
<button onclick="jumpAlert(1)">下个问题帧 ⏭</button>
<span class="kbd">空格=播放/暂停 ←→=逐帧</span>
</header>
<div class="grid">
<div class="panel"><h3>① 原视频 <span>cam4_original.mp4</span></h3>
<div id="p1"></div></div>
<div class="panel"><h3>② 标注回放(全画质) <span>cam4_animation.mp4</span></h3>
<video id="v2" src="cam4_animation.mp4" preload="auto"></video></div>
<div class="panel"><h3>③ 补录低画质(拖动用) <span>cam4_animation_480p.mp4</span></h3>
<video id="v3" src="cam4_animation_480p.mp4" preload="auto"></video></div>
</div>
<div id="bar"></div>
<div id="alerts"></div>
<script>
var F0=__F0__,N=7500,FPS=25;
var AL=__ALERTS__;
var byFrame={};AL.forEach(function(a){(byFrame[a[0]]=byFrame[a[0]]||[]).push(a)});
var i=0,playing=false,last=0,acc=0;
var v2=document.getElementById('v2'),v3=document.getElementById('v3');
var hasOrig=!!document.getElementById('v1');
function t(){return (F0+i-F0)/FPS;}
function seek(){
  var tt=i/FPS;
  [v2,v3].forEach(function(v){try{v.currentTime=tt;}catch(e){}});
  if(hasOrig){try{document.getElementById('v1').currentTime=tt;}catch(e){}}
  render();
}
function render(){
  var fr=F0+i;
  var a=byFrame[fr]||[];
  document.getElementById('sl').value=i;
  document.getElementById('bar').textContent='帧 '+fr+' · 页面 ID '+(a.length?a[0][4]:'—')+' · 第 '+(i+1)+'/7500 帧 · 本帧问题 '+a.length+' 条';
  var h='';
  a.forEach(function(x){
    h+='<div class="acard a'+x[1]+'"><span class="tag t'+x[1]+'">'+['P0','P1','P2'][x[1]]+'</span>'+x[2]+
       ' <span class="mono">ID '+x[4]+'</span>'+(x[5]?' · 建议 <b>'+x[5]+'</b>':'')+
       '<br><span class="mono">'+x[3]+'</span><br><span class="mono">'+x[6]+'</span></div>';
  });
  document.getElementById('alerts').innerHTML=a.length?h:'<div class="acard a2">本帧无告警</div>';
}
function step(d){i=Math.max(0,Math.min(N-1,i+d));seek();}
function jumpAlert(d){
  var fr=F0+i,k=d>0?1e9:-1;
  AL.forEach(function(a){if(d>0&&a[0]>fr&&a[0]<k)k=a[0];if(d<0&&a[0]<fr&&a[0]>k)k=a[0];});
  if(k<1e9&&k>-1){i=k-F0;seek();}
}
document.getElementById('pp').onclick=function(){playing=!playing;this.textContent=playing?'⏸ 暂停':'▶ 播放';
  if(playing){[v2,v3].forEach(function(v){v.play().catch(function(){});});if(hasOrig)document.getElementById('v1').play().catch(function(){});}
  else{[v2,v3].forEach(function(v){v.pause();});if(hasOrig)document.getElementById('v1').pause();}
  last=0;};
document.getElementById('sl').oninput=function(){i=+this.value;seek();};
document.getElementById('sp').onchange=function(){var r=parseFloat(this.value);[v2,v3].forEach(function(v){v.playbackRate=r;});if(hasOrig)document.getElementById('v1').playbackRate=r;};
document.addEventListener('keydown',function(e){
  if(e.key==='ArrowLeft'){step(-1);e.preventDefault();}
  if(e.key==='ArrowRight'){step(1);e.preventDefault();}
  if(e.key===' '){document.getElementById('pp').click();e.preventDefault();}
});
setInterval(function(){
  if(!playing)return;
  var m=Math.max(v2.currentTime,v3.currentTime)*FPS;
  if(Math.abs(m-i)>1.2){i=Math.round(m);render();document.getElementById('sl').value=i;}
},800);
var q=new URLSearchParams(location.search);
if(q.get('f')){i=Math.max(0,Math.min(N-1,+q.get('f')-F0));}
[v2,v3].forEach(function(v){v.addEventListener('seeked',function(){if(!playing)render();});});
seek();
</script></body></html>"""

orig_html = """<video id="v1" src="__ORIG__" preload="auto"></video>"""
orig_miss = """<div class="miss">未找到原视频<br>把 cam4 原视频命名为 <b>cam4_original.mp4</b> 放到本文件夹（数据/）即可，或刷新页面</div>"""

import os
if os.path.exists('数据/' + orig):
    panel = orig_html.replace('__ORIG__', orig)
else:
    panel = orig_miss
html = html.replace('<div id="p1"></div>', panel)
html = html.replace('__F0__', str(F0)).replace('__ALERTS__', json.dumps(alerts, ensure_ascii=False, separators=(',', ':')))
open('数据/cam4_对比工作站.html', 'w').write(html)
print('workstation saved:', round(len(html) / 1e6, 2), 'MB | alerts:', len(alerts))
