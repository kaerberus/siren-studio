// viewer.js — Mermaid rendering, pan/zoom, node highlighting and export.

const mermaid = window.mermaid;

let stage = null;
let target = null;
let emptyState = null;
let themeMode = 'dark';

const view = { scale: 1, tx: 0, ty: 0 };

function apply() {
  target.style.transform =
    `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
}

function svgSize(svg) {
  const box = svg.getAttribute('viewBox');
  if (box) {
    const parts = box.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const rect = svg.getBoundingClientRect();
  return { width: rect.width || 1, height: rect.height || 1 };
}

function normaliseSvg(svg) {
  const { width, height } = svgSize(svg);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.style.maxWidth = 'none';
  svg.style.background = 'transparent';
  return { width, height };
}

export function initViewer({ stageEl, targetEl, emptyEl }) {
  stage = stageEl;
  target = targetEl;
  emptyState = emptyEl;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  });
  bindInteraction();
}

export function setTheme(mode) {
  themeMode = mode;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: mode === 'light' ? 'default' : 'dark',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  });
}

export function setEmptyVisible(visible) {
  if (emptyState) emptyState.hidden = !visible;
  if (target) target.classList.toggle('hidden', visible);
}

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
    const rendered = target.querySelector('svg');
    if (rendered) { normaliseSvg(rendered); fit(); }
    return { ok: true };
  } catch (err) {
    cleanupStray(id);
    if (seq !== renderSeq) return { ok: true, stale: true };
    return { ok: false, error: err };
  }
}

function cleanupStray(id) {
  for (const sel of [`#${CSS.escape(id)}`, `#d${CSS.escape(id)}`]) {
    const el = document.querySelector(sel);
    if (el && el.parentElement === document.body && el.tagName !== 'DIV') el.remove();
    else if (el && el.id.startsWith('dmmd-')) el.remove();
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

// ── pan / zoom ─────────────────────────────────────────────────────────────
function bindInteraction() {
  if (!stage) return;
  let dragging = false;
  let sx = 0;
  let sy = 0;
  let ox = 0;
  let oy = 0;

  stage.addEventListener('wheel', (event) => {
    if (!target.querySelector('svg')) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(6, Math.max(0.08, view.scale * factor));
    const ratio = next / view.scale;
    view.tx = px - (px - view.tx) * ratio;
    view.ty = py - (py - view.ty) * ratio;
    view.scale = next;
    apply();
  }, { passive: false });

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (!target.querySelector('svg')) return;
    dragging = true;
    stage.classList.add('grabbing');
    sx = event.clientX; sy = event.clientY;
    ox = view.tx; oy = view.ty;
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    view.tx = ox + (event.clientX - sx);
    view.ty = oy + (event.clientY - sy);
    apply();
  });
  const end = (event) => {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove('grabbing');
    try { stage.releasePointerCapture(event.pointerId); } catch (_) {}
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  window.addEventListener('resize', () => { /* keep transform; user can refit */ });
}

export function fit() {
  const svg = target.querySelector('svg');
  if (!svg || !stage) return;
  const { width, height } = svgSize(svg);
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const pad = 56;
  const scale = Math.min((sw - pad) / width, (sh - pad) / height, 2);
  view.scale = scale > 0.02 ? scale : 1;
  view.tx = (sw - width * view.scale) / 2;
  view.ty = (sh - height * view.scale) / 2;
  apply();
}

export function zoom(factor) {
  if (!stage) return;
  const sw = stage.clientWidth / 2;
  const sh = stage.clientHeight / 2;
  const next = Math.min(6, Math.max(0.08, view.scale * factor));
  const ratio = next / view.scale;
  view.tx = sw - (sw - view.tx) * ratio;
  view.ty = sh - (sh - view.ty) * ratio;
  view.scale = next;
  apply();
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
  const svg = target.querySelector('svg');
  if (!svg) return [];
  return Array.from(svg.querySelectorAll('g.node, g.statediagram-state, g.classGroup'))
    .map((el) => ({ id: nodeIdOf(el), el }));
}

export function highlightNode(id) {
  const nodes = getNodeElements();
  let found = null;
  for (const node of nodes) {
    const active = node.id === id || node.id.endsWith(`-${id}`) || node.id === id.replace(/^.*\./, '');
    node.el.classList.toggle('node-highlight', active);
    if (active) found = node.el;
  }
  if (found) {
    try { found.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
  }
  return Boolean(found);
}

export function clearHighlight() {
  target.querySelectorAll('.node-highlight')
    .forEach((el) => el.classList.remove('node-highlight'));
}

// ── export ─────────────────────────────────────────────────────────────────
function svgMarkup() {
  const svg = target.querySelector('svg');
  if (!svg) return null;
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  return new XMLSerializer().serializeToString(clone);
}

export function exportSvg(filename = 'diagram.svg') {
  const markup = svgMarkup();
  if (!markup) return false;
  download(new Blob([markup], { type: 'image/svg+xml' }), filename);
  return true;
}

export async function exportPng(filename = 'diagram.png', scale = 2) {
  const svg = target.querySelector('svg');
  if (!svg) return false;
  const markup = svgMarkup();
  const { width, height } = svgSize(svg);
  const blob = new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = themeMode === 'light' ? '#ffffff' : '#0b0e14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (out) download(out, filename);
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
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
