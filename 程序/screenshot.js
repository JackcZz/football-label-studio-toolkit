const fs = require('fs');
const targetId = process.argv[2];
const outPath = process.argv[3];
const ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${targetId}`);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  return new Promise((r) => pending.set(msgId, r));
}
ws.addEventListener('open', async () => {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    if (r && r.data) {
      fs.writeFileSync(outPath, Buffer.from(r.data, 'base64'));
      console.log(JSON.stringify({ ok: true, path: outPath, bytes: fs.statSync(outPath).size }));
    } else {
      console.log(JSON.stringify({ ok: false, raw: r }));
    }
  } catch (e) {
    console.error('FAIL', e.message);
  }
  ws.close();
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
});
