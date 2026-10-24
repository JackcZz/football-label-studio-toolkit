const fs = require('fs');
const targetId = process.argv[2];
const mode = process.argv[3];
const HOST = 'http://YOUR_LABEL_STUDIO_HOST';
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
    if (mode === 'cookies') {
      await send('Network.enable');
      const r = await send('Network.getCookies', { urls: [HOST] });
      console.log(JSON.stringify(r.cookies));
    } else {
      const expr = fs.readFileSync(process.argv[4], 'utf8');
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      console.log(JSON.stringify(r.exceptionDetails ? { error: r.exceptionDetails } : r.result.value ?? r.result));
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
