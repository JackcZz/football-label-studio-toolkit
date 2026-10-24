import json
import urllib.request

HOST = 'http://YOUR_LABEL_STUDIO_HOST'
CK = open('数据/cookie_header.txt').read().strip()


def get(url):
    req = urllib.request.Request(url, headers={'Cookie': CK, 'Accept': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=120))


tasks = []
page = 1
while True:
    data = get(f'{HOST}/api/projects/7/tasks?page={page}&page_size=1000')
    if not data:
        break
    tasks.extend(data)
    print(f'page {page}: +{len(data)} total={len(tasks)}', flush=True)
    if len(data) < 1000:
        break
    page += 1

json.dump(tasks, open('数据/cam4_tasks.json', 'w'), ensure_ascii=False)
print('DONE total tasks =', len(tasks))
