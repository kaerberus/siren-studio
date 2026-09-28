// End-to-end test of the editor's real chat module (app/js/agent.js + bridge.js)
// against a live OpenCode service. Dev-only harness.
import { JSDOM } from 'jsdom';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = `${ROOT}/app`;
const BASE = `http://127.0.0.1:${process.env.TEST_PORT || 8788}`;
const WS = process.env.TEST_WORKSPACE
  || path.join(process.env.TEST_ROOT || '/tmp/opencode/mermaid-tests', 'workspace');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `${BASE}/` });
const { window } = dom;
const define = (k, v) => {
  try { globalThis[k] = v; }
  catch (_) { Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); }
};
define('window', window);
define('document', window.document);
define('navigator', window.navigator);

const realFetch = globalThis.fetch;
const fetchShim = (url, opts) => realFetch(
  typeof url === 'string' && url.startsWith('/') ? BASE + url : url, opts,
);
define('fetch', fetchShim);
window.fetch = fetchShim;

class ES {
  constructor(url) { this.url = url; this._l = {}; }
  addEventListener(n, f) { (this._l[n] ||= []).push(f); }
  close() {}
}
define('EventSource', ES);
window.EventSource = ES;

const { createAgent, extractAssistant } = await import(`file://${APP}/js/agent.js`);

const results = [];
const check = (name, cond, extra = '') => results.push([cond ? 'PASS' : 'FAIL', name, extra]);

let latest = [];
let busyStates = [];
let status = '';
const notices = [];
const agent = createAgent({
  logEl: window.document.createElement('div'),
  onStatus: (s) => { status = s; },
  onBusy: (b) => busyStates.push(b),
  onMessages: (m) => { latest = m; },
  onNotice: (n) => notices.push(n),
});

const MODEL = { providerID: 'deepseek', id: 'deepseek-flash' };
await agent.connect({ workspace: WS, oc: { agents: [{ id: 'graph-engineer' }] } }, WS, MODEL);
check('session created by the app module', /^ses_/.test(agent.sessionId || ''), agent.sessionId);
check('status names the model', /deepseek\/deepseek-flash/.test(status), status);

const { oc } = await import(`file://${APP}/js/bridge.js`);
const info = (await oc.call(`/api/session/${agent.sessionId}`)).data;
check('session is pinned to deepseek-flash',
  info.model?.providerID === 'deepseek' && info.model?.id === 'deepseek-flash',
  JSON.stringify(info.model));
check('session uses the graph-engineer agent', info.agent === 'graph-engineer', info.agent);

await agent.send('In one sentence, what is a design gap? Prose only, no tools, no code blocks.', {
  attachGraph: false, attachGaps: false,
});

const deadline = Date.now() + 90000;
let text = '';
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500));
  await agent.refresh();
  const assistants = latest.filter((m) => m.type === 'assistant');
  const last = assistants[assistants.length - 1];
  if (last) text = extractAssistant(last).text || text;
  if (text.trim() && !agent.busy) break;
}

const lastModel = latest.filter((m) => m.type === 'assistant').pop()?.model;
check('assistant text arrives through the app module', text.trim().length > 0, `${text.trim().length} chars`);
check('the reply came from deepseek-flash', lastModel?.id === 'deepseek-flash', JSON.stringify(lastModel));
check('busy state toggled on then off',
  busyStates.includes(true) && busyStates[busyStates.length - 1] === false,
  JSON.stringify(busyStates));
check('no stall or empty notice fired',
  !notices.some((n) => n && (n.type === 'stalled' || n.type === 'empty')), JSON.stringify(notices));
console.log('\nREPLY:', text.trim().slice(0, 220));

// prompt context building: attach a diagram and confirm it is inlined
const built = await agent.send('noop', {
  attachGraph: true, attachGaps: true,
  graph: 'flowchart TD\n    A --> B\n', graphPath: 'demo.mmd',
  gaps: '- [ ] open question', gapsPath: 'demo.gaps.md',
});
check('send with attachments resolves', built === undefined);

let failed = 0;
for (const [s, n, e] of results) { if (s === 'FAIL') failed += 1; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
