import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
const JOBS = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const proc = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/ed-cdp-profile',
  '--no-first-run',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  'about:blank',
], { stdio: 'ignore', detached: false });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ERRORS = [];

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error('chrome not up');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.sessionId = null;
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params?.exceptionDetails;
        ERRORS.push('JS ' + (d?.exception?.description || d?.text || '?').split('\n')[0]);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
        ERRORS.push('CONSOLE ' + (m.params.args || []).map(a => a.value || a.description || '').join(' '));
      }
    };
  }
  send(method, params = {}, sessionId = this.sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
const cdp = new CDP(ws);

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
cdp.sessionId = sessionId;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');

for (const job of JOBS) {
  const w = job.width || 1440, h = job.height || 900;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 1, mobile: !!job.mobile,
    screenWidth: w, screenHeight: h,
  });
  if (job.mobile) await cdp.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  ERRORS = [];
  await cdp.send('Page.navigate', { url: job.url });
  await sleep(job.wait || 5000);
  try {
    const probe = `JSON.stringify({t:document.title,h1:document.querySelectorAll('h1').length,
      mm:document.querySelectorAll('.mm').length,
      body:(document.getElementById('body')?document.getElementById('body').children.length:-1),
      ph:document.querySelectorAll('.ph').length,
      phEmpty:[...document.querySelectorAll('.ph')].filter(p=>!p.textContent.trim()&&!p.querySelector('svg')).length,
      nav:document.body.getAttribute('data-page'),
      cur:document.querySelectorAll('[aria-current="page"]').length,
      h:(document.scrollingElement||document.body).scrollHeight})`;
    const r = await cdp.send('Runtime.evaluate', { expression: probe, returnByValue: true });
    console.log('PROBE', job.name || (job.shots && job.shots[0].name), r.result.value);
  } catch (e) { console.log('probe err', e.message); }
  if (ERRORS.length) console.log('!! ERRORS', JSON.stringify(ERRORS.slice(0, 6)));
  if (job.js) { try { const rj = await cdp.send("Runtime.evaluate", { expression: job.js, returnByValue: true }); console.log("EVAL", JSON.stringify(rj.result.value)); } catch (e) { console.log('js err', e.message); } await sleep(job.jsWait || 1500); }

  const shots = job.shots || [{ name: job.name, full: true }];
  for (const s of shots) {
    if (s.scroll !== undefined) {
      await cdp.send('Runtime.evaluate', { expression: `(()=>{const el=[document.scrollingElement,document.body,document.documentElement].find(e=>e&&e.scrollHeight>e.clientHeight+50)||document.body; el.scrollTop=${s.scroll}; window.scrollTo(0,${s.scroll}); return el.scrollTop;})()` });
      await sleep(1500);
    }
    const params = { format: 'jpeg', quality: 82, optimizeForSpeed: false };
    let data;
    try {
      const res = await Promise.race([
        cdp.send('Page.captureScreenshot', params),
        sleep(20000).then(() => { throw new Error('capture timeout'); }),
      ]);
      data = res.data;
    } catch (e) { console.log('CAPTURE FAILED', s.name, e.message); continue; }
    const file = path.join(OUT, `${s.name}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('saved', file, fs.statSync(file).size);
  }
}

ws.close();
proc.kill();
await sleep(500);
process.exit(0);
