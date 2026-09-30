// Optimize fit: transposes a flowchart only when its axis disagrees with the
// pane and it wastes more than 45% of the pane. The lamp state (enabled /
// qualifies / idle) is asserted alongside. Pane sizes are stubbed because jsdom
// does no layout.
import { JSDOM } from 'jsdom';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div><div id="target"></div></body></html>',
  { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
const define = (k, v) => {
  try { globalThis[k] = v; } catch { Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); }
};
define('window', window); define('document', window.document); define('navigator', window.navigator);
for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'getComputedStyle', 'SVGElement', 'DOMParser', 'XMLSerializer', 'CSS', 'Blob', 'URL'])
  if (window[k]) define(k, window[k]);

// a wide svg for horizontal flowcharts, a tall one for vertical
window.mermaid = {
  initialize() {},
  parse: async () => true,
  render: async (_id, src) => {
    const dir = (/(?:flowchart|graph)\s+(TD|TB|BT|RL|LR)/i.exec(src)?.[1] || '').toUpperCase();
    const horizontal = dir === 'LR' || dir === 'RL';
    return { svg: horizontal
      ? '<svg viewBox="0 0 800 100"><g class="node" data-id="A"></g></svg>'
      : '<svg viewBox="0 0 100 800"><g class="node" data-id="A"></g></svg>' };
  },
};

const stage = window.document.getElementById('stage');
let pane = { w: 400, h: 800 };
Object.defineProperty(stage, 'clientWidth', { get: () => pane.w });
Object.defineProperty(stage, 'clientHeight', { get: () => pane.h });

const viewer = await import(`file://${APP}/js/viewer.js`);
viewer.initViewer({ stageEl: stage, targetEl: window.document.getElementById('target'), emptyEl: window.document.createElement('div') });

const results = [];
const check = (name, cond, extra = '') => results.push([cond ? 'PASS' : 'FAIL', name, extra]);
const LR = 'flowchart LR\n    A --> B\n';
const TD = 'flowchart TD\n    A --> B\n';

// portrait pane: a wide graph wastes it, a tall one fits
pane = { w: 400, h: 800 };
viewer.setOptimizeFit(true);
await viewer.render(LR);
check('portrait pane + LR graph -> transposed', viewer.isTransposed() === true,
  `rendered: ${viewer.getRenderedSource().split('\n')[0]}`);
check('enabled -> lamp on and qualifying',
  viewer.getFitState().enabled === true && viewer.getFitState().qualifies === true);
check('transposed render is the flipped source',
  viewer.getRenderedSource().startsWith('flowchart TD'), viewer.getRenderedSource().split('\n')[0]);
await viewer.render(TD);
check('portrait pane + TD graph -> left alone', viewer.isTransposed() === false,
  viewer.getRenderedSource().split('\n')[0]);

// landscape pane: the mirror image
pane = { w: 900, h: 300 };
await viewer.render(TD);
check('landscape pane + TD graph -> transposed', viewer.isTransposed() === true,
  `rendered: ${viewer.getRenderedSource().split('\n')[0]}`);
await viewer.render(LR);
check('landscape pane + LR graph -> left alone', viewer.isTransposed() === false,
  viewer.getRenderedSource().split('\n')[0]);

// a roughly square pane must not flip anything (no oscillation)
pane = { w: 700, h: 600 };
await viewer.render(LR);
check('square-ish pane + LR graph -> left alone', viewer.isTransposed() === false,
  viewer.getRenderedSource().split('\n')[0]);

// disabled -> never transposes, but the lamp still reports the opportunity
viewer.setOptimizeFit(false);
pane = { w: 400, h: 800 };
await viewer.render(LR);
const offLR = viewer.getFitState();
check('optimize fit off -> never transposed', viewer.isTransposed() === false);
check('optimize fit off -> authored source kept', viewer.getRenderedSource().startsWith('flowchart LR'));
check('off + LR in a portrait pane -> qualifies (lamp available)',
  offLR.enabled === false && offLR.qualifies === true, JSON.stringify(offLR));
await viewer.render(TD);
const offTD = viewer.getFitState();
check('off + TD in a portrait pane -> idle (nothing to do)',
  offTD.enabled === false && offTD.qualifies === false, JSON.stringify(offTD));

// non-flowcharts are never touched
viewer.setOptimizeFit(true);
const seq = 'sequenceDiagram\n    A->>B: hi\n';
await viewer.render(seq);
check('sequence diagram -> never transposed', viewer.isTransposed() === false);
check('sequence diagram -> source unchanged', viewer.getRenderedSource() === seq.trim());
check('sequence diagram -> idle (nothing to do)', viewer.getFitState().qualifies === false);

let failed = 0;
for (const [status, name, extra] of results) {
  if (status === 'FAIL') failed += 1;
  console.log(`${status}  ${name}${extra ? `  [${extra}]` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
