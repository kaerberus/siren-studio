// viewer.js — Mermaid rendering, viewBox-based pan/zoom, highlighting, export.
//
// Mermaid emits `<svg width="100%" style="max-width: Npx" viewBox="x y w h">`
// with no height attribute. Instead of sizing the element and CSS-transforming
// it (which mis-measures and rasterises), we let the SVG fill the stage and
// drive `viewBox` directly. That keeps everything vector-crisp and makes
// "fit" nothing more than restoring the content's own viewBox.

const mermaid = window.mermaid;

const MIN_SCALE = 0.25; // zoomed out to a quarter of "fit"
const MAX_SCALE = 24;   // zoomed in 24x
const FIT_PAD = 0.05;   // 5% breathing room around the content
// Optimize fit transposes a flowchart when it would otherwise use less than
// this fraction of the pane on its non-binding axis.
const FIT_THRESHOLD = 0.45;
const VERTICAL_DIRECTIONS = new Set(['TD', 'TB', 'BT']);
const HORIZONTAL_DIRECTIONS = new Set(['LR', 'RL']);

let stage = null;
let target = null;
let emptyState = null;
let themeMode = 'dark';
let optimizeFit = false;
// What we actually rendered (may be transposed) and whether we flipped it.
let renderedSource = '';
let transposed = false;
// Whether the authored diagram would transpose if the toggle were on. Computed
// every render, so the indicator can show the opportunity while the feature is off.
let qualifies = false;
// Decision memo: transposition depends on the authored direction and the pane
// shape, neither of which changes as you type, so avoid the trial render.
let decisionKey = '';
let decisionValue = false;

// base: the content's own viewBox. view: what we currently show.
let base = { x: 0, y: 0, w: 1, h: 1 };
let view = { x: 0, y: 0, w: 1, h: 1 };
// Once the user zooms or pans we stop auto-fitting on re-render and preserve
// their viewport instead.
let userAdjusted = false;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

export function initViewer({ stageEl, targetEl, emptyEl }) {
  stage = stageEl;
  target = targetEl;
  emptyState = emptyEl;
  mermaid.initialize(config());
  bindInteraction();
}

function config() {
  return {
    startOnLoad: false,
    securityLevel: 'loose',
    theme: themeMode === 'light' ? 'default' : 'dark',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    flowchart: { useMaxWidth: false },
  };
}

export function setTheme(mode) {
  themeMode = mode;
  mermaid.initialize(config());
}

export function setEmptyVisible(visible) {
  if (emptyState) emptyState.hidden = !visible;
  if (target) target.classList.toggle('hidden', visible);
}

// ── viewBox helpers ────────────────────────────────────────────────────────
function svgEl() {
  return target ? target.querySelector('svg') : null;
}

function readBaseViewBox(el) {
  const raw = el.getAttribute('viewBox');
  if (raw) {
    const parts = raw.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
    }
  }
  if (typeof el.getBBox === 'function') {
    try {
      const box = el.getBBox();
      if (box && box.width > 0 && box.height > 0) {
        return { x: box.x, y: box.y, w: box.width, h: box.height };
      }
    } catch (_) { /* not rendered yet */ }
  }
  return { x: 0, y: 0, w: 1, h: 1 };
}

function expand(rect, pad) {
  const dx = rect.w * pad;
  const dy = rect.h * pad;
  return { x: rect.x - dx, y: rect.y - dy, w: rect.w + dx * 2, h: rect.h + dy * 2 };
}

function applyViewBox() {
  const el = svgEl();
  if (!el) return;
  el.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
}

/** Map a client (screen) point into current user/viewBox units. */
function screenToUser(el, clientX, clientY) {
  const ctm = el.getScreenCTM?.();
  if (ctm && typeof el.createSVGPoint === 'function') {
    const point = el.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const mapped = point.matrixTransform(ctm.inverse());
    return { x: mapped.x, y: mapped.y };
  }
  if (ctm && typeof DOMPoint === 'function') {
    return new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  }
  // Fallback (no layout, e.g. headless): treat the point as the view centre.
  return { x: view.x + view.w / 2, y: view.y + view.h / 2 };
}

// ── optimize fit: transpose a flowchart to use the pane better ─────────────

/** The diagram keyword and direction of a flowchart, or null for anything else. */
export function diagramDirection(source) {
  const lines = (source || '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].trim();
    if (!text || text.startsWith('%%')) continue;
    const match = text.match(/^(flowchart|graph)\s+(TD|TB|BT|RL|LR)\b/i);
    if (!match) return null;
    return {
      keyword: match[1],
      direction: match[2].toUpperCase(),
      index,
      line: lines[index],
    };
  }
  return null;
}

/** The same flowchart with its axis flipped, or null if it is not a flowchart. */
export function transposeSource(source) {
  const info = diagramDirection(source);
  if (!info) return null;
  const target_ = VERTICAL_DIRECTIONS.has(info.direction) ? 'LR' : 'TD';
  const lines = (source || '').split('\n');
  lines[info.index] = info.line.replace(
    new RegExp(`(\\b${info.keyword}\\s+)${info.direction}\\b`, 'i'),
    `$1${target_}`,
  );
  return lines.join('\n');
}

/** How much of the pane the fitted graph would use on each axis (0..1). */
function paneUsage(rect) {
  if (!stage) return null;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (!sw || !sh) return null;
  const scale = Math.min(sw / rect.w, sh / rect.h);
  return { x: (rect.w * scale) / sw, y: (rect.h * scale) / sh, sw, sh };
}

/**
 * Would this source transpose if the feature were on? Always judged from the
 * AUTHORED geometry, so the answer cannot oscillate. Independent of the toggle,
 * so the indicator can report an opportunity while the feature is off.
 */
function fitWouldTranspose(source, authoredRect) {
  const info = diagramDirection(source);
  if (!info) return false; // flowcharts only
  const usage = paneUsage(expand(authoredRect, FIT_PAD));
  if (!usage) return false;
  const key = `${info.direction}|${usage.sw}x${usage.sh}|${Math.round(authoredRect.w)}x${Math.round(authoredRect.h)}`;
  if (key === decisionKey) return decisionValue;
  const wastes = Math.min(usage.x, usage.y) < FIT_THRESHOLD;
  const portraitPane = usage.sh > usage.sw;
  // Only flip when the graph's axis disagrees with the pane's shape.
  const disagrees = HORIZONTAL_DIRECTIONS.has(info.direction) ? portraitPane
    : VERTICAL_DIRECTIONS.has(info.direction) ? !portraitPane : false;
  decisionKey = key;
  decisionValue = wastes && disagrees;
  return decisionValue;
}

export function setOptimizeFit(on) {
  const next = Boolean(on);
  if (next === optimizeFit) return;
  optimizeFit = next;
  decisionKey = ''; // force a fresh measurement
}

export function isTransposed() {
  return transposed;
}

/** The toggle state, whether the current diagram qualifies, and whether it flipped. */
export function getFitState() {
  return { enabled: optimizeFit, qualifies, transposed };
}

/** The source as currently rendered — transposed if optimize fit flipped it. */
export function getRenderedSource() {
  return renderedSource;
}

// ── render ─────────────────────────────────────────────────────────────────
let renderSeq = 0;

function prepareSvg(el) {
  // Let the SVG fill the stage; viewBox does the fitting.
  el.removeAttribute('width');
  el.removeAttribute('height');
  el.style.maxWidth = 'none';
  el.style.width = '100%';
  el.style.height = '100%';
  el.style.background = 'transparent';
  el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
}

/** Render mermaid source. Returns {ok, error?, empty?, transposed?}. */
export async function render(text) {
  const seq = ++renderSeq;
  const source = (text || '').trim();
  if (!source) {
    setEmptyVisible(true);
    target.innerHTML = '';
    renderedSource = '';
    transposed = false;
    qualifies = false;
    return { ok: true, empty: true };
  }
  const stamp = Date.now();
  const ids = [`mmd-${seq}-${stamp}`, `mmd-${seq}-${stamp}x`];
  try {
    // Always draw the authored diagram first: the transposition decision is made
    // from its geometry, which keeps the result stable.
    const first = await mermaid.render(ids[0], source);
    if (seq !== renderSeq) return { ok: true, stale: true };
    target.innerHTML = first.svg;
    const el = svgEl();
    if (!el) return { ok: true };
    prepareSvg(el);
    let authored = readBaseViewBox(el);
    let shown = source;

    qualifies = fitWouldTranspose(source, authored);
    if (optimizeFit && qualifies) {
      const flipped = transposeSource(source);
      if (flipped) {
        const second = await mermaid.render(ids[1], flipped);
        if (seq !== renderSeq) return { ok: true, stale: true };
        target.innerHTML = second.svg;
        const el2 = svgEl();
        if (el2) {
          prepareSvg(el2);
          authored = readBaseViewBox(el2);
          shown = flipped;
        }
      }
    }

    setEmptyVisible(false);
    renderedSource = shown;
    transposed = shown !== source;
    const previous = base;
    base = authored;
    if (userAdjusted && previous.w > 0) preserveView(previous);
    else fit();
    return { ok: true, transposed };
  } catch (err) {
    for (const id of ids) cleanupStray(id);
    if (seq !== renderSeq) return { ok: true, stale: true };
    return { ok: false, error: err };
  }
}

function cleanupStray(id) {
  if (typeof CSS === 'undefined' || typeof CSS.escape !== 'function') return;
  for (const sel of [`#${CSS.escape(id)}`, `#d${CSS.escape(id)}`]) {
    const el = document.querySelector(sel);
    if (el && el.parentElement === document.body) el.remove();
  }
}

/**
 * Parse only, no rendering. Used to answer validation requests from the
 * OpenCode plugin so the agent can check Mermaid with the real parser.
 * @returns {Promise<{ok:boolean, errors:Array<{line:number,message:string}>}>}
 */
export async function parseSource(source) {
  const text = (source || '').trim();
  if (!text) return { ok: false, errors: [{ line: 1, message: 'diagram is empty' }] };
  try {
    await mermaid.parse(text);
    return { ok: true, errors: [] };
  } catch (err) {
    const annotation = errorAnnotation(err);
    return {
      ok: false,
      errors: [{ line: annotation.from.line + 1, message: annotation.message }],
    };
  }
}

/** Mermaid parse used by the editor linter. */
export async function lintMermaid(text) {
  if (!text || !text.trim()) return [];
  try {
    await mermaid.parse(text);
    return [];
  } catch (err) {
    return [errorAnnotation(err)];
  }
}

function errorAnnotation(err) {
  const message = err?.str || err?.message || String(err);
  let line = 0;
  let ch = 0;
  const loc = err?.hash?.loc;
  if (loc) {
    if (typeof loc.first_line === 'number') line = Math.max(0, loc.first_line - 1);
    if (typeof loc.first_column === 'number') ch = Math.max(0, loc.first_column);
  }
  const token = err?.hash?.token;
  const text = token ? `${message} (near "${token}")` : message;
  return {
    from: window.CodeMirror.Pos(line, ch),
    to: window.CodeMirror.Pos(line, ch + 1),
    message: text,
    severity: 'error',
  };
}

// ── fit / zoom / pan ───────────────────────────────────────────────────────
/** Centre and fit the whole graph. No-op safe when nothing is rendered. */
export function fit() {
  view = expand(base, FIT_PAD);
  userAdjusted = false;
  applyViewBox();
}

/** Forget the user's pan/zoom so the next render auto-fits (used on tab switch). */
export function resetView() {
  userAdjusted = false;
}

/** Keep the current relative zoom/centre across a re-render. */
function preserveView(previous) {
  if (view.w <= 0 || previous.w <= 0) { fit(); return; }
  const scale = previous.w / view.w;
  const cx = (view.x + view.w / 2 - previous.x) / previous.w;
  const cy = (view.y + view.h / 2 - previous.y) / previous.h;
  view.w = base.w / scale;
  view.h = base.h / scale;
  view.x = base.x + cx * base.w - view.w / 2;
  view.y = base.y + cy * base.h - view.h / 2;
  applyViewBox();
}

function currentScale() {
  return view.w > 0 ? base.w / view.w : 1;
}

/** Zoom by `factor` about a client point (defaults to the stage centre). */
function zoomAt(factor, clientX, clientY) {
  const el = svgEl();
  if (!el || !stage) return;
  let px = clientX;
  let py = clientY;
  if (px == null || py == null) {
    const rect = stage.getBoundingClientRect();
    px = rect.left + rect.width / 2;
    py = rect.top + rect.height / 2;
  }
  const scale = currentScale();
  const next = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
  if (Math.abs(next - scale) < 1e-6) return;
  const k = scale / next; // viewBox shrink/stretch factor

  const anchor = screenToUser(el, px, py);
  view.x = anchor.x - (anchor.x - view.x) * k;
  view.y = anchor.y - (anchor.y - view.y) * k;
  view.w *= k;
  view.h *= k;
  userAdjusted = true;
  applyViewBox();
}

export function zoom(factor) {
  zoomAt(factor);
}

/** Centre on a node without changing the zoom level. */
export function focusNode(id) {
  const node = findNodeElement(id);
  if (!node || typeof node.getBBox !== 'function') return false;
  let box;
  try { box = node.getBBox(); } catch (_) { return false; }
  if (!box || box.width <= 0) return false;
  view.x = box.x + box.width / 2 - view.w / 2;
  view.y = box.y + box.height / 2 - view.h / 2;
  userAdjusted = true;
  applyViewBox();
  return true;
}

export function getViewport() {
  return {
    base: { ...base },
    view: { ...view },
    scale: currentScale(),
    userAdjusted,
  };
}

// Movement (px) before a press turns into a pan. Below it the press stays a
// click, which is why the pointer is *not* captured on pointerdown: pointer
// capture retargets the follow-up `click` to the capturing element, so a node
// under the cursor would never see the click it is meant to handle.
const DRAG_SLOP = 3;

function bindInteraction() {
  if (!stage) return;
  let dragging = false;
  let pressed = null;        // where the current press started, until it moves
  let startView = null;
  let startLoc = null;
  let inverseCTM = null;

  stage.addEventListener('wheel', (event) => {
    if (!svgEl()) return;
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
  }, { passive: false });

  stage.addEventListener('pointerdown', (event) => {
    const el = svgEl();
    if (event.button !== 0 || !el) return;
    const ctm = el.getScreenCTM?.();
    inverseCTM = ctm ? ctm.inverse() : null;
    pressed = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      loc: screenToUser(el, event.clientX, event.clientY),
    };
  });

  stage.addEventListener('pointermove', (event) => {
    if (!pressed) return;
    // Released somewhere we never heard about (outside the stage, typically).
    if (!(event.buttons & 1)) { pressed = null; return; }
    const el = svgEl();
    if (!dragging) {
      if (!el) return;
      if (Math.abs(event.clientX - pressed.clientX) < DRAG_SLOP
        && Math.abs(event.clientY - pressed.clientY) < DRAG_SLOP) return;
      // Past the slop this is a pan, not a click. Capture now so the drag keeps
      // working once the pointer leaves the stage - and, as a bonus, so the
      // trailing click lands on the stage and is ignored.
      dragging = true;
      startView = { ...view };
      startLoc = pressed.loc;
      stage.classList.add('grabbing');
      try { stage.setPointerCapture(pressed.pointerId); } catch (_) { /* ignore */ }
    }
    let loc;
    if (inverseCTM && el && typeof el.createSVGPoint === 'function') {
      const point = el.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const mapped = point.matrixTransform(inverseCTM);
      loc = { x: mapped.x, y: mapped.y };
    } else {
      loc = screenToUser(el, event.clientX, event.clientY);
    }
    view.x = startView.x - (loc.x - startLoc.x);
    view.y = startView.y - (loc.y - startLoc.y);
    userAdjusted = true;
    applyViewBox();
  });

  const end = (event) => {
    pressed = null;
    if (!dragging) return;
    dragging = false;
    startView = null;
    inverseCTM = null;
    stage.classList.remove('grabbing');
    try { stage.releasePointerCapture(event.pointerId); } catch (_) { /* ignore */ }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

// ── node highlighting ──────────────────────────────────────────────────────
function nodeIdOf(el) {
  if (el.dataset && el.dataset.id) return el.dataset.id;
  const id = el.id || '';
  const match = id.match(/^(?:flowchart|stateDiagram|state|classDiagram|class|er|requirement|mindmap|block|architecture)-(.+?)-\d+$/);
  if (match) return match[1];
  const parts = id.split('-');
  if (parts.length > 2) { parts.shift(); parts.pop(); return parts.join('-'); }
  return id;
}

export function getNodeElements() {
  const el = svgEl();
  if (!el) return [];
  return Array.from(el.querySelectorAll('g.node, g.statediagram-state, g.classGroup'))
    .map((node) => ({ id: nodeIdOf(node), el: node }));
}

function findNodeElement(id) {
  const nodes = getNodeElements();
  const hit = nodes.find((node) => node.id === id || node.id.endsWith(`-${id}`));
  return hit ? hit.el : null;
}

export function highlightNode(id) {
  let found = false;
  for (const node of getNodeElements()) {
    const active = node.id === id || node.id.endsWith(`-${id}`);
    node.el.classList.toggle('node-highlight', active);
    if (active) found = true;
  }
  return found;
}

export function clearHighlight() {
  const el = svgEl();
  if (el) el.querySelectorAll('.node-highlight').forEach((n) => n.classList.remove('node-highlight'));
}

// ── cross-file links ───────────────────────────────────────────────────────
const SVG_NS = 'http://www.w3.org/2000/svg';
// A linked node carries a small drawn external-link mark at the end of its
// label, sized and colored to read as part of the text. The paths are authored
// in a 12-unit box and scaled to the label's font size. Paint is set inline with
// !important because Mermaid fills node shapes with !important, which would
// otherwise fill the mark's box. The 12-unit box and the fallbacks keep an
// exported SVG rendering.
const LINK_GLYPH_BOX = 12;
const LINK_GLYPH_GAP = 2;
const LINK_GLYPH_MIN = 10;
const LINK_GLYPH_MAX = 15;
const LINK_GLYPH_STYLE = 'opacity:.95';
const LINK_GLYPH_FALLBACK = 'currentColor';

/** The color the label text is actually painted in, per diagram class. */
function labelInk(el) {
  const node = el.querySelector('.nodeLabel');
  if (node) {
    const color = getComputedStyle(node).color;
    if (color) return color;
  }
  const text = el.querySelector('text');
  if (text) {
    const fill = getComputedStyle(text).fill;
    if (fill && fill !== 'none') return fill;
  }
  return getComputedStyle(el).color || LINK_GLYPH_FALLBACK;
}

/** The label's font size, so the mark can match it rather than guess. */
function labelFontSize(el) {
  const node = el.querySelector('.nodeLabel') || el.querySelector('text') || el;
  const size = parseFloat(getComputedStyle(node).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}

function removeLinkGlyph(el) {
  el.querySelectorAll('.node-link-glyph').forEach((glyph) => glyph.remove());
  unpadNode(el);
}

// Mermaid sized the node before the glyph existed, so the glyph used to spill
// over the shape's right edge (and, on a framed shape, over its inner line).
// These two keep the glyph honest: they add its advance to the shape (a
// symmetric horizontal scale about the node centre) and shift the label half of
// it, so text + glyph read as one centred unit inside the padding Mermaid
// already reserved. `unpadNode` is the exact inverse, run on every re-mark.
function unpadNode(el) {
  el.querySelectorAll(':scope > .node-link-pad').forEach((pad) => {
    while (pad.firstChild) el.insertBefore(pad.firstChild, pad);
    pad.remove();
  });
  const label = el.querySelector('g.label');
  if (label && label.dataset.baseTransform != null) {
    label.setAttribute('transform', label.dataset.baseTransform);
    delete label.dataset.baseTransform;
  }
}

function padNode(el, advance, textWidth) {
  if (!(advance > 0)) return;
  const label = el.querySelector('g.label');
  if (label) {
    if (label.dataset.baseTransform == null) {
      label.dataset.baseTransform = label.getAttribute('transform') || '';
    }
    const m = /translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)/.exec(label.dataset.baseTransform);
    // Only recentre a label Mermaid centred on the node; a left-anchored label
    // (some non-flowchart diagrams) already starts at the node's edge.
    if (m && Math.abs(parseFloat(m[1]) + textWidth / 2) < 1) {
      label.setAttribute('transform',
        `translate(${(parseFloat(m[1]) - advance / 2).toFixed(2)}, ${parseFloat(m[2])})`);
    } else {
      return;
    }
  }
  // Only plain shape children can be wrapped. When Mermaid nests the shape in a
  // link wrapper, leave the geometry alone and just recentre the label.
  const shapes = [...el.querySelectorAll('.label-container')];
  if (!shapes.length || !shapes.every((s) => s.parentElement === el)) return;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const s of shapes) {
    let b;
    try { b = s.getBBox(); } catch (_) { return; }
    minX = Math.min(minX, b.x);
    maxX = Math.max(maxX, b.x + b.width);
  }
  const width = maxX - minX;
  if (!(width > 0)) return;
  const sx = (width + advance) / width;
  const pad = document.createElementNS(SVG_NS, 'g');
  pad.setAttribute('class', 'node-link-pad');
  pad.setAttribute('transform', `scale(${sx.toFixed(6)},1)`);
  el.insertBefore(pad, shapes[0]);
  shapes.forEach((s) => pad.appendChild(s));
}

// Mermaid writes a class's stroke-dasharray as an inline `!important`, which no
// stylesheet rule can override, so the async dash is cleared here instead. A
// linked node's underline and icon already say "this opens something"; the dash
// is redundant clutter there. The original value is kept so a node that stops
// being a link gets its dash back.
function clearLinkDash(el) {
  el.querySelectorAll('.label-container').forEach((shape) => {
    const dash = shape.style.strokeDasharray;
    if (!dash) return;
    if (!shape.dataset.linkDash) shape.dataset.linkDash = dash;
    shape.style.setProperty('stroke-dasharray', 'none', 'important');
  });
}

function restoreLinkDash(el) {
  el.querySelectorAll('.label-container').forEach((shape) => {
    if (!shape.dataset.linkDash) return;
    shape.style.setProperty('stroke-dasharray', shape.dataset.linkDash, 'important');
    delete shape.dataset.linkDash;
  });
}

/**
 * A small drawn external-link mark pinned to the end of a linking node's label.
 * Mermaid only gives us the shape and its label, and the `click` directive has
 * to stay plain in the .mmd, so the mark is added here and never written back to
 * source. It sizes and colors to the label text, so it reads as part of the
 * label rather than as chrome. A label that never laid out (a hidden pane) gets
 * no mark.
 */
function attachLinkGlyph(el) {
  const label = el.querySelector('g.label');
  const host = label || el.querySelector('text') || el;
  let box;
  try { box = host.getBBox(); } catch (_) { return; }
  if (!box || !box.width) return;

  const size = Math.max(LINK_GLYPH_MIN, Math.min(LINK_GLYPH_MAX, labelFontSize(el) * 0.8));
  const ink = labelInk(el);
  const container = label || (host.tagName && host.tagName.toLowerCase() === 'text'
    ? (host.parentNode || el) : el);

  const glyph = document.createElementNS(SVG_NS, 'g');
  glyph.setAttribute('class', 'node-link-glyph');
  glyph.setAttribute('aria-hidden', 'true');
  // Inline, important: Mermaid fills node shapes with !important, which would
  // otherwise fill the icon's box grey.
  glyph.setAttribute('style',
    `${LINK_GLYPH_STYLE};fill:none !important;stroke:${ink};stroke-width:1.5;`
    + 'stroke-linecap:round;stroke-linejoin:round');

  const inner = document.createElementNS(SVG_NS, 'g');
  inner.setAttribute('transform', `scale(${(size / LINK_GLYPH_BOX).toFixed(4)})`);
  // Mermaid's node rule (`#id .node path { fill; stroke; stroke-width:1px }`)
  // matches these paths directly, so an inherited stroke never reaches them and
  // the icon would draw in the theme's path grey at 1px. Each path therefore
  // states its own paint — same ink as the label text — with !important, which
  // beats that rule.
  const pathPaint = `fill:none !important;stroke:${ink} !important;stroke-width:1.5 !important`;
  // The conventional external-link symbol: a box with an arrow escaping its corner.
  for (const d of [
    'M4.8 3.4 H3.7 A1.5 1.5 0 0 0 2.2 4.9 v4.2 A1.5 1.5 0 0 0 3.7 10.6 h4.2 A1.5 1.5 0 0 0 9.4 9.1 V8',
    'M6.7 2.2 H9.8 V5.3',
    'M9.8 2.2 L5.5 6.5',
  ]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('style', pathPaint);
    inner.appendChild(path);
  }
  glyph.appendChild(inner);

  glyph.setAttribute('transform',
    `translate(${(box.x + box.width + LINK_GLYPH_GAP).toFixed(2)} ${(box.y + box.height / 2 - size / 2).toFixed(2)})`);
  container.appendChild(glyph);

  // Reserve the glyph's own width in the node, so it centres with the label
  // instead of overhanging the shape.
  let advance = 0;
  try {
    const gb = glyph.getBBox();
    advance = LINK_GLYPH_GAP + gb.x + gb.width;
  } catch (_) { advance = 0; }
  padNode(el, advance, box.width);
}

/**
 * Mark nodes that link to another diagram, so the caller can open it on click.
 *
 * `targets` maps a node **id** to the path it opens, built from the source's
 * `click` directives. Ids, not labels: a label is the node's content and stays
 * free for prose. Existing marks are cleared first, because the graph re-renders
 * on every edit and a link may have been removed or renamed away.
 */
export function markNodeLinks(targets) {
  const wanted = targets instanceof Map ? targets : new Map(Object.entries(targets || {}));
  const marked = [];
  for (const { id, el } of getNodeElements()) {
    el.classList.remove('node-link');
    delete el.dataset.link;
    removeLinkGlyph(el);
    restoreLinkDash(el);
    const path = wanted.get(id);
    if (!path) continue;
    el.classList.add('node-link');
    el.dataset.link = path;
    attachLinkGlyph(el);
    clearLinkDash(el);
    marked.push({ id, path });
  }
  return marked;
}

// ── export ─────────────────────────────────────────────────────────────────
function svgMarkup() {
  const el = svgEl();
  if (!el) return null;
  const clone = el.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  // Export the whole graph at its natural size, ignoring the current zoom/pan.
  clone.setAttribute('viewBox', `${base.x} ${base.y} ${base.w} ${base.h}`);
  clone.setAttribute('width', String(base.w));
  clone.setAttribute('height', String(base.h));
  clone.removeAttribute('style');
  return new XMLSerializer().serializeToString(clone);
}

export function exportSvg(filename = 'diagram.svg') {
  const markup = svgMarkup();
  if (!markup) return false;
  download(new Blob([markup], { type: 'image/svg+xml' }), filename);
  return true;
}

// Browsers refuse to rasterise <foreignObject> inside an <img>, and Mermaid uses
// it for every label when htmlLabels is on. Strip anything left of it.
function stripForeignObjects(markup) {
  return markup.replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/g, '');
}

function viewBoxOf(markup) {
  const match = markup.match(/viewBox="([^"]+)"/);
  if (!match) return null;
  const parts = match[1].split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || !(parts[2] > 0) || !(parts[3] > 0)) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

/**
 * Build an SVG suitable for <img> rasterisation: labels as real <text> and no
 * <foreignObject>. Mermaid needs `htmlLabels` disabled at the TOP level for
 * flowchart node labels (the per-diagram `flowchart.htmlLabels` alone is not
 * enough in v11), plus in the flowchart config to drop its measurement divs.
 */
export async function buildExportSvg(source) {
  const saved = config();
  try {
    mermaid.initialize({
      ...saved,
      htmlLabels: false,
      flowchart: { ...(saved.flowchart || {}), htmlLabels: false },
    });
    const id = `mmd-export-${Date.now()}`;
    const { svg } = await mermaid.render(id, source);
    const box = viewBoxOf(svg) || { x: base.x, y: base.y, w: base.w, h: base.h };
    let markup = stripForeignObjects(svg);
    // An <img> needs an intrinsic size; Mermaid only sets width="100%".
    markup = markup.replace(/<svg\b([^>]*)>/, (all, attrs) => {
      const cleaned = attrs
        .replace(/\swidth="[^"]*"/, '')
        .replace(/\sheight="[^"]*"/, '');
      return `<svg${cleaned} width="${box.w}" height="${box.h}">`;
    });
    return { markup, width: box.w, height: box.h };
  } finally {
    mermaid.initialize(saved); // restore the interactive preview config
  }
}

export async function exportPng(filename = 'diagram.png', source = '', scale = 2) {
  if (!svgEl()) return false;
  const ready = source
    ? await buildExportSvg(source)
    : { markup: stripForeignObjects(svgMarkup()), width: base.w, height: base.h };
  if (!ready || !ready.markup) return false;

  const url = URL.createObjectURL(new Blob([ready.markup], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(ready.width * scale));
    canvas.height = Math.max(1, Math.round(ready.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = themeMode === 'light' ? '#ffffff' : '#0b0e14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    let out = null;
    try {
      out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    } catch (err) {
      throw new Error(`canvas is not exportable (${err.message})`);
    }
    if (!out) throw new Error('the browser returned an empty image');
    download(out, filename);
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('the SVG could not be rendered as an image'));
    img.src = url;
  });
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
