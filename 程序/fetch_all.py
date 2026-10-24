import json
import urllib.request
import concurrent.futures

HOST = 'http://58.247.144.181:18099'
CK = open('数据/cookie_header.txt').read().strip()
PROJECTS = {'cam2': 5, 'cam3': 6, 'cam5': 8, 'cam6': 9, 'cam7': 10,
            'cam8': 11, 'cam9': 12, 'cam10': 14, 'cam11': 15, 'cam12': 16}


def get(url):
    req = urllib.request.Request(url, headers={'Cookie': CK, 'Accept': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=180))


def fetch(item):
    cam, pid = item
    tasks, page = [], 1
    while True:
        data = get(f'{HOST}/api/projects/{pid}/tasks?page={page}&page_size=1000')
        if not data:
            break
        tasks.extend(data)
        if len(data) < 1000:
            break
        page += 1
    json.dump(tasks, open(f'数据/raw_{cam}.json', 'w'), ensure_ascii=False)
    return cam, len(tasks)


with concurrent.futures.ThreadPoolExecutor(3) as ex:
    for cam, n in ex.map(fetch, PROJECTS.items()):
        print(f'{cam}: {n} tasks', flush=True)
print('ALL DONE')
