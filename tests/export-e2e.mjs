// Validate viewer.buildExportSvg() against real Mermaid output: the markup it
// produces must be <img>-rasterisable (no foreignObject) and keep every label.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import vm from 'node:vm';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true, url: 'http://localhost/', runScripts: 'outside-only',
});
const { window } = dom;
const define = (k, v) => { try { globalThis[k] = v; } catch { Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); } };
define('window', window); define('document', window.document); define('navigator', window.navigator); define('self', window);
for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'SVGElement', 'DOMParser', 'XMLSerializer', 'CSS', 'Image', 'Blob', 'URL']) {
  if (window[k]) define(k, window[k]);
}
const box = (el) => ({ x: 0, y: 0, width: Math.max(20, (el.textContent || 'x').trim().length * 8), height: 18, top: 0, left: 0, right: 0, bottom: 0 });
if (window.SVGElement) {
  window.SVGElement.prototype.getBBox = function () { return box(this); };
  window.SVGElement.prototype.getComputedTextLength = function () { return box(this).width; };
}

// Load the vendored bundle the way a browser does: as a script in the global
// scope, not as strict-mode eval (which would keep its top-level `var` local).
vm.runInContext(fs.readFileSync(`${APP}/vendor/mermaid.min.js`, 'utf8'), dom.getInternalVMContext());
if (!window.mermaid) throw new Error('vendored mermaid did not expose window.mermaid');
console.log('vendored mermaid loaded, version:', window.mermaid.version);

const { initialize, render } = window.mermaid;

// import the production module (same URL the app uses)
const viewer = await import(`file://${APP}/js/viewer.js?v=${Date.now()}`);
viewer.initViewer({ stageEl: window.document.body, targetEl: window.document.body, emptyEl: window.document.createElement('div') });

const results = [];
const check = (n, c, e = '') => results.push([c ? 'PASS' : 'FAIL', n, e]);

const cases = {
  'flowchart.mmd': fs.readFileSync(path.join(ROOT, 'graphs', '01-example-flow.mmd'), 'utf8'),
  state: 'stateDiagram-v2\n    [*] --> Draft\n    Draft --> Review: submit\n    Review --> Published: approve\n',
  sequence: 'sequenceDiagram\n    participant U as User\n    participant A as API\n    U->>A: POST /graphs\n    A-->>U: 201 Created\n',
};

for (const [name, source] of Object.entries(cases)) {
  try {
    const { markup, width, height } = await viewer.buildExportSvg(source);
    const doc = new window.DOMParser().parseFromString(markup, 'image/svg+xml');
    const parseError = doc.querySelector('parsererror');
    const foreign = markup.includes('foreignObject');
    const texts = [...doc.querySelectorAll('text')].map((t) => t.textContent.trim()).filter(Boolean);
    const hasSize = /<svg[^>]*\swidth="\d/.test(markup) && /<svg[^>]*\sheight="\d/.test(markup);
    const external = /href="https?:|@import|url\(http/.test(markup);

    check(`${name}: rasterisable (no foreignObject)`, !foreign);
    check(`${name}: well-formed XML`, !parseError, parseError ? parseError.textContent.slice(0, 80) : '');
    check(`${name}: keeps labels as text`, texts.length > 0, `${texts.length} labels: ${texts.slice(0, 3).join(' | ')}`);
    check(`${name}: has intrinsic size`, hasSize, `${Math.round(width)}x${Math.round(height)}`);
    check(`${name}: no external refs (would taint canvas)`, !external);
  } catch (err) {
    check(`${name}: buildExportSvg`, false, err.message);
  }
}

// the preview config must be restored afterwards (htmlLabels back to default)
let after;
try {
  after = await render(`verify-${Date.now()}`, cases['flowchart.mmd']);
} catch (err) {
  check('re-render after export', false, err.message);
}
if (after) check('preview config restored (html labels again)', after.svg.includes('foreignObject'));

let failed = 0;
for (const [s, n, e] of results) { if (s === 'FAIL') failed += 1; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
