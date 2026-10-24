import json
import urllib.request
import urllib.error
import time

HOST = 'http://58.247.144.181:18099'
CK = open('数据/cookie_header.txt').read().strip()
PROJECTS = {'cam11': 15, 'cam12': 16}


def get(url, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={'Cookie': CK, 'Accept': 'application/json'})
            return json.load(urllib.request.urlopen(req, timeout=180))
        except Exception as e:
            wait = 8 * (k + 1)
            print(f'retry {k + 1} after {e} (wait {wait}s)', flush=True)
            time.sleep(wait)
    raise RuntimeError('gave up: ' + url)


for cam, pid in PROJECTS.items():
    tasks, page = [], 1
    while True:
        data = get(f'{HOST}/api/projects/{pid}/tasks?page={page}&page_size=1000')
        if not data:
            break
        tasks.extend(data)
        print(f'{cam} page {page}: total={len(tasks)}', flush=True)
        if len(data) < 1000:
            break
        page += 1
        time.sleep(1)
    json.dump(tasks, open(f'数据/raw_{cam}.json', 'w'), ensure_ascii=False)
    print(f'{cam}: {len(tasks)} tasks saved', flush=True)
print('REST DONE')
