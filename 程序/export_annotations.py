import json
import csv
import os
import collections

HOST = 'http://YOUR_LABEL_STUDIO_HOST'
OUT = '数据/YOUR_PROJECT_全镜头标注数据'
CAMS = [('cam2', '数据/raw_cam2.json', 5), ('cam3', 'raw_cam3.json', 6), ('cam4', 'cam4_tasks.json', 7),
        ('cam5', 'raw_cam5.json', 8), ('cam6', 'raw_cam6.json', 9), ('cam7', 'raw_cam7.json', 10),
        ('cam8', 'raw_cam8.json', 11), ('cam9', 'raw_cam9.json', 12), ('cam10', 'raw_cam10.json', 14),
        ('cam11', 'raw_cam11.json', 15), ('cam12', 'raw_cam12.json', 16)]

os.makedirs(OUT, exist_ok=True)
summary = []

for cam, fn, pid in CAMS:
    tasks = json.load(open(fn))
    tasks.sort(key=lambda t: t['id'])
    os.makedirs(f'{OUT}/{cam}', exist_ok=True)
    lab_cnt = collections.Counter()
    miss = 0
    boxes_n = 0
    with open(f'{OUT}/{cam}/tasks.csv', 'w', newline='', encoding='utf-8-sig') as ft, \
         open(f'{OUT}/{cam}/annotations.csv', 'w', newline='', encoding='utf-8-sig') as fa:
        wt = csv.writer(ft)
        wa = csv.writer(fa)
        wt.writerow(['页面ID', '帧号', '图片服务器路径', '在线查看'])
        wa.writerow(['页面ID', '帧号', '区域ID', '类别', '号码',
                     'x%', 'y%', '宽%', '高%', 'x_px', 'y_px', '宽_px', '高_px'])
        for t in tasks:
            tid = t['id']
            frame = t['data'].get('frame', '')
            img = t['data'].get('image', '')
            wt.writerow([tid, frame, img, f'{HOST}/projects/{pid}/data?tab=12&task={tid}'])
            res = (t.get('predictions') or [{}])[0].get('result', [])
            boxes = {}
            for r in res:
                b = boxes.setdefault(r.get('id'), {'rid': r.get('id')})
                if r.get('type') == 'rectanglelabels':
                    v = r['value']
                    b.update(label=(v.get('rectanglelabels') or [''])[0], x=v['x'], y=v['y'],
                             w=v['width'], h=v['height'],
                             ow=r.get('original_width', 1920), oh=r.get('original_height', 1080))
                elif r.get('type') == 'textarea':
                    b['number'] = (r['value'].get('text') or [''])[0]
            for rid in sorted(boxes, key=lambda k: (k is None, str(k))):
                b = boxes[rid]
                if not b.get('label'):
                    continue
                num = str(b.get('number', '') or '').strip()
                lab_cnt[b['label']] += 1
                boxes_n += 1
                if not num:
                    miss += 1
                ow, oh = b.get('ow', 1920), b.get('oh', 1080)
                wa.writerow([tid, frame, rid or '', b['label'], num,
                             round(b['x'], 3), round(b['y'], 3), round(b['w'], 3), round(b['h'], 3),
                             round(b['x'] * ow / 100, 1), round(b['y'] * oh / 100, 1),
                             round(b['w'] * ow / 100, 1), round(b['h'] * oh / 100, 1)])
    summary.append([cam, pid, len(tasks), boxes_n, lab_cnt.get('teamA', 0), lab_cnt.get('teamB', 0),
                    lab_cnt.get('goalkeeperA', 0), lab_cnt.get('goalkeeperB', 0),
                    lab_cnt.get('referee', 0), lab_cnt.get('unknown', 0), miss])
    print(f'{cam}: {len(tasks)} tasks, {boxes_n} boxes', flush=True)

with open(f'{OUT}/汇总.csv', 'w', newline='', encoding='utf-8-sig') as f:
    w = csv.writer(f)
    w.writerow(['机位', '项目ID', '帧数', '框数', 'teamA', 'teamB', 'goalkeeperA', 'goalkeeperB', 'referee', 'unknown', '缺号框数'])
    w.writerows(summary)

with open(f'{OUT}/README.txt', 'w', encoding='utf-8') as f:
    f.write(f"""YOUR_PROJECT 全镜头标注数据（11 个机位，数据源 Label Studio predictions，只读导出）
================================================================

目录结构
  cam2/ ... cam12/     每个机位一个文件夹
    tasks.csv          每帧一行：页面ID(升序)、帧号、图片服务器路径、在线查看链接
    annotations.csv    每个检测框一行：页面ID、帧号、区域ID、类别、号码、
                       位置（Label Studio 百分比 x/y/宽/高 + 换算像素 x/y/宽/高，原图 1920x1080）
  汇总.csv             各机位帧数/框数/类别分布/缺号统计
  cam4_review_page.html 为 cam4 的筛查结果（P0/P1/P2 待查清单，按页面 ID 排序）

说明
- 所有数据均为机器预测结果（model_version=凉白开），平台内无人工标注。
- 图片未下载：点击 tasks.csv 的"在线查看"列即可在 Label Studio 打开对应帧。
- 百分比坐标为 Label Studio 原始格式（相对图片宽高的百分比，x/y 为左上角）。
- 类别：teamA / teamB / goalkeeperA / goalkeeperB / referee / unknown；号码列为空 = 该框未识别出号码。
""")

print('export done')
