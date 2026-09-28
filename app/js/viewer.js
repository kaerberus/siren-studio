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

let stage = null;
let target = null;
let emptyState = null;
let themeMode = 'dark';

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

// ── render ─────────────────────────────────────────────────────────────────
let renderSeq = 0;

/** Render mermaid source. Returns {ok, error?, empty?}. */
export async function render(text) {
  const seq = ++renderSeq;
  const source = (text || '').trim();
  if (!source) {
    setEmptyVisible(true);
    target.innerHTML = '';
    return { ok: true, empty: true };
  }
  const id = `mmd-${seq}-${Date.now()}`;
  try {
    const { svg } = await mermaid.render(id, source);
    if (seq !== renderSeq) return { ok: true, stale: true };
    target.innerHTML = svg;
    setEmptyVisible(false);
    const el = svgEl();
    if (el) {
      // Let the SVG fill the stage; viewBox does the fitting.
      el.removeAttribute('width');
      el.removeAttribute('height');
      el.style.maxWidth = 'none';
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.background = 'transparent';
      el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      const previous = base;
      base = readBaseViewBox(el);
      if (userAdjusted && previous.w > 0) preserveView(previous);
      else fit();
    }
    return { ok: true };
  } catch (err) {
    cleanupStray(id);
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

function bindInteraction() {
  if (!stage) return;
  let dragging = false;
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
    dragging = true;
    stage.classList.add('grabbing');
    startView = { ...view };
    startLoc = screenToUser(el, event.clientX, event.clientY);
    stage.setPointerCapture(event.pointerId);
  });

  stage.addEventListener('pointermove', (event) => {
    if (!dragging || !startView) return;
    const el = svgEl();
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
