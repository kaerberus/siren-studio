// Headless smoke test for the Siren Studio frontend.
// Dev-only harness: jsdom + the real CodeMirror vendor bundle, mermaid stubbed.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const BASE = `http://127.0.0.1:${process.env.TEST_PORT || 8788}`;
const BROWSE_DIR = process.env.TEST_BROWSE_DIR || '/tmp/opencode';
const errors = [];
const results = [];
const check = (name, cond, extra = '') => results.push([cond ? 'PASS' : 'FAIL', name, extra]);

const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: BASE + '/', pretendToBeVisual: true, runScripts: 'outside-only' });
const { window } = dom;

const define = (key, value) => {
  try { globalThis[key] = value; }
  catch (_) { Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); }
};
define('window', window);
define('document', window.document);
define('navigator', window.navigator);
define('localStorage', window.localStorage);
define('location', window.location);
define('history', window.history);
for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'XMLSerializer',
  'DOMParser', 'Image', 'Blob', 'URL', 'FileReader']) {
  if (window[k]) globalThis[k] = window[k];
}
globalThis.CSS = window.CSS || {};
if (!globalThis.CSS.escape) {
  globalThis.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
window.Element.prototype.scrollIntoView = function scrollIntoView() {};
window.confirm = () => true;
if (typeof globalThis.confirm !== 'function') globalThis.confirm = () => true;

// jsdom implements neither Range geometry nor Element.getClientRects.
const zeroRect = {
  left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
  toJSON() { return this; },
};
const emptyRectList = {
  length: 0,
  item: () => null,
  *[Symbol.iterator]() {},
};
if (window.Range) {
  window.Range.prototype.getBoundingClientRect = () => zeroRect;
  window.Range.prototype.getClientRects = () => emptyRectList;
}
if (window.Element && !window.Element.prototype.getClientRects) {
  window.Element.prototype.getClientRects = () => emptyRectList;
}
// jsdom has no pointer capture. The splitters use it, and the viewer's pan
// threshold is asserted through it, so record the calls.
const pointerCaptures = [];
window.Element.prototype.setPointerCapture = function setPointerCapture(id) { pointerCaptures.push(id); };
window.Element.prototype.releasePointerCapture = function releasePointerCapture() {};

const realFetch = globalThis.fetch;
let fakeNoAgent = false; // test hook: pretend the service has no graph-engineer
globalThis.fetch = (url, opts) => {
  if (fakeNoAgent && typeof url === 'string' && url.includes('/oc/api/agent')) {
    return Promise.resolve(new Response(JSON.stringify({
      location: {}, data: [{ id: 'build', name: 'Build', mode: 'primary', hidden: false }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  const u = typeof url === 'string' && url.startsWith('/') ? BASE + url : url;
  return realFetch(u, opts);
};
window.fetch = globalThis.fetch;

class EventSourceStub {
  constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; this.onopen = null; this._l = {}; }
  addEventListener(name, fn) { (this._l[name] ||= []).push(fn); }
  close() {}
}
globalThis.EventSource = EventSourceStub;
window.EventSource = EventSourceStub;

// jsdom cannot implement navigation; our download helper triggers this on click.
const JSDOM_NOISE = /Not implemented: navigation/;
const realError = console.error;
console.error = (...args) => {
  const line = args.map(String).join(' ');
  if (!JSDOM_NOISE.test(line)) errors.push('console.error: ' + line);
  realError(...args);
};
window.addEventListener('error', (e) => errors.push('window.error: ' + (e.error?.stack || e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + (e.reason?.stack || e.reason)));

for (const f of ['codemirror.min.js', 'simple.js', 'matchbrackets.js', 'closebrackets.js',
  'active-line.js', 'comment.js', 'searchcursor.js', 'lint.js', 'placeholder.js']) {
  try {
    window.eval(fs.readFileSync(path.join(APP, 'vendor/codemirror', f), 'utf8'));
  } catch (err) { errors.push(`vendor ${f}: ${err.message}`); }
}
check('CodeMirror vendor loaded', !!window.CodeMirror);

window.mermaid = {
  initialize() {},
  async parse(t) {
    if (!/^\s*(flowchart|graph|stateDiagram|sequenceDiagram|erDiagram|classDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart)/m.test(t)) {
      throw Object.assign(new Error('Parse error on line 1'), { hash: { loc: { first_line: 1 } } });
    }
    const o = (t.match(/\[/g) || []).length;
    const c = (t.match(/\]/g) || []).length;
    if (o !== c) throw Object.assign(new Error('unbalanced brackets'), { hash: { loc: { first_line: 1 } } });
    return true;
  },
  async render(_id, t) {
    // Capture id + label, so node textContent exists as it does in real Mermaid.
    const nodesById = new Map();
    const re = /([A-Za-z_][\w-]*)\s*[\(\[\{]+\s*([^\)\]\}]*?)\s*[\)\]\}]+/g;
    let m;
    while ((m = re.exec(t))) if (!nodesById.has(m[1])) nodesById.set(m[1], m[2]);
    const nodes = [...nodesById].slice(0, 10)
      .map(([n, label], i) => `<g class="node" id="flowchart-${n}-${i}" data-id="${n}">`
        + `<rect width="60" height="30"/><text>${label}</text></g>`).join('');
    // Mimic mermaid's real root: width="100%", no height, negative-origin viewBox.
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="100%" class="flowchart" style="max-width: 400px;" viewBox="-8 -8 400 200">${nodes}</svg>` };
  },
};

// Reset the isolated test workspace so runs are deterministic: drop every
// diagram so the only one the app can auto-open is the one we control.
if (!window.URL.createObjectURL) window.URL.createObjectURL = () => 'blob:mock';
if (!window.URL.revokeObjectURL) window.URL.revokeObjectURL = () => {};
globalThis.URL = window.URL;

const existing = await globalThis.fetch(`${BASE}/api/fs/tree`).then((r) => r.json());
for (const entry of existing.entries || []) {
  if (entry.type === 'file' && /\.(mmd|mermaid)$/.test(entry.name)) {
    await globalThis.fetch(`${BASE}/api/fs/file?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' });
  }
}
await globalThis.fetch(`${BASE}/api/fs/file`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    path: 'example.mmd',
    content: 'flowchart TD\n    A[Start] --> B{Ready?}\n    B -->|yes| C[Go]\n    B -->|no| A\n',
  }),
});

await import('file://' + path.join(APP, 'js', 'app.js'));

const studio = window.__mermaidStudio;
const state = studio?.state;
for (let i = 0; i < 80 && !state?.config; i += 1) await new Promise((r) => setTimeout(r, 100));
// wait for boot to finish opening the first diagram and populating the outline
const waitFor = async (name, fn, tries = 80) => {
  for (let i = 0; i < tries; i += 1) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  errors.push(`timeout waiting for ${name}`);
  return false;
};
await waitFor('tab open', () => (state?.tabs?.length || 0) > 0);
await waitFor('outline', () => document.querySelectorAll('#outline-list .outline-item').length > 0);
await waitFor('preview', () => !!document.querySelector('#graph-target svg'));
await waitFor('gaps ledger', () => /Open questions/.test(document.querySelector('#gaps-list').textContent));

check('config loaded', !!state?.config, `oc.ok=${state?.config?.oc?.ok}`);
check('workspace set', !!state?.workspace, state?.workspace);
check('agents list includes graph-engineer', !!state?.config?.oc?.agents?.some((a) => a.id === 'graph-engineer'));
check('file tree rendered', document.querySelectorAll('#file-tree .tree-item').length > 0,
  `items=${document.querySelectorAll('#file-tree .tree-item').length}`);
check('editor created', !!document.querySelector('.CodeMirror'));
check('tab opened from disk', (state?.tabs || []).length > 0, (state?.tabs || []).map((t) => t.name).join(','));
check('preview rendered', !!document.querySelector('#graph-target svg'),
  `nodes=${document.querySelectorAll('#graph-target g.node').length}`);
check('outline populated', document.querySelectorAll('#outline-list .outline-item').length > 0,
  `items=${document.querySelectorAll('#outline-list .outline-item').length}`);
check('templates rendered', document.querySelectorAll('#template-grid button').length === 6);
check('smart view toggle exists, on by default',
  document.querySelector('#smart-view')?.checked === true);
check('gaps panel renders the ledger',
  /Open questions/.test(document.querySelector('#gaps-list').textContent),
  document.querySelector('#gaps-list').textContent.slice(0, 40));

// the folder you are actually on is named in three places — the launcher can
// reopen any project, so this is what stops "wait, which one is this?"
try {
  const projectName = state?.config?.projectName;
  const head = document.querySelector('#files-root');
  check('the file-tree head names the project',
    Boolean(projectName) && head.textContent.includes(projectName),
    `${head.textContent} vs ${projectName}`);
  check('the file-tree head carries the absolute path as a tooltip',
    head.title === state.config.graphsPath,
    `${head.title} vs ${state.config.graphsPath}`);
  check('the browser tab names the project',
    document.title.startsWith(projectName) && /Siren Studio/.test(document.title),
    document.title);
  check('the rescan button is named for what it does',
    document.querySelector('#btn-refresh').title === 'Rescan folder',
    document.querySelector('#btn-refresh').title);

  const seen = () => document.querySelectorAll('#toasts .toast').length;
  const before = seen();
  document.querySelector('#btn-refresh').click();
  await waitFor('rescan toast', () => seen() > before);
  const said = document.querySelector('#toasts .toast')?.textContent || '';
  check('rescan reports what it did', /Rescanned/.test(said), said);
  check('rescan leaves the tree rendered',
    document.querySelectorAll('#file-tree .tree-item').length > 0);
} catch (err) { check('workspace labels block', false, err.message); }

// accessibility floor: navigation rows and the tab close affordance are real
// controls, so the file tree, outline and tabs are operable from the keyboard.
try {
  const treeRow = document.querySelector('#file-tree .tree-item');
  const outlineRow = document.querySelector('#outline-list .outline-item');
  check('file-tree rows are keyboard-operable buttons',
    treeRow?.tagName === 'BUTTON', treeRow?.tagName);
  check('outline rows are keyboard-operable buttons',
    outlineRow?.tagName === 'BUTTON', outlineRow?.tagName);
  check('the active file row is announced',
    Boolean(document.querySelector('#file-tree .tree-item[aria-current]')));
  const close = document.querySelector('#tabs .tab .tab-close');
  check('the tab close is its own button, with a name',
    close?.tagName === 'BUTTON' && /^Close /.test(close.getAttribute('aria-label') || ''),
    close?.getAttribute('aria-label'));
  const activeSideTab = document.querySelector('.side-tab.active');
  check('the open sidebar tab is announced',
    activeSideTab?.getAttribute('aria-selected') === 'true');
  check('icon-only buttons carry accessible names',
    ['btn-new', 'btn-save', 'btn-export', 'btn-theme', 'toggle-agent', 'btn-present']
      .every((id) => document.getElementById(id)?.getAttribute('aria-label')));
} catch (err) { check('accessibility floor block', false, err.message); }

// viewer: sizing + viewBox-driven fit/zoom (mermaid emits width="100%", viewBox)
try {
  const v = await import('file://' + path.join(APP, 'js', 'viewer.js'));
  const svg = document.querySelector('#graph-target svg');
  check('svg is not fixed-width', !svg.hasAttribute('width') && svg.style.width === '100%');
  check('svg uses meet + viewBox',
    svg.getAttribute('preserveAspectRatio') === 'xMidYMid meet' && !!svg.getAttribute('viewBox'));
  const vp = v.getViewport();
  check('base viewBox read from svg', vp.base.w === 400 && vp.base.x === -8, JSON.stringify(vp.base));
  // fit adds 5% padding: x=-8-20=-28, w=400*1.1=440, so scale = 400/440
  check('fit shows the whole graph, padded',
    Math.abs(vp.view.w - 440) < 0.001 && Math.abs(vp.view.x + 28) < 0.001
      && Math.abs(vp.scale - 400 / 440) < 0.001,
    `${JSON.stringify(vp.view)} scale=${vp.scale}`);

  const centre = (p) => ({ x: p.view.x + p.view.w / 2, y: p.view.y + p.view.h / 2 });
  const c0 = centre(vp);
  v.zoom(2);
  const vp2 = v.getViewport();
  const c1 = centre(vp2);
  check('zoom doubles the scale', Math.abs(vp2.scale / vp.scale - 2) < 0.001, `${vp.scale} -> ${vp2.scale}`);
  check('zoom keeps the centre fixed',
    Math.abs(c1.x - c0.x) < 0.01 && Math.abs(c1.y - c0.y) < 0.01,
    `${JSON.stringify(c0)} -> ${JSON.stringify(c1)}`);
  v.fit();
  check('fit resets to the full graph', Math.abs(v.getViewport().view.w - 440) < 0.001);

  // export must ignore the current zoom/pan
  v.zoom(4);
  const RealBlob = window.Blob;
  let lastParts = null;
  const WrappedBlob = class extends RealBlob {
    constructor(parts, opts) { super(parts, opts); lastParts = parts; }
  };
  window.Blob = WrappedBlob;
  globalThis.Blob = WrappedBlob;
  const ok = v.exportSvg('x.svg');
  window.Blob = RealBlob;
  const markup = (lastParts && lastParts[0]) || '';
  check('export ignores zoom and uses the natural viewBox',
    ok && markup.includes('viewBox="-8 -8 400 200"') && markup.includes('width="400"'),
    markup.slice(0, 80));

  // the editor answers the plugin's validation requests with the real parser
  const good = await v.parseSource('flowchart TD\n    A[Start] --> B[Next]\n');
  check('parseSource accepts valid source', good.ok === true && good.errors.length === 0);
  const bad = await v.parseSource('this is not a diagram');
  check('parseSource reports errors with a line number',
    bad.ok === false && bad.errors.length === 1 && bad.errors[0].line >= 1,
    JSON.stringify(bad.errors));
  const empty = await v.parseSource('   ');
  check('parseSource rejects empty source', empty.ok === false);
  // answering an unknown nonce must not throw (the bridge may have timed out)
  await studio.bridge.validateResult('deadbeef', { ok: true, errors: [] });

  // fit is the default; once the user adjusts, re-renders keep their viewport
  v.fit();
  check('fit clears the user-adjusted flag', v.getViewport().userAdjusted === false);
  v.zoom(2);
  const scaled = v.getViewport();
  check('zooming marks the view user-adjusted', scaled.userAdjusted === true);
  await v.render('flowchart TD\n    A[One] --> B[Two]\n');
  const kept = v.getViewport();
  check('re-render preserves the user viewport',
    Math.abs(kept.scale - scaled.scale) < 0.05 && kept.userAdjusted === true,
    `scale ${scaled.scale.toFixed(3)} -> ${kept.scale.toFixed(3)}`);
  v.resetView();
  await v.render('flowchart TD\n    A[One] --> B[Two]\n');
  check('after resetView the next render fits again',
    v.getViewport().userAdjusted === false && Math.abs(v.getViewport().view.w - 440) < 0.001);
  v.fit();
} catch (err) {
  check('viewer behaviour block', false, err.message);
}

// agent-panel splitter: the panel is a grid column, so the drag rewrites
// --agent-w. jsdom does no layout, so the body rect is stubbed.
try {
  const agentSplitter = document.getElementById('agent-splitter');
  check('agent splitter exists', Boolean(agentSplitter));
  const bodyEl = document.querySelector('.body');
  const agentW = () => document.documentElement.style.getPropertyValue('--agent-w');
  const pointer = (type, clientX) => {
    const event = new window.MouseEvent(type, { bubbles: true, clientX });
    event.pointerId = 1;
    return event;
  };
  // A whole drag: pointerdown captures the rect, so each case re-presses.
  const drag = (width, clientX) => {
    bodyEl.getBoundingClientRect = () => ({
      left: 0, right: width, top: 0, bottom: 600, width, height: 600, x: 0, y: 0,
    });
    agentSplitter.dispatchEvent(pointer('pointerdown', width));
    agentSplitter.dispatchEvent(pointer('pointermove', clientX));
    const value = agentW();
    agentSplitter.dispatchEvent(pointer('pointerup', clientX));
    return value;
  };

  const app = document.getElementById('app');
  bodyEl.getBoundingClientRect = () => ({
    left: 0, right: 1000, top: 0, bottom: 600, width: 1000, height: 600, x: 0, y: 0,
  });
  agentSplitter.dispatchEvent(pointer('pointerdown', 640));
  check('a drag marks the splitter and suppresses the column transition',
    agentSplitter.classList.contains('dragging') && app.classList.contains('resizing'));
  agentSplitter.dispatchEvent(pointer('pointerup', 640));
  check('ending the drag clears the resizing state',
    !agentSplitter.classList.contains('dragging') && !app.classList.contains('resizing'));

  const tracked = drag(1000, 640);
  check('the drag tracks the pointer', tracked === '360px', tracked);
  const capped = drag(2000, 1000);
  check('the panel has an absolute maximum', capped === '720px', capped);
  const floored = drag(800, 100);
  check('the workbench keeps a floor', floored === '380px', floored);
  const minimum = drag(800, 790);
  check('the panel has a minimum', minimum === '280px', minimum);
  delete bodyEl.getBoundingClientRect;
} catch (err) { check('agent splitter block', false, err.message); }

// A press in the viewer only becomes a pan once it moves. Capturing the pointer
// on pointerdown would retarget the following click, so a node would never hear
// it and neither links nor jump-to-source would work.
try {
  const stage = document.getElementById('graph-stage');
  const press = (type, x, y, buttons = 1) => {
    const event = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    event.pointerId = 7;
    Object.defineProperty(event, 'buttons', { value: buttons });
    return event;
  };
  const captures = () => pointerCaptures.filter((id) => id === 7).length;
  pointerCaptures.length = 0;

  stage.dispatchEvent(press('pointerdown', 100, 100));
  stage.dispatchEvent(press('pointermove', 101, 100));   // 1px of jitter
  check('a press that barely moves is still a click, not a pointer capture',
    captures() === 0, `captures=${JSON.stringify(pointerCaptures)}`);

  stage.dispatchEvent(press('pointermove', 160, 100));   // 60px: a pan
  check('a press that moves becomes a pan and captures the pointer',
    captures() === 1, `captures=${JSON.stringify(pointerCaptures)}`);
  stage.dispatchEvent(press('pointerup', 160, 100, 0));

  stage.dispatchEvent(press('pointerdown', 300, 200));
  stage.dispatchEvent(press('pointermove', 301, 200, 0)); // released off-stage
  stage.dispatchEvent(press('pointermove', 400, 200));    // a later hover
  check('a release we never heard about does not leave a pan armed',
    captures() === 1, `captures=${JSON.stringify(pointerCaptures)}`);
} catch (err) { check('pan threshold block', false, err.message); }

// simulate a user edit (origin +input, which is what typing produces)
const cm = studio?.editor?.cm;
if (cm) {
  const src = 'flowchart TD\n    A([Start]) --> B{Ok?}\n    B -->|yes| C[(Store)]\n    B -->|no| D[Fail]\n    C --> E([Done])\n';
  cm.replaceRange(src, { line: 0, ch: 0 }, { line: cm.lineCount(), ch: 0 }, '+input');
  await new Promise((r) => setTimeout(r, 700));
  check('preview re-rendered after edit', !!document.querySelector('#graph-target svg'));
  check('outline detects all node shapes', document.querySelectorAll('#outline-list .outline-item').length >= 5,
    `items=${document.querySelectorAll('#outline-list .outline-item').length}`);
  check('edit marks tab dirty', state.tabs.find((t) => t.key === state.active)?.dirty === true);
}

// chat rendering + apply-to-editor flow
try {
  studio.renderChat([{
    id: 'msg_test', type: 'assistant', time: { created: 1 },
    content: [{ type: 'text', text: 'Here is a draft.\n\n```mermaid\nflowchart LR\n    UI --> API\n```\n\n**Open questions**\n- none' }],
  }]);
  const applyBtn = document.querySelector('#chat-log .apply-graph');
  check('chat renders mermaid block with apply action', !!applyBtn);
  if (applyBtn) {
    applyBtn.click();
    check('apply writes diagram to editor', studio.editor.cm.getValue().includes('UI --> API'),
      studio.editor.cm.getValue().split('\n')[0]);
  }
  const md = studio.markdownToHtml('# H\n- a\n- b\n\n`code` and **bold**');
  check('markdown renders list/heading/inline', md.includes('<ul>') && md.includes('<strong>') && md.includes('<code>'));
  const analysis = studio.analyzeGraph('flowchart TD\n  A[X] --> B{Y}\n  B -->|no| C[(Z)]');
  check('graph analysis finds nodes with labels', analysis.nodes.length === 3,
    analysis.nodes.map((n) => `${n.id}:${n.label}`).join(','));

  // a user turn whose prompt carried inlined files should fold them away
  const withAttach = 'Rename the decision?\n\n'
    + 'Current diagram (a.mmd):\n\n```mermaid\nflowchart LR\n    UI --> API\n```\n\n'
    + 'Current gap ledger (a.gaps.md):\n\n```markdown\n- [ ] retry policy\n```';
  studio.renderChat([
    { id: 'u_plain', type: 'user', text: 'Just a question.' },
    { id: 'u_attach', type: 'user', text: withAttach },
  ]);
  const userMsgs = [...document.querySelectorAll('#chat-log .msg.user')];
  check('plain user message has no attachment fold',
    Boolean(userMsgs[0]) && !userMsgs[0].querySelector('details'));
  const fold = userMsgs[1]?.querySelector('details.msg-attach');
  check('inlined attachments fold into <details>', Boolean(fold));
  check('the fold starts collapsed', Boolean(fold) && fold.open === false);
  const summaryText = fold?.querySelector('summary')?.textContent || '';
  check('the summary names both files',
    /a\.mmd/.test(summaryText) && /a\.gaps\.md/.test(summaryText), summaryText);
  const questionText = userMsgs[1]?.querySelector('.msg-body p')?.textContent || '';
  check('the question stays visible outside the fold',
    /Rename the decision\?/.test(questionText), questionText);
  const foldText = fold?.textContent || '';
  check('the folded source survives, unfenced',
    /flowchart LR/.test(foldText) && !foldText.includes('```'));
} catch (err) {
  check('chat rendering block', false, err.message);
}

// cross-file links: Mermaid's own `click` directive opens another diagram
if (cm) {
  try {
    await studio.bridge.write('child.mmd', 'flowchart LR\n    X --> Y\n');
    if (!state.entries.some((e) => e.path === 'child.mmd')) {
      state.entries.push({ path: 'child.mmd', name: 'child.mmd', type: 'file' });
    }
    const linkSrc = 'flowchart TD\n'
      + '    Go[[Payment detail]] --> Stop[Finish]\n'
      + '    Plain[No link here]\n'
      + '    click Go "child.mmd" "Open the payment detail"\n'
      + '    click Stop "missing.mmd"\n';
    cm.replaceRange(linkSrc, { line: 0, ch: 0 }, { line: cm.lineCount(), ch: 0 }, '+input');
    await new Promise((r) => setTimeout(r, 900));

    const nodes = [...document.querySelectorAll('#graph-target g.node')];
    const byId = (id) => nodes.find((g) => g.dataset.id === id);
    const linked = byId('Go');
    check('a click directive links its node to the file',
      Boolean(linked?.dataset.link) && linked.dataset.link === 'child.mmd',
      linked ? `${linked.dataset.id} -> ${linked.dataset.link}` : 'no link found');
    check('the linked node is marked so it reads as a link',
      Boolean(linked?.classList.contains('node-link')));
    check('a click to a missing diagram stays a plain node',
      Boolean(byId('Stop')) && !byId('Stop').classList.contains('node-link'));
    check('a node without a click directive stays plain',
      Boolean(byId('Plain')) && !byId('Plain').classList.contains('node-link'));

    const opened = () => state.tabs.some((t) => t.path === 'child.mmd');
    check('the linked file is not open before the click', !opened());
    if (linked) {
      // Mermaid wraps a linked node in a real <a href>, and the browser would
      // navigate the app to that path — a full reload. Model it exactly.
      const anchor = document.createElementNS('http://www.w3.org/2000/svg', 'a');
      anchor.setAttribute('href', 'child.mmd');
      linked.parentNode.insertBefore(anchor, linked);
      anchor.appendChild(linked);
      const clickEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      linked.querySelector('text').dispatchEvent(clickEvent);
      await new Promise((r) => setTimeout(r, 400));
      check('the navigation mermaid would trigger is cancelled',
        clickEvent.defaultPrevented === true);
      check('clicking a linked node opens the file in a tab',
        opened() && state.active === 'child.mmd', `active=${state.active} opened=${opened()}`);
      check('the open diagram is reflected in the URL',
        location.pathname === '/child.mmd', location.pathname);
      check('and remembered for the next load',
        localStorage.getItem('ms-last-diagram') === 'child.mmd',
        localStorage.getItem('ms-last-diagram'));
    }
  } catch (err) { check('cross-file link block', false, err.message); }

// which diagram to open: URL first, then the remembered one, then the first
try {
  check('a URL path resolves to the diagram',
    studio.matchDiagramPath('/child.mmd') === 'child.mmd',
    studio.matchDiagramPath('/child.mmd'));
  check('a bare basename resolves too',
    studio.matchDiagramPath('child.mmd') === 'child.mmd');
  check('an unknown path resolves to nothing',
    studio.matchDiagramPath('/nope.mmd') === null);
  check('the URL wins over the remembered diagram', (() => {
    history.replaceState(null, '', '/example.mmd');
    localStorage.setItem('ms-last-diagram', 'child.mmd');
    return studio.initialDiagramPath() === 'example.mmd';
  })(), studio.initialDiagramPath());
  check('with no URL it falls back to the remembered diagram', (() => {
    history.replaceState(null, '', '/');
    localStorage.setItem('ms-last-diagram', 'child.mmd');
    return studio.initialDiagramPath() === 'child.mmd';
  })(), studio.initialDiagramPath());
  check('and with neither, to the first diagram', (() => {
    history.replaceState(null, '', '/');
    localStorage.removeItem('ms-last-diagram');
    return studio.initialDiagramPath() === 'example.mmd';
  })(), studio.initialDiagramPath());
} catch (err) { check('initial diagram block', false, err.message); }
}

// the composer advertises steering while a turn is running
try {
  const idle = studio.composerCopy(false, 'IDLE-PLACEHOLDER');
  const busy = studio.composerCopy(true, 'IDLE-PLACEHOLDER');
  check('idle composer copy invites a prompt',
    idle.placeholder === 'IDLE-PLACEHOLDER' && idle.hint === 'Ctrl+Enter to send',
    JSON.stringify(idle));
  check('busy composer copy advertises steering',
    /steer/i.test(busy.placeholder) && busy.hint === 'Ctrl+Enter to steer',
    JSON.stringify(busy));
  check('the idle placeholder is the shipped one',
    /Graph Engineer/.test(document.querySelector('#chat-input').placeholder),
    document.querySelector('#chat-input').placeholder);
} catch (err) { check('composer copy block', false, err.message); }

// lint path
try {
  const annotations = await window.mermaid.parse('flowchart TD\n    A[unclosed\n');
  check('lint detects broken syntax', false, 'expected throw');
} catch (_) {
  check('lint detects broken syntax', true);
}

// filesystem round trip through the bridge
try {
  const name = `__smoke-${Date.now()}.mmd`;
  await studio.bridge.write(name, 'flowchart LR\n    X --> Y\n');
  const read = await studio.bridge.read(name);
  check('bridge fs round trip', read.content.includes('X --> Y'), name);
  await studio.bridge.remove(name);
} catch (err) {
  check('bridge fs round trip', false, err.message);
}

// model picker + default model
try {
  const select = document.querySelector('#agent-model');
  const options = [...select.querySelectorAll('option')].map((o) => o.value);
  check('model picker is populated', options.length > 0, `${options.length} options`);
  check('config exposes the default model',
    state.config?.defaultModel?.providerID === 'deepseek' && state.config?.defaultModel?.id === 'deepseek-flash',
    JSON.stringify(state.config?.defaultModel));
  check('default model is selected', select.value === 'deepseek/deepseek-flash', select.value);
  check('deepseek variants are offered', options.includes('deepseek/deepseek-flash#high'));
} catch (err) { check('model picker block', false, err.message); }

// searchable model palette, opened from the OpenCode pill
try {
  const pill = document.querySelector('#oc-status');
  check('OpenCode pill is a button', pill?.tagName === 'BUTTON');
  check('pill shows the current model', /DeepSeek/.test(pill.textContent), pill.textContent.trim());
  pill.click();
  await new Promise((r) => setTimeout(r, 250));
  const palette = document.querySelector('.palette');
  check('pill opens the model palette', !!palette);
  const count = () => palette.querySelectorAll('.palette-item').length;
  check('palette lists every model', count() > 20, `${count()} rows`);

  const input = palette.querySelector('#palette-input');
  const search = async (term) => {
    input.value = term;
    input.dispatchEvent(new window.Event('input'));
    await new Promise((r) => setTimeout(r, 80));
    return [...palette.querySelectorAll('.palette-item .palette-name')].map((el) => el.textContent);
  };

  // The palette matches on provider + label + key, and the catalogue changes
  // under us (OpenRouter mirrors appear and sort first), so assert against the
  // app's own entries rather than assuming the term appears in the name.
  const entries = studio.modelEntries();
  const term = 'deepseek';
  const expected = entries
    .filter((e) => `${e.provider} ${e.label} ${e.key}`.toLowerCase().includes(term))
    .map((e) => e.label);
  const labels = await search(term);
  check('search filters to the app\'s own matches',
    labels.length > 0 && labels.length < entries.length
      && labels.every((l) => expected.includes(l)),
    `${labels.length} rows, ${expected.length} expected`);

  await search('no-such-model-xyz');
  check('empty search state', /No model matches/.test(palette.textContent));

  // Pick the base deepseek-flash model by its own label, not "the first row":
  // a provider mirror can sort earlier and would silently test a different model.
  await search('deepseek-flash');
  const target = entries.find((e) => e.key === 'deepseek/deepseek-flash');
  check('the default model is in the palette', Boolean(target), 'deepseek/deepseek-flash');
  const rows = [...palette.querySelectorAll('.palette-item')];
  const row = target
    ? rows.find((r) => r.querySelector('.palette-name').textContent === target.label)
    : null;
  check('the palette offers the default model', Boolean(row), target?.label || 'no target');
  (row || rows[0]).click();
  await new Promise((r) => setTimeout(r, 500));
  check('picking closes the palette', !document.querySelector('.palette'));
  check('picking persists the choice',
    /deepseek\/deepseek-flash/.test(localStorage.getItem('ms-model') || ''),
    localStorage.getItem('ms-model'));
  check('pill updates to the chosen model',
    document.querySelector('#oc-status').textContent.includes(target?.label || '\u0000'),
    document.querySelector('#oc-status').textContent.trim());
  check('panel select stays in sync',
    document.querySelector('#agent-model').value === (localStorage.getItem('ms-model') || ''),
    document.querySelector('#agent-model').value);
} catch (err) { check('model palette block', false, err.message); }

// pure turn/stall logic
try {
  const a = await import('file://' + path.join(APP, 'js', 'agent.js'));
  const now = Date.now();
  const base = { active: true, done: false, isNewAssistant: false, lastCompleted: false, stallMs: 45000, notifiedEmpty: false };

  // sent, assistant message not created yet -> waiting, never "empty"
  const waiting = a.turnDecision({ ...base, contentKey: null, lastKey: null, lastContentAt: now - 60000, now });
  check('waiting with no reply is busy, not empty', waiting.busy === true && waiting.empty === false, JSON.stringify(waiting));
  check('long wait with no reply is stalled', waiting.stalled === true);

  // assistant message in flight, no output yet -> stalled once past the window
  const stalled = a.turnDecision({ ...base, isNewAssistant: true, contentKey: null, lastKey: null, lastContentAt: now - 50000, now });
  check('in-flight with no output is stalled', stalled.stalled === true && stalled.done === false);

  // output arrived -> progress resets the timer
  const fresh = a.turnDecision({ ...base, isNewAssistant: true, contentKey: '9:0:0:', lastKey: null, lastContentAt: now - 50000, now, visible: true, running: false });
  check('new output resets the stall timer', fresh.stalled === false && fresh.progressed === true && fresh.lastContentAt === now);

  // completed reply with content -> done, not empty
  const finished = a.turnDecision({ ...base, isNewAssistant: true, lastCompleted: true, contentKey: '9:0:0:', lastKey: '9:0:0:', lastContentAt: now - 5000, now, visible: true, running: false });
  check('completed reply ends the turn and is not empty',
    finished.done === true && finished.busy === false && finished.empty === false);

  // completed reply with no content -> empty
  const empty = a.turnDecision({ ...base, isNewAssistant: true, lastCompleted: true, contentKey: null, lastKey: null, lastContentAt: now, now, visible: false, running: false });
  check('completed-with-no-output is reported empty', empty.empty === true && empty.done === true);
  const once = a.turnDecision({ ...base, isNewAssistant: true, lastCompleted: true, contentKey: null, lastKey: null, lastContentAt: now, now, notifiedEmpty: true, visible: false, running: false });
  check('empty is only reported once', once.empty === false);

  // a tool in flight is a wait, not a hang. This is exactly what the agent's
  // own `question` tool looks like while it waits for the user to answer.
  const waitingOnTool = a.turnDecision({
    ...base, isNewAssistant: true,
    contentKey: '0:0:1:question:running:0', lastKey: '0:0:1:question:running:0',
    lastContentAt: now - 120000, now, visible: true, running: true,
  });
  check('a running tool is a wait, not a stall',
    waitingOnTool.stalled === false && waitingOnTool.busy === true, JSON.stringify(waitingOnTool));

  // streamed reasoning is progress the reader cannot see yet: it has to hold the
  // stall timer without counting as visible output
  check('reasoning counts as progress',
    a.contentKey({ content: [{ type: 'reasoning', text: 'hmm' }] }) === '0:3:0:',
    a.contentKey({ content: [{ type: 'reasoning', text: 'hmm' }] }));
  check('tool status and output count as progress',
    a.contentKey({ content: [{ type: 'tool', name: 'read', state: { status: 'running', output: 'ab' } }] })
      === '0:0:1:read:running:2');
  check('contentKey ignores empty messages', a.contentKey({ content: [{ type: 'reasoning', text: '' }] }) === null);
  check('contentKey detects text', a.contentKey({ content: [{ type: 'text', text: 'hi' }] }) === '2:0:0:',
    a.contentKey({ content: [{ type: 'text', text: 'hi' }] }));

  check('visible output ignores reasoning',
    a.hasVisibleOutput({ content: [{ type: 'reasoning', text: 'x' }] }) === false
      && a.hasVisibleOutput({ content: [{ type: 'text', text: 'x' }] }) === true
      && a.hasVisibleOutput({ content: [{ type: 'tool', name: 'read' }] }) === true);
  check('a reasoning-only completion is still "no output"',
    a.turnDecision({ ...base, isNewAssistant: true, lastCompleted: true, contentKey: '0:20:0:', lastKey: null, lastContentAt: now, now, visible: false, running: false }).empty === true);
  check('hasRunningTool spots an in-flight tool',
    a.hasRunningTool({ content: [{ type: 'tool', name: 'read', state: { status: 'running' } }] }) === true
      && a.hasRunningTool({ content: [{ type: 'tool', name: 'read', state: { status: 'completed' } }] }) === false);

  // the header buildPrompt writes is the one the transcript parser recognises,
  // including the "untitled" / "none" fallbacks
  for (const [kind, p, expected] of [
    ['diagram', 'a.mmd', 'a.mmd'],
    ['ledger', 'a.gaps.md', 'a.gaps.md'],
    ['diagram', '', 'untitled'],
    ['ledger', '', 'none'],
  ]) {
    const header = a.attachmentHeader(kind, p);
    const parsed = a.parseAttachmentHeader(header);
    check(`attachment header round-trips (${kind}, ${p || 'default'})`,
      Boolean(parsed) && parsed.kind === kind && parsed.label === expected,
      `${header} -> ${JSON.stringify(parsed)}`);
  }
  check('a normal line is not an attachment header', a.parseAttachmentHeader('hello') === null);

  const split = a.splitPrompt('Why this shape?\n\n'
    + a.attachmentHeader('diagram', 'a.mmd') + '\n\n```mermaid\nflowchart LR\n    UI --> API\n```\n\n'
    + a.attachmentHeader('ledger', 'a.gaps.md') + '\n\n```markdown\n- [ ] q\n```');
  check('splitPrompt separates the question from the attachments',
    split.question === 'Why this shape?' && split.attachments.length === 2,
    JSON.stringify(split.attachments.map((x) => x.label)));
  check('splitPrompt unfences each attachment body',
    split.attachments[0].source === 'flowchart LR\n    UI --> API'
      && split.attachments[1].source === '- [ ] q',
    JSON.stringify(split.attachments.map((x) => x.source)));
  const plain = a.splitPrompt('just words');
  check('splitPrompt leaves a message without attachments alone',
    plain.question === 'just words' && plain.attachments.length === 0);
} catch (err) { check('turn logic block', false, err.message); }

// stall notice + empty-response rendering
try {
  studio.handleNotice({ type: 'stalled', model: 'deepseek/deepseek-flash', elapsed: 50 });
  const box = document.querySelector('#agent-notice');
  check('stalled notice shows with Retry and Stop',
    box.hidden === false && /No output/.test(box.textContent) && !document.querySelector('#agent-retry').hidden
      && !document.querySelector('#agent-notice-stop').hidden,
    box.textContent.trim().slice(0, 60));
  studio.handleNotice(null);
  check('notice clears', box.hidden === true);
  studio.renderChat([{ id: 'msg_e', type: 'assistant', time: { created: 1, completed: 2 }, content: [{ type: 'reasoning', text: '' }] }]);
  check('completed empty reply offers Retry in the log',
    !!document.querySelector('#chat-log .retry-inline') && /no output/i.test(document.querySelector('#chat-log').textContent));
} catch (err) { check('notice block', false, err.message); }

// agent session (reuses one per workspace)
await new Promise((r) => setTimeout(r, 1500));
const firstSession = studio?.agent?.sessionId || '';
check('agent session created', /^ses_/.test(firstSession), firstSession || 'none');
try {
  await studio.agent.connect(state.config, state.workspace, state.config.defaultModel);
  check('reconnecting reuses the same session', studio.agent.sessionId === firstSession,
    `${firstSession} -> ${studio.agent.sessionId}`);
} catch (err) { check('session reuse', false, err.message); }

// a stale agent list must not produce a false "not installed"
try {
  state.config.oc.agents = [];   // simulate config fetched while OpenCode was down
  await studio.agent.connect(state.config, state.workspace, null);
  const sub = document.querySelector('#agent-sub').textContent;
  check('stale empty agent list still reports ready', /ready/.test(sub), sub);
  check('the agent list is repaired from the service',
    (state.config.oc.agents || []).some((a) => a.id === 'graph-engineer'),
    `${(state.config.oc.agents || []).length} agents`);
} catch (err) { check('stale agent list block', false, err.message); }

// a genuinely missing agent must be named, not blamed on the model stalling
try {
  fakeNoAgent = true;
  state.config.oc.agents = [];        // forces connect() to re-fetch and learn the truth
  await studio.agent.connect(state.config, state.workspace, null);
  const sub = document.querySelector('#agent-sub').textContent;
  check('status says not installed when the list really lacks it',
    /not installed/.test(sub), sub);

  await studio.agent.send('hello', {});
  const box = document.querySelector('#agent-notice');
  check('a blocked send explains the missing agent',
    box.hidden === false && /isn't installed/.test(box.textContent),
    box.textContent.trim().slice(0, 70));
  check('a missing agent is not reported as a stall',
    !/No output/.test(box.textContent), box.textContent.trim().slice(0, 70));
  check('a blocked send leaves the UI idle', studio.agent.busy === false);
  check('notice offers Retry but not Stop',
    document.querySelector('#agent-retry').hidden === false
      && document.querySelector('#agent-notice-stop').hidden === true);

  // the cached verdict is dropped on block, so a retry re-checks (here: still absent)
  await studio.agent.send('hello again', {});
  check('retry re-checks rather than trusting the cache',
    document.querySelector('#agent-notice').hidden === false
      && /isn't installed/.test(document.querySelector('#agent-notice').textContent));

  fakeNoAgent = false;
  await studio.agent.connect(state.config, state.workspace, null);
  check('recovers to ready once the agent is back',
    /ready/.test(document.querySelector('#agent-sub').textContent),
    document.querySelector('#agent-sub').textContent);
} catch (err) { check('missing agent block', false, err.message); }

// "New session" must force a genuinely new conversation, not reattach.
try {
  const prior = studio.agent.sessionId;
  document.querySelector('#btn-agent-new').click();
  let fresh = '';
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    if (studio.agent.sessionId && studio.agent.sessionId !== prior) { fresh = studio.agent.sessionId; break; }
  }
  check('New session button starts a different session', Boolean(fresh) && fresh !== prior,
    `${prior} -> ${fresh || 'unchanged'}`);
  if (fresh) {
    const info = (await studio.oc.call(`/api/session/${fresh}`)).data;
    check('new session is titled after the open diagram',
      /^Graph Engineering — /.test(info.title || ''), info.title);
    check('new session keeps the selected model',
      info.model?.providerID === 'deepseek' && info.model?.id === 'deepseek-flash',
      JSON.stringify(info.model));
  }
  // and a subsequent plain connect() reuses the new one
  await studio.agent.connect(state.config, state.workspace, state.config.defaultModel);
  check('reconnect after New session reuses it', studio.agent.sessionId === fresh, studio.agent.sessionId);
} catch (err) { check('new session button', false, err.message); }

// render chat with a synthetic assistant message
try {
  studio.state.pendingBlocks.clear();
  check('chat log reachable', !!document.querySelector('#chat-log'));
} catch (err) { check('chat log reachable', false, err.message); }

check('no runtime errors', errors.length === 0, errors.slice(0, 3).join(' | '));

// workspace picker: browse, create a folder, cancel
try {
  const FOLDER_NAME = `__modal-test-${Date.now()}`;
  const startWorkspace = state.workspace;
  studio.openWorkspaceModal();
  await new Promise((r) => setTimeout(r, 700));
  const modal = document.querySelector('.modal-lg');
  check('workspace picker opens', !!modal);
  check('picker opens at the current workspace',
    modal.querySelector('#dir-path').value === startWorkspace,
    modal.querySelector('#dir-path').value);
  // the smoke workspace has no sub-folders, so it should say so rather than look broken
  check('empty folder shows a helpful message',
    modal.querySelectorAll('#dir-list .dir-item').length === 0
      && /No sub-folders/.test(modal.querySelector('#dir-list').textContent),
    modal.querySelector('#dir-list').textContent.trim().slice(0, 40));
  check('picker offers the system dialog when available',
    modal.querySelector('#dir-native').hidden === !state.config?.nativePicker,
    `nativePicker=${state.config?.nativePicker}`);

  const pathInput = modal.querySelector('#dir-path');
  pathInput.value = BROWSE_DIR;
  modal.querySelector('#dir-go').click();
  await new Promise((r) => setTimeout(r, 700));
  check('picker navigates to a typed path',
    modal.querySelector('#dir-path').value === BROWSE_DIR,
    modal.querySelector('#dir-path').value);
  check('picker lists folders in a populated directory',
    modal.querySelectorAll('#dir-list .dir-item').length > 0,
    `${modal.querySelectorAll('#dir-list .dir-item').length} folders`);
  check('picker enables Up when a parent exists', modal.querySelector('#dir-up').disabled === false);

  // create a folder from inside the picker
  modal.querySelector('#dir-new').click();
  await new Promise((r) => setTimeout(r, 150));
  const backdrops = document.querySelectorAll('.modal-backdrop');
  const prompt = backdrops[backdrops.length - 1];
  prompt.querySelector('#modal-input').value = FOLDER_NAME;
  prompt.querySelector('.confirm').click();
  await new Promise((r) => setTimeout(r, 900));
  const listing = await studio.bridge.dirs(BROWSE_DIR);
  check('New folder creates the directory',
    listing.dirs.some((d) => d.name === FOLDER_NAME),
    listing.dirs.map((d) => d.name).slice(0, 6).join(','));
  check('picker descends into the new folder',
    modal.querySelector('#dir-path').value === `${BROWSE_DIR}/${FOLDER_NAME}`,
    modal.querySelector('#dir-path').value);

  // choosing the same workspace should apply cleanly
  modal.querySelector('#dir-cancel').click();
  check('cancel closes the picker', !document.querySelector('.modal-lg'));

  studio.openWorkspaceModal();
  await new Promise((r) => setTimeout(r, 700));
  document.querySelector('.modal-lg').querySelector('#dir-use').click();
  await new Promise((r) => setTimeout(r, 900));
  check('Use this folder closes the picker', !document.querySelector('.modal-lg'));
  check('Use this folder keeps the workspace', state.workspace === startWorkspace, state.workspace);
} catch (err) { check('workspace picker block', false, err.message); }

console.log('DIAG',
  'active=', state?.active,
  'tabs=', (state?.tabs || []).map((t) => `${t.name}:${(t.content || '').length}`).join(','),
  'outline=', document.querySelectorAll('#outline-list .outline-item').length,
  'outlineHtml=', document.querySelector('#outline-list').innerHTML.length,
  'editorVal=', studio.editor?.cm?.getValue().length,
);

let failed = 0;
for (const [status, name, extra] of results) {
  if (status === 'FAIL') failed += 1;
  console.log(`${status}  ${name}${extra ? `  [${extra}]` : ''}`);
}
if (errors.length) {
  console.log('\n--- captured errors ---');
  for (const e of errors.slice(0, 10)) console.log(e);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
