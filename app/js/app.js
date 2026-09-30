// app.js — Mermaid Studio: wiring, files, tabs, sync and the Graph Engineer chat.

import { bridge, oc, escapeHtml } from './bridge.js';
import { createEditor } from './editor.js';
import {
  initViewer, render as renderGraph, setTheme as setMermaidTheme, fit, zoom,
  exportSvg, exportPng, lintMermaid, highlightNode, clearHighlight,
  setEmptyVisible, focusNode, resetView, parseSource, setSmartView, isTransposed,
  getRenderedSource, markNodeLinks,
} from './viewer.js';
import { createAgent, extractAssistant, splitPrompt, toolLabel } from './agent.js';

const $ = (id) => document.getElementById(id);

// ── state ──────────────────────────────────────────────────────────────────
const state = {
  config: null,
  workspace: '',
  entries: [],
  collapsed: new Set(),
  tabs: [],
  active: null,
  untitledSeq: 0,
  theme: localStorage.getItem('ms-theme') || 'dark',
  models: [],
  modelKey: '',   // the model ref currently in effect, as "provider/id#variant"
  pendingBlocks: new Map(),
};

let editor = null;
let agent = null;
let saveTimer = null;
let renderTimer = null;
let outlineTimer = null;

/**
 * Name the project the editor is actually on — topbar, file-tree head and the
 * browser tab. Nothing else says it, and "which folder am I on?" is the exact
 * confusion this prevents: the launcher can open any project, so the folder is
 * not always the one you last had in mind.
 */
function applyWorkspaceLabels() {
  const name = state.config?.projectName || state.workspace || '';
  $('workspace-label').textContent = name;
  document.title = name ? `${name} — Mermaid Studio` : 'Mermaid Studio';
  const root = $('files-root');
  root.textContent = state.graphsDir === '.' ? `/${name}` : `${name}/${state.graphsDir}`;
  root.title = state.config?.graphsPath || state.workspace || '';
}

// ── boot ───────────────────────────────────────────────────────────────────
async function boot() {
  applyTheme(state.theme);

  editor = createEditor({
    host: $('editor-host'),
    onChange: onEditorChange,
    onCursor: onCursor,
    lint: lintMermaid,
  });
  editor.setTheme(state.theme);

  initViewer({
    stageEl: $('graph-stage'),
    targetEl: $('graph-target'),
    emptyEl: $('viewer-empty'),
  });
  setMermaidTheme(state.theme);

  wireUI();
  renderTemplates();

  try {
    state.config = await bridge.config();
  } catch (err) {
    toast(`Bridge unreachable: ${err.message}`, 'err');
    return;
  }
  state.workspace = state.config.project || state.config.workspace;
  state.graphsDir = state.config.graphsDir || '.';
  applyWorkspaceLabels();
  $('status-mermaid').textContent = 'mermaid 11';
  updateOcStatus();

  bridge.subscribe(
    {
      'file-changed': onFileChanged,
      'file-created': () => refreshTree(),
      'file-deleted': onFileDeleted,
      'workspace-changed': (data) => {
        state.workspace = data.root;
        if (data.graphsDir) state.graphsDir = data.graphsDir;
        if (state.config) {
          Object.assign(state.config, {
            project: data.root,
            workspace: data.root,
            graphsDir: state.graphsDir,
            projectName: data.root.split('/').filter(Boolean).pop() || '',
            graphsPath: state.graphsDir === '.' ? data.root : `${data.root}/${state.graphsDir}`,
          });
        }
        applyWorkspaceLabels();
        refreshTree();
        refreshAwarenessState();
      },
      focus: (data) => { if (data.path) openFile(data.path); },
      'validate-request': onValidateRequest,
    },
    (up) => { if (!up) setStatusMsg('bridge reconnecting…'); },
  );

  await refreshTree();
  refreshAwarenessState();
  const model = await loadModels();
  await startAgent(model);
  updateOcStatus(); // the pill can only name the model once the agent has one

  // open the first graph found, if any
  const first = state.entries.find((e) => e.type === 'file' && e.graph && !e.name.endsWith('.gaps.md'));
  if (first) openFile(first.path);
  else setEmptyVisible(true);
}

function updateOcStatus() {
  const el = $('oc-status');
  const oc_ = state.config?.oc || {};
  const text = el.querySelector('.pill-text');
  el.classList.remove('online', 'offline');
  if (oc_.ok) {
    el.classList.add('online');
    const label = currentModelLabel();
    text.textContent = `OpenCode ${oc_.version || ''} · ${label}`.replace(/\s+/g, ' ').trim();
    el.title = `Connected to ${oc_.url}\nClick to change the Graph Engineer's model`;
  } else {
    el.classList.add('offline');
    text.textContent = 'OpenCode offline';
    el.title = oc_.configured ? 'Service not responding' : 'No service discovered';
  }
}

/** Every selectable model, flattened with its effort variants. */
function modelEntries() {
  const entries = [];
  for (const model of state.models || []) {
    const cost = (model.cost || [])[0] || null;
    const base = { providerID: model.providerID, id: model.id };
    entries.push({
      ref: base, key: modelValue(base), provider: model.providerID,
      label: model.name || model.id, cost,
    });
    for (const variant of model.variants || []) {
      if (variant.id === 'default') continue;
      const ref = { providerID: model.providerID, id: model.id, variant: variant.id };
      entries.push({
        ref, key: modelValue(ref), provider: model.providerID,
        label: `${model.name || model.id} · ${variant.id}`, cost,
      });
    }
  }
  return entries;
}

/** Single writer for the model choice, so the pill and the panel cannot drift. */
async function setModelRef(ref, { persist = true } = {}) {
  const key = modelValue(ref);
  if (persist) localStorage.setItem(MODEL_KEY, key);
  applySelectValue($('agent-model'), key);
  state.modelKey = key;
  updateOcStatus();
  if (agent) await agent.setModel(ref);
}

/** Searchable model palette, opened from the OpenCode pill. */
function openModelPalette() {
  const entries = modelEntries();
  if (!entries.length) {
    toast('OpenCode reported no models — check its provider configuration', 'warn');
    return;
  }
  const current = localStorage.getItem(MODEL_KEY) || modelValue(agent?.model);

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal palette">
      <input id="palette-input" class="palette-input" placeholder="Search models…"
             spellcheck="false" autocomplete="off" aria-label="Search models" />
      <div class="palette-list" id="palette-list"></div>
      <div class="palette-foot">
        <span id="palette-count"></span>
        <span class="spacer"></span>
        <span class="hint">↑↓ move · Enter pick · Esc close</span>
      </div>
    </div>`;
  const listEl = backdrop.querySelector('#palette-list');
  const inputEl = backdrop.querySelector('#palette-input');
  const countEl = backdrop.querySelector('#palette-count');
  const close = () => backdrop.remove();
  let matches = entries;
  let active = Math.max(0, matches.findIndex((e) => e.key === current));

  function render() {
    listEl.innerHTML = '';
    if (!matches.length) {
      listEl.innerHTML = '<div class="palette-empty">No model matches that search.</div>';
      countEl.textContent = '';
      return;
    }
    countEl.textContent = `${matches.length} of ${entries.length}`;
    let lastProvider = null;
    matches.forEach((entry, index) => {
      if (entry.provider !== lastProvider) {
        lastProvider = entry.provider;
        const heading = document.createElement('div');
        heading.className = 'palette-group';
        heading.textContent = entry.provider;
        listEl.appendChild(heading);
      }
      const row = document.createElement('div');
      row.className = `palette-item${index === active ? ' active' : ''}`
        + `${entry.key === current ? ' selected' : ''}`;
      const paid = entry.cost && (entry.cost.input > 0 || entry.cost.output > 0);
      const cost = !entry.cost ? ''
        : paid ? `$${entry.cost.input} / $${entry.cost.output}` : 'free';
      row.innerHTML = `<span class="palette-check">✓</span>`
        + `<span class="palette-name">${escapeHtml(entry.label)}</span>`
        + (cost ? `<span class="palette-cost">${escapeHtml(cost)}</span>` : '');
      row.onclick = () => choose(entry);
      row.onmouseenter = () => {
        if (active === index) return;
        active = index;
        listEl.querySelectorAll('.palette-item').forEach((el, i) => el.classList.toggle('active', i === index));
      };
      listEl.appendChild(row);
    });
  }

  async function choose(entry) {
    close();
    await setModelRef(entry.ref);
    toast(`Model: ${entry.label}`, 'ok');
  }

  inputEl.oninput = () => {
    const terms = inputEl.value.toLowerCase().split(/\s+/).filter(Boolean);
    matches = entries.filter((entry) => {
      const haystack = `${entry.provider} ${entry.label} ${entry.key}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    active = 0;
    render();
  };
  inputEl.onkeydown = (event) => {
    if (event.key === 'Escape') { close(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); active = Math.min(matches.length - 1, active + 1); render(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (event.key === 'Enter') { event.preventDefault(); if (matches[active]) choose(matches[active]); }
  };
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  document.body.appendChild(backdrop);
  inputEl.focus();
  render();
}

/**
 * Copy for the composer in each state. Sending mid-turn steers the run, so a
 * busy composer says so rather than silently disabling Send.
 */
function composerCopy(busy, idlePlaceholder) {
  return busy
    ? { placeholder: 'Model is running — send a message to steer it…', hint: 'Ctrl+Enter to steer' }
    : { placeholder: idlePlaceholder, hint: 'Ctrl+Enter to send' };
}

async function startAgent(model) {
  // index.html owns the idle placeholder; remember it before anything swaps it.
  const chatInput = $('chat-input');
  if (!chatInput.dataset.idlePlaceholder) {
    chatInput.dataset.idlePlaceholder = chatInput.placeholder;
  }
  agent = createAgent({
    logEl: $('chat-log'),
    onStatus: (text) => { $('agent-sub').textContent = text; },
    onBusy: (busy) => {
      // Sending mid-turn steers the run (`delivery: 'steer'`), so a busy turn says
      // so rather than disabling the box - the agent may also be waiting on an
      // answer to a question it asked. Stop is the affordance for a busy turn.
      const copy = composerCopy(busy, chatInput.dataset.idlePlaceholder);
      chatInput.placeholder = copy.placeholder;
      $('composer-hint').textContent = copy.hint;
      $('chat-stop').hidden = !busy;
      document.querySelector('.agent-orb')?.classList.toggle('busy', busy);
    },
    onMessages: renderChat,
    onNotice: handleNotice,
  });
  renderChatEmpty();
  await agent.connect(state.config, state.workspace, model);
}

// ── model selection ────────────────────────────────────────────────────────
const MODEL_KEY = 'ms-model';

function parseModelValue(value) {
  if (!value) return null;
  const [pm, variant] = String(value).split('#');
  const slash = pm.indexOf('/');
  if (slash < 1) return null;
  const ref = { providerID: pm.slice(0, slash), id: pm.slice(slash + 1) };
  if (variant) ref.variant = variant;
  return ref;
}

function modelValue(ref) {
  if (!ref) return '';
  return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ''}`;
}

function selectedModelRef() {
  const stored = localStorage.getItem(MODEL_KEY);
  return parseModelValue(stored) || state.config?.defaultModel || null;
}

function currentModelLabel() {
  const wanted = state.modelKey
    || localStorage.getItem(MODEL_KEY)
    || modelValue(agent?.model);
  const entry = modelEntries().find((item) => item.key === wanted);
  return entry ? entry.label : (wanted || 'default model');
}

function applySelectValue(select, value) {
  if (!value) return;
  select.value = value;
  if (select.value !== value) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.insertBefore(option, select.firstChild);
    select.value = value;
  }
}

/** Populate the model picker from OpenCode and return the chosen Model.Ref. */
async function loadModels() {
  const select = $('agent-model');
  select.innerHTML = '';
  try {
    state.models = (await oc.models())?.data || [];
  } catch (_) {
    state.models = [];
  }
  for (const model of state.models) {
    const group = document.createElement('optgroup');
    group.label = model.providerID;
    const base = document.createElement('option');
    base.value = `${model.providerID}/${model.id}`;
    base.textContent = model.name || model.id;
    group.appendChild(base);
    for (const variant of model.variants || []) {
      if (variant.id === 'default') continue;
      const option = document.createElement('option');
      option.value = `${model.providerID}/${model.id}#${variant.id}`;
      option.textContent = `${model.name || model.id} · ${variant.id}`;
      group.appendChild(option);
    }
    select.appendChild(group);
  }
  applySelectValue(select, modelValue(selectedModelRef()));
  state.modelKey = select.value;
  updateOcStatus();
  return parseModelValue(select.value);
}

// ── stalled / empty turn notices ───────────────────────────────────────────
function handleNotice(notice) {
  const box = $('agent-notice');
  const text = $('agent-notice-text');
  const retry = $('agent-retry');
  const stop = $('agent-notice-stop');
  if (!notice) {
    box.hidden = true;
    box.classList.remove('err');
    text.textContent = '';
    return;
  }
  box.hidden = false;
  if (notice.type === 'stalled') {
    box.classList.remove('err');
    text.textContent = `No output from ${notice.model} yet (${notice.elapsed}s). It may be stuck.`;
    retry.hidden = false;
    stop.hidden = false;
  } else if (notice.type === 'empty') {
    box.classList.add('err');
    text.textContent = `${notice.model} finished without producing a response.`;
    retry.hidden = false;
    stop.hidden = true;
  } else if (notice.type === 'no-agent') {
    box.classList.add('err');
    text.innerHTML = `The <code>${escapeHtml(notice.agent)}</code> agent isn't installed, `
      + `so this turn can't run. Install it with <code>python3 install-agent.py</code>, `
      + `then Retry.`;
    retry.hidden = false;
    stop.hidden = true;
  }
}

// ── theme ──────────────────────────────────────────────────────────────────
function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  state.theme = mode;
  localStorage.setItem('ms-theme', mode);
}

// ── files & tree ───────────────────────────────────────────────────────────
async function refreshTree() {
  try {
    const result = await bridge.tree();
    state.entries = result.entries || [];
    renderTree();
    return true;
  } catch (err) {
    setStatusMsg(`tree: ${err.message}`);
    return false;
  }
}

function renderTree() {
  const host = $('file-tree');
  host.innerHTML = '';
  const roots = buildTree(state.entries);
  if (!roots.children.size && !roots.files.length) {
    host.innerHTML = '<div class="tree-empty">No diagrams yet.<br>Create a new file or ask the Graph Engineer to model a codebase.</div>';
    return;
  }
  host.appendChild(renderNode(roots, 0));
}

function buildTree(entries) {
  const root = { children: new Map(), files: [] };
  for (const entry of entries) {
    const parts = entry.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts.slice(0, i + 1).join('/');
      if (!node.children.has(key)) node.children.set(key, { name: parts[i], path: key, children: new Map(), files: [] });
      node = node.children.get(key);
    }
    node.files.push(entry);
  }
  return root;
}

function renderNode(node, depth) {
  const frag = document.createDocumentFragment();
  for (const [key, child] of node.children) {
    const collapsed = state.collapsed.has(key);
    const row = document.createElement('div');
    row.className = 'tree-item dir';
    row.style.paddingLeft = `${6 + depth * 12}px`;
    row.innerHTML = `<svg class="ti-icon" viewBox="0 0 24 24"><path d="${collapsed ? 'M9 6l6 6-6 6' : 'M6 9l6 6 6-6'}"/></svg><span class="ti-name">${escapeHtml(child.name)}</span>`;
    row.onclick = () => {
      if (collapsed) state.collapsed.delete(key); else state.collapsed.add(key);
      renderTree();
    };
    frag.appendChild(row);
    if (!collapsed) frag.appendChild(renderNode(child, depth + 1));
  }
  for (const file of node.files) {
    const isGraph = file.graph && !file.name.endsWith('.gaps.md');
    const row = document.createElement('div');
    row.className = `tree-item${isGraph ? ' graph' : ''}${state.active === file.path ? ' active' : ''}`;
    row.style.paddingLeft = `${6 + depth * 12}px`;
    const icon = isGraph
      ? '<svg class="ti-icon" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="9" r="2.4"/><circle cx="11" cy="18" r="2.4"/><path d="M8 6.9 15.6 8.4M7.3 8l2.7 7.4M15.8 11.1 12.6 15.9"/></svg>'
      : '<svg class="ti-icon" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>';
    row.innerHTML = `${icon}<span class="ti-name">${escapeHtml(file.name)}</span>`;
    row.onclick = () => openFile(file.path);
    frag.appendChild(row);
  }
  return frag;
}

// ── tabs ───────────────────────────────────────────────────────────────────
function renderTabs() {
  const host = $('tabs');
  host.innerHTML = '';
  for (const tab of state.tabs) {
    const el = document.createElement('button');
    el.className = `tab${state.active === tab.key ? ' active' : ''}`;
    el.innerHTML = `${tab.dirty ? '<span class="tab-dot"></span>' : ''}<span class="tab-name">${escapeHtml(tab.name)}</span><span class="tab-close">×</span>`;
    el.onclick = (event) => {
      if (event.target.classList.contains('tab-close')) { closeTab(tab.key); return; }
      activateTab(tab.key);
    };
    host.appendChild(el);
  }
}

function findTab(key) { return state.tabs.find((t) => t.key === key); }

function activateTab(key) {
  const tab = findTab(key);
  if (!tab) return;
  state.active = key;
  resetView(); // each diagram starts fitted
  editor.setValue(tab.content);
  $('editor-title').textContent = tab.name;
  $('status-file').textContent = tab.path || `${tab.name} (unsaved)`;
  updateDirty();
  renderTabs();
  renderTree();
  scheduleRender(0);
  scheduleOutline(0);
  loadLedger(tab);
  try { editor.cm.performLint(); } catch (_) {}
}

function closeTab(key) {
  const idx = state.tabs.findIndex((t) => t.key === key);
  if (idx < 0) return;
  const tab = state.tabs[idx];
  if (tab.dirty && !confirmDiscard(tab.name)) return;
  state.tabs.splice(idx, 1);
  if (state.active === key) {
    const next = state.tabs[idx] || state.tabs[idx - 1];
    if (next) activateTab(next.key);
    else {
      state.active = null;
      editor.setValue('');
      $('editor-title').textContent = 'No file';
      $('status-file').textContent = '—';
      $('gaps-list').innerHTML = '';
      setEmptyVisible(true);
      renderTabs();
    }
  } else {
    renderTabs();
  }
}

const isDiagramPath = (path) => /\.(?:mmd|mermaid)$/i.test(path || '');

/**
 * Resolve a `click` target to a path in this workspace. The target is a bare
 * filename or a path from the project root, as an agent sees it. Only real files
 * resolve: a link to a diagram that has not been written yet stays a plain node
 * rather than becoming a dead end.
 */
function resolveDiagramTarget(target) {
  const name = String(target || '').trim().replace(/^\.\//, '');
  if (!isDiagramPath(name)) return null;
  const diagrams = (state.entries || []).filter((entry) => isDiagramPath(entry.path));
  if (name.includes('/')) {
    return diagrams.some((entry) => entry.path === name) ? name : null;
  }
  // Prefer a sibling of the open file, then any file with that basename.
  const active = findTab(state.active);
  const here = active?.path?.includes('/')
    ? active.path.slice(0, active.path.lastIndexOf('/') + 1) : '';
  const sibling = diagrams.find((entry) => entry.path === `${here}${name}`);
  if (sibling) return sibling.path;
  const lower = name.toLowerCase();
  const byName = diagrams.find((entry) => (entry.path.split('/').pop() || '').toLowerCase() === lower);
  return byName ? byName.path : null;
}

/** node id -> openable path, for every `click` in this diagram that resolves. */
function nodeLinkTargets(text) {
  const targets = new Map();
  for (const [id, target] of analyzeGraph(text).clicks) {
    const path = resolveDiagramTarget(target);
    if (path) targets.set(id, path);
  }
  return targets;
}

async function openFile(path, { silent = false } = {}) {
  const existing = state.tabs.find((t) => t.path === path);
  if (existing) { activateTab(existing.key); return; }
  let data;
  try {
    data = await bridge.read(path);
  } catch (err) {
    if (!silent) toast(`Cannot open ${path}: ${err.message}`, 'err');
    return;
  }
  const tab = {
    key: path, path, name: path.split('/').pop(), content: data.content,
    mtime: data.mtime, dirty: false,
  };
  state.tabs.push(tab);
  activateTab(tab.key);
}

function openUntitled(source = '') {
  state.untitledSeq += 1;
  const name = `untitled-${state.untitledSeq}.mmd`;
  const tab = { key: `new:${state.untitledSeq}`, path: null, name, content: source, dirty: true };
  state.tabs.push(tab);
  activateTab(tab.key);
}

// ── editing ────────────────────────────────────────────────────────────────
function onEditorChange(value) {
  const tab = findTab(state.active);
  if (!tab) return;
  tab.content = value;
  if (!tab.dirty) { tab.dirty = true; updateDirty(); renderTabs(); }
  scheduleRender();
  scheduleOutline();
  scheduleAutosave();
}

function onCursor({ line, ch = 0 }) {
  $('status-pos').textContent = `Ln ${line + 1}, Col ${ch + 1}`;
  const tab = findTab(state.active);
  if (!tab) return;
  const analysis = analyzeGraph(tab.content);
  const ids = analysis.byLine.get(line);
  if (ids && ids.length) {
    const id = ids[0];
    highlightNode(id);
    editor.highlightLines(analysis.linesForId(id));
  } else {
    clearHighlight();
    editor.clearHighlight();
  }
}

function updateDirty() {
  const tab = findTab(state.active);
  $('dirty-dot').hidden = !(tab && tab.dirty);
}

function scheduleAutosave() {
  const tab = findTab(state.active);
  if (!tab || !tab.path) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveActive({ quiet: true }), 900);
}

async function saveActive({ quiet = false } = {}) {
  const tab = findTab(state.active);
  if (!tab) return false;
  if (!tab.path) return saveAs(tab);
  try {
    const result = await bridge.write(tab.path, tab.content);
    tab.mtime = result.mtime;
    tab.dirty = false;
    updateDirty();
    renderTabs();
    if (!quiet) setStatusMsg('saved');
    return true;
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'err');
    return false;
  }
}

async function saveAs(tab) {
  const name = await promptModal({
    title: 'Save diagram',
    label: 'File name (relative to workspace)',
    value: tab.name.replace(/\.mmd$/, '') + '.mmd',
  });
  if (!name) return false;
  const path = name.includes('.') ? name : `${name}.mmd`;
  try {
    const result = await bridge.write(path, tab.content);
    tab.path = path;
    tab.key = path;
    tab.name = path.split('/').pop();
    tab.mtime = result.mtime;
    tab.dirty = false;
    state.active = path;
    activateTab(path);
    refreshTree();
    return true;
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'err');
    return false;
  }
}

function applySmartView(on) {
  setSmartView(on);
  $('smart-view').checked = on;
  localStorage.setItem('ms-smart-view', on ? '1' : '0');
  updateViewerNote();
}

function updateViewerNote() {
  const note = $('viewer-note');
  if (note) note.hidden = !isTransposed();
}

function scheduleRender(delay = 260) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(async () => {
    const tab = findTab(state.active);
    if (!tab) return;
    const result = await renderGraph(tab.content);
    markNodeLinks(nodeLinkTargets(tab.content));
    updateViewerNote();
    const badge = $('lint-badge');
    if (result.ok) {
      badge.textContent = 'ok';
      badge.className = 'lint-badge ok';
    } else {
      badge.textContent = 'error';
      badge.className = 'lint-badge err';
      badge.title = result.error?.message || String(result.error);
    }
  }, delay);
}

function scheduleOutline(delay = 300) {
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(() => {
    const tab = findTab(state.active);
    if (!tab) return;
    renderOutline(analyzeGraph(tab.content));
  }, delay);
}

// ── graph analysis (outline + node/line mapping) ───────────────────────────
function analyzeGraph(text) {
  const nodes = new Map();
  const byLine = new Map();
  const subgraphs = [];
  const clicks = new Map();   // node id -> the diagram it links to
  const lines = (text || '').split('\n');
  const skip = /^\s*(%%|classDef|class\s|style\s|linkStyle|click\s)/;

  const addOccurrence = (id, line) => {
    if (!byLine.has(line)) byLine.set(line, []);
    if (!byLine.get(line).includes(id)) byLine.get(line).push(id);
  };

  lines.forEach((line, index) => {
    // Mermaid's own link syntax: `click <id> "<path>"`, optionally `click <id>
    // href "<path>"`. Ids, so the node's label stays free for prose.
    const clicked = line.match(/^\s*click\s+(\S+)\s+(?:href\s+)?["']([^"']+)["']/i);
    if (clicked) {
      const target = clicked[2].trim();
      if (isDiagramPath(target) && !clicks.has(clicked[1])) clicks.set(clicked[1], target);
      return; // a click line declares no nodes of its own
    }
    if (skip.test(line)) return;
    const sub = line.match(/^\s*subgraph\s+([^\s[\]]+)(?:\s*\["?([^\]]*?)"?\])?/);
    if (sub) {
      subgraphs.push({ id: sub[1], label: sub[2] || sub[1], line: index });
      addOccurrence(sub[1], index);
    }
    const re = /([A-Za-z_][\w-]*)\s*(\(\(|\[\[|\{\{|\[\(|\[\/|\[\\|\[|\(|\{|>)/g;
    let match = re.exec(line);
    while (match) {
      const id = match[1];
      const openIdx = match.index + match[0].length - match[2].length;
      const label = readLabel(line, openIdx);
      if (!nodes.has(id)) nodes.set(id, { id, label, line: index });
      addOccurrence(id, index);
      match = re.exec(line);
    }
  });

  const linesForId = (id) => {
    const hits = [];
    byLine.forEach((ids, line) => { if (ids.includes(id)) hits.push(line); });
    return hits;
  };

  return {
    nodes: [...nodes.values()],
    subgraphs,
    clicks,
    byLine,
    linesForId,
  };
}

function readLabel(line, openIdx) {
  const open = line[openIdx];
  const closeFor = { '[': ']', '(': ')', '{': '}' };
  const close = closeFor[open];
  if (!close) {
    const m = line.slice(openIdx).match(/^[>\]\(\[{]*([^\]\)\}]*)/);
    return (m && m[1] ? m[1].trim() : '');
  }
  let depth = 0;
  let start = -1;
  for (let i = openIdx; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === open) { depth += 1; if (depth === 1) start = i + 1; }
    else if (ch === close) {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0) {
        return line.slice(start, i)
          .replace(/^[["'{(\s]+/, '').replace(/[\])}'\s]+$/, '').trim();
      }
    }
  }
  return line.slice(start >= 0 ? start : openIdx).replace(/^[["'{(\s]+/, '').trim();
}

function renderOutline(analysis) {
  const host = $('outline-list');
  host.innerHTML = '';
  const items = [
    ...analysis.subgraphs.map((s) => ({ ...s, kind: 'sub' })),
    ...analysis.nodes.map((n) => ({ ...n, kind: 'node' })),
  ];
  if (!items.length) {
    host.innerHTML = '<div class="tree-empty">No nodes detected.</div>';
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'outline-item';
    row.innerHTML = `<span class="outline-kind">${item.kind}</span><span>${escapeHtml(item.label || item.id)}</span>`;
    row.onmouseenter = () => { highlightNode(item.id); editor.highlightLines(analysis.linesForId(item.id)); };
    row.onmouseleave = () => { clearHighlight(); editor.clearHighlight(); };
    row.onclick = () => { editor.gotoLine(item.line); focusNode(item.id); };
    host.appendChild(row);
  }
}

// ── ledger / gaps panel ────────────────────────────────────────────────────
function ledgerPathFor(path) {
  if (!path) return null;
  return path.replace(/\.(mmd|mermaid)$/, '') + '.gaps.md';
}

async function loadLedger(tab) {
  const host = $('gaps-list');
  if (!tab || !tab.path) {
    host.innerHTML = '<div class="gaps-empty">Save the diagram to start a design gap ledger.<br><br>The Graph Engineer records open questions, assumptions and unmodelled paths in a sibling <code>*.gaps.md</code> file.</div>';
    return;
  }
  const ledger = ledgerPathFor(tab.path);
  try {
    const data = await bridge.read(ledger);
    host.dataset.path = ledger;
    host.innerHTML = markdownToHtml(data.content) || '<div class="gaps-empty">Ledger is empty.</div>';
  } catch (_) {
    host.dataset.path = ledger;
    host.innerHTML = `<div class="gaps-empty">No ledger yet for <code>${escapeHtml(tab.name)}</code>.<br><br>Ask the Graph Engineer to review this diagram and it will write one to <code>${escapeHtml(ledger)}</code>.</div>`;
  }
}

async function readLedgerText() {
  const path = $('gaps-list').dataset.path;
  if (!path) return { path: null, text: '' };
  try {
    const data = await bridge.read(path);
    return { path, text: data.content };
  } catch (_) {
    return { path, text: '' };
  }
}

// ── external file changes ──────────────────────────────────────────────────
function onFileChanged(data) {
  if (!data || data.origin === 'editor') return;
  refreshTree();
  const tab = findTab(data.path);
  if (tab) {
    if (tab.dirty) {
      toast(`“${tab.name}” changed on disk while you have unsaved edits.`, 'warn', [
        { label: 'Reload', onClick: () => reloadTab(tab) },
        { label: 'Keep mine', onClick: () => {} },
      ]);
      return;
    }
    reloadTab(tab, true);
    return;
  }
  const active = findTab(state.active);
  if (active && active.path && ledgerPathFor(active.path) === data.path) {
    loadLedger(active);
    setStatusMsg('gap ledger updated');
  }
}

async function reloadTab(tab, quiet = false) {
  try {
    const data = await bridge.read(tab.path);
    applyDiskContent(tab, data);
    if (!quiet) setStatusMsg('reloaded from disk');
    return true;
  } catch (err) {
    toast(`Reload failed: ${err.message}`, 'err');
    return false;
  }
}

/** Apply freshly read disk content to a tab, and to the editor when it is active. */
function applyDiskContent(tab, data) {
  tab.content = data.content;
  tab.mtime = data.mtime;
  tab.dirty = false;
  updateDirty();
  renderTabs();
  if (state.active !== tab.key) return;
  const cursor = editor.cm.getCursor();
  editor.setValue(data.content);
  editor.cm.setCursor(cursor);
  scheduleRender(0);
  scheduleOutline(0);
  loadLedger(tab);
}

/**
 * Re-read every clean tab from disk. Dirty tabs are left alone: an external
 * write is not a reason to throw away your edits.
 */
async function rescanTabs() {
  let changed = 0;
  for (const tab of state.tabs) {
    if (!tab.path || tab.dirty) continue;
    let data;
    try {
      data = await bridge.read(tab.path);
    } catch (_) {
      continue; // gone — `file-deleted` owns that conversation
    }
    if (data.content === tab.content) continue;
    applyDiskContent(tab, data);
    changed += 1;
  }
  return changed;
}

/**
 * Rescan folder: re-read the tree, any clean buffers, and the ledger of the open
 * diagram. It deliberately does NOT re-detect or switch the project — that is
 * `Open project…`, and a rescan that quietly teleports you elsewhere is a trap.
 */
async function rescanFolder() {
  const button = $('btn-refresh');
  if (button.disabled) return;
  button.disabled = true;
  button.classList.add('spinning');
  try {
    if (!await refreshTree()) {
      toast('Could not read the folder — see the status bar.', 'err');
      return;
    }
    const changed = await rescanTabs();
    const active = findTab(state.active);
    if (active?.path) await loadLedger(active);
    await refreshAwarenessState();
    const files = state.entries.filter((entry) => entry.type === 'file').length;
    const plural = (n) => `${n} file${n === 1 ? '' : 's'}`;
    toast(changed ? `Rescanned — ${plural(changed)} changed`
      : state.entries.length === 0 ? 'Rescanned — the folder is empty'
        : `Rescanned — ${plural(files)}, nothing changed`, 'ok');
  } finally {
    button.disabled = false;
    button.classList.remove('spinning');
  }
}

/** Answer the plugin's `graph_validate` with the real Mermaid parser. */
async function onValidateRequest(data) {
  if (!data?.nonce) return;
  let result;
  try {
    result = await parseSource(data.source || '');
  } catch (err) {
    result = { ok: false, errors: [{ line: 1, message: String(err.message || err) }] };
  }
  try {
    await bridge.validateResult(data.nonce, result);
  } catch (_) { /* the bridge will time out and fall back to structural lint */ }
}

function onFileDeleted(data) {
  refreshTree();
  const tab = findTab(data.path);
  if (tab) {
    tab.dirty = true;
    renderTabs();
    toast(`“${tab.name}” was deleted on disk. Your buffer is kept.`, 'warn');
  }
}

// ── chat ───────────────────────────────────────────────────────────────────
function renderChatEmpty() {
  $('chat-log').innerHTML = `<div class="chat-empty">
    <strong>Graph Engineer</strong><br>
    Draft, interrogate and tighten flowcharts with me.<br>
    I can read this workspace and write diagrams back to it.
  </div>`;
}

function renderChat(messages) {
  const host = $('chat-log');
  const visible = messages.filter((m) => ['user', 'assistant'].includes(m.type));
  if (!visible.length) { renderChatEmpty(); return; }
  const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 80;
  host.innerHTML = '';
  state.pendingBlocks.clear();

  for (const message of visible) {
    if (message.type === 'user') {
      host.appendChild(userMessageNode(message.text || ''));
    } else if (message.type === 'assistant') {
      const parsed = extractAssistant(message);
      const node = document.createElement('div');
      node.className = 'msg assistant';
      node.innerHTML = '<div class="msg-role">Graph Engineer</div>';
      const body = document.createElement('div');
      body.className = 'msg-body';
      for (const tool of parsed.tools) {
        const chip = document.createElement('div');
        chip.className = 'msg-tool';
        chip.textContent = toolLabel(tool);
        chip.style.cssText = 'font-family:var(--font-mono);font-size:11px;color:var(--text-faint);margin:2px 0';
        body.appendChild(chip);
      }
      const textEl = document.createElement('div');
      const idle = !parsed.text && !parsed.tools.length;
      if (idle && parsed.completed) {
        textEl.innerHTML = `<span class="msg-empty">The model returned no output. </span><button class="mini-btn retry-inline" type="button">Retry</button>`;
      } else if (idle) {
        textEl.innerHTML = `<span class="msg-waiting">Waiting for ${escapeHtml(currentModelLabel())}…</span>`;
      } else {
        textEl.innerHTML = markdownToHtml(parsed.text || '');
      }
      if (!parsed.completed) {
        const cursor = document.createElement('span');
        cursor.className = 'cursor';
        textEl.appendChild(cursor);
      }
      body.appendChild(textEl);
      node.appendChild(body);
      host.appendChild(node);
    }
  }
  if (atBottom) host.scrollTop = host.scrollHeight;
}

/**
 * A user turn. The prompt we send inlines the current diagram and ledger, so
 * the stored text is the question plus two whole files. Show the question and
 * fold the files away — the model still received all of it.
 */
function userMessageNode(text) {
  const node = document.createElement('div');
  node.className = 'msg user';
  node.innerHTML = '<div class="msg-role">You</div>';
  const body = document.createElement('div');
  body.className = 'msg-body';

  const { question, attachments } = splitPrompt(text);
  if (question) body.innerHTML = markdownToHtml(question);

  if (attachments.length) {
    const details = document.createElement('details');
    details.className = 'msg-attach';
    const summary = document.createElement('summary');
    summary.textContent = `attached: ${attachments.map((a) => a.label).join(', ')}`;
    details.appendChild(summary);
    for (const attachment of attachments) {
      const item = document.createElement('div');
      item.className = 'attach-item';
      const name = document.createElement('div');
      name.className = 'attach-name';
      name.textContent = `${attachment.kind} · ${attachment.label}`;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = attachment.source;
      pre.appendChild(code);
      item.append(name, pre);
      details.appendChild(item);
    }
    body.appendChild(details);
  }

  node.appendChild(body);
  return node;
}

async function sendChat(text) {
  if (!text || !text.trim() || !agent) return;
  const active = findTab(state.active);
  const ledger = await readLedgerText();
  try {
    await agent.send(text, {
      attachGraph: $('ctx-graph').checked,
      attachGaps: $('ctx-gaps').checked,
      graph: active ? active.content : '',
      graphPath: active ? (active.path || active.name) : '',
      gaps: ledger.text,
      gapsPath: ledger.path || '',
    });
  } catch (err) {
    toast(`Send failed: ${err.message}`, 'err');
  }
}

// ── markdown (small, safe subset) ──────────────────────────────────────────
function markdownToHtml(markdown) {
  if (!markdown) return '';
  const lines = String(markdown).split('\n');
  let html = '';
  let inCode = false;
  let codeLang = '';
  let code = [];
  let listType = null;

  const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };

  for (const line of lines) {
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      if (inCode) {
        const raw = code.join('\n');
        if (codeLang === 'mermaid') {
          const key = `b${state.pendingBlocks.size}`;
          state.pendingBlocks.set(key, raw);
          html += `<div class="code-block"><pre><code>${escapeHtml(raw)}</code></pre><div class="msg-actions"><button class="apply-graph" data-block="${key}">Apply to editor</button></div></div>`;
        } else {
          html += `<pre><code>${escapeHtml(raw)}</code></pre>`;
        }
        inCode = false; code = []; codeLang = '';
      } else { inCode = true; codeLang = fence[1] || ''; }
      continue;
    }
    if (inCode) { code.push(line); continue; }

    if (!line.trim()) { closeList(); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { closeList(); html += `<p><strong>${inline(heading[2])}</strong></p>`; continue; }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const type = ul ? 'ul' : 'ol';
      if (listType !== type) { closeList(); html += `<${type}>`; listType = type; }
      html += `<li>${inline((ul || ol)[1])}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  if (inCode) html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`;
  closeList();
  return html;
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

// ── UI wiring ──────────────────────────────────────────────────────────────
function wireUI() {
  $('toggle-sidebar').onclick = () => $('app').classList.toggle('sidebar-hidden');
  $('toggle-agent').onclick = () => {
    $('app').classList.toggle('agent-hidden');
    $('toggle-agent').classList.toggle('active', !$('app').classList.contains('agent-hidden'));
  };

  document.querySelectorAll('.side-tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.side-tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.side-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`panel-${tab.dataset.panel}`).classList.add('active');
    };
  });

  applySmartView(localStorage.getItem('ms-smart-view') !== '0');
  $('smart-view').onchange = () => {
    applySmartView($('smart-view').checked);
    scheduleRender(0);
  };

  $('btn-refresh').onclick = rescanFolder;
  $('btn-new-file').onclick = newFileModal;
  $('btn-new').onclick = () => openUntitled('flowchart TD\n    A[Start] --> B{Decision}\n    B -->|yes| C[Do the thing]\n    B -->|no| D[Stop]\n');
  $('btn-save').onclick = () => saveActive();
  $('btn-theme').onclick = () => {
    const next = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    editor.setTheme(next);
    setMermaidTheme(next);
    scheduleRender(0);
  };

  const exportMenu = $('export-menu');
  $('btn-export').onclick = (event) => { event.stopPropagation(); exportMenu.hidden = !exportMenu.hidden; };
  document.addEventListener('click', () => { exportMenu.hidden = true; });
  exportMenu.onclick = async (event) => {
    const kind = event.target.dataset.export;
    if (!kind) return;
    const tab = findTab(state.active);
    const base = (tab?.name || 'diagram').replace(/\.(mmd|mermaid)$/, '');
    try {
      if (kind === 'svg') {
        if (!exportSvg(`${base}.svg`)) toast('Nothing to export', 'warn');
        else toast('Saved SVG', 'ok');
      }
      if (kind === 'png') {
        // export what is on screen, so smart view transposition is included
        const shown = getRenderedSource() || tab?.content || '';
        if (!(await exportPng(`${base}.png`, shown))) toast('Nothing to export', 'warn');
        else toast('Saved PNG', 'ok');
      }
      if (kind === 'mmd') downloadText(tab?.content || '', `${base}.mmd`);
      if (kind === 'copy') { navigator.clipboard.writeText(tab?.content || ''); toast('Source copied', 'ok'); }
    } catch (err) {
      toast(`Export failed: ${err.message}. Try Download SVG.`, 'err');
    }
  };

  $('zoom-in').onclick = () => zoom(1.2);
  $('zoom-out').onclick = () => zoom(1 / 1.2);
  $('zoom-fit').onclick = fit;
  $('btn-present').onclick = present;

  $('btn-open-workspace').onclick = openWorkspaceModal;
  $('btn-awareness').onclick = openAwarenessModal;
  $('btn-gaps-edit').onclick = editLedger;

  // splitter
  const splitter = $('splitter');
  const workbench = splitter.parentElement;
  splitter.addEventListener('pointerdown', (event) => {
    splitter.classList.add('dragging');
    splitter.setPointerCapture(event.pointerId);
    const rect = workbench.getBoundingClientRect();
    const move = (moveEvent) => {
      const pct = Math.min(80, Math.max(20, ((moveEvent.clientX - rect.left) / rect.width) * 100));
      document.documentElement.style.setProperty('--editor-w', `${pct}%`);
    };
    const up = () => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      scheduleRender(0); // the pane changed shape: re-evaluate smart view
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });

  // agent-panel splitter. The panel is a grid column, so the drag rewrites
  // --agent-w, clamped so neither the panel nor the workbench becomes unusable.
  const AGENT_MIN_W = 280;
  const AGENT_MAX_W = 720;
  const WORKBENCH_MIN_W = 420;
  const agentSplitter = $('agent-splitter');
  const bodyEl = agentSplitter.parentElement;
  const appEl = $('app');
  agentSplitter.addEventListener('pointerdown', (event) => {
    agentSplitter.classList.add('dragging');
    agentSplitter.setPointerCapture(event.pointerId);
    const rect = bodyEl.getBoundingClientRect();
    const max = Math.max(AGENT_MIN_W,
      Math.min(AGENT_MAX_W, rect.width - WORKBENCH_MIN_W));
    const move = (moveEvent) => {
      const width = Math.max(AGENT_MIN_W, Math.min(max, rect.right - moveEvent.clientX));
      document.documentElement.style.setProperty('--agent-w', `${width}px`);
    };
    const up = () => {
      agentSplitter.classList.remove('dragging');
      appEl.classList.remove('resizing');
      agentSplitter.removeEventListener('pointermove', move);
      agentSplitter.removeEventListener('pointerup', up);
      scheduleRender(0); // the panes changed shape: re-evaluate smart view
    };
    appEl.classList.add('resizing');
    agentSplitter.addEventListener('pointermove', move);
    agentSplitter.addEventListener('pointerup', up);
  });

  // chat
  $('composer').onsubmit = async (event) => {
    event.preventDefault();
    const input = $('chat-input');
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    await sendChat(text);
  };
  $('chat-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $('composer').requestSubmit();
    }
  });
  $('chat-stop').onclick = () => agent?.stop();
  $('btn-agent-new').onclick = async () => {
    if (agent?.busy && !window.confirm('A reply is still running. Start a new session anyway?')) return;
    const tab = findTab(state.active);
    const title = tab ? `Graph Engineering — ${tab.name}` : 'Graph Engineering';
    renderChatEmpty();
    const started = await agent?.newSession(title);
    toast(started ? 'New session started' : 'Could not start a session', started ? 'ok' : 'err');
  };
  $('oc-status').onclick = openModelPalette;
  $('agent-model').onchange = async () => {
    const ref = parseModelValue($('agent-model').value);
    setStatusMsg(`model: ${modelValue(ref)}`);
    await setModelRef(ref);
  };
  $('agent-retry').onclick = () => agent?.retry();
  $('agent-notice-stop').onclick = () => agent?.stop();

  $('chat-log').addEventListener('click', (event) => {
    const retry = event.target.closest('.retry-inline');
    if (retry) { agent?.retry(); return; }
    const button = event.target.closest('.apply-graph');
    if (!button) return;
    const code = state.pendingBlocks.get(button.dataset.block);
    if (code == null) return;
    const tab = findTab(state.active) || openUntitled();
    const active = findTab(state.active);
    active.content = code;
    active.dirty = true;
    editor.setValue(code);
    scheduleRender(0);
    scheduleOutline(0);
    updateDirty();
    renderTabs();
    toast('Applied to editor', 'ok');
  });
  document.querySelectorAll('#quick-prompts button').forEach((button) => {
    button.onclick = () => sendChat(button.dataset.prompt);
  });

  // viewer node click → follow its `click` link, else jump to its source
  $('graph-target').addEventListener('click', (event) => {
    const group = event.target.closest('g.node, g.statediagram-state');
    if (!group) return;
    if (group.dataset.link) { openFile(group.dataset.link); return; }
    const tab = findTab(state.active);
    if (!tab) return;
    const analysis = analyzeGraph(tab.content);
    const id = group.dataset?.id
      || (group.id || '').replace(/^(?:flowchart|state)-/, '').replace(/-\d+$/, '');
    const node = analysis.nodes.find((n) => n.id === id);
    if (node) editor.gotoLine(node.line);
    focusNode(id);
  });

  // the pane shape feeds the smart-view decision
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => scheduleRender(0), 220);
  });

  // shortcuts
  window.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    if (event.key === 's') { event.preventDefault(); saveActive(); }
    else if (event.key === 'n') { event.preventDefault(); openUntitled('flowchart TD\n    A[Start] --> B[Next]\n'); }
    else if (event.key === 'b') { event.preventDefault(); $('toggle-agent').click(); }
    else if (event.key === '1') { event.preventDefault(); $('toggle-sidebar').click(); }
    else if (event.key === 'Enter') { /* let editor handle */ }
  });
}

function present() {
  const el = $('viewer-host');
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.().then(() => setTimeout(fit, 120));
}

// ── modals ─────────────────────────────────────────────────────────────────
function promptModal({ title, label, value = '' }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(label)}</p>
        <input id="modal-input" value="${escapeHtml(value)}" />
        <div class="modal-actions">
          <button class="cancel">Cancel</button>
          <button class="confirm">OK</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const input = backdrop.querySelector('#modal-input');
    const done = (result) => { backdrop.remove(); resolve(result); };
    input.focus();
    input.select();
    backdrop.querySelector('.cancel').onclick = () => done(null);
    backdrop.querySelector('.confirm').onclick = () => done(input.value.trim());
    input.onkeydown = (event) => {
      if (event.key === 'Enter') done(input.value.trim());
      if (event.key === 'Escape') done(null);
    };
  });
}

async function newFileModal() {
  const dir = state.graphsDir && state.graphsDir !== '.' ? `${state.graphsDir}/` : '';
  const name = await promptModal({
    title: 'New diagram',
    label: `File name (relative to ${dir || 'the project root'})`,
    value: `${dir}flowchart.mmd`,
  });
  if (!name) return;
  const path = name.includes('.') ? name : `${name}.mmd`;
  const content = 'flowchart TD\n    A[Start] --> B[Next]\n';
  try {
    await bridge.write(path, content);
    await refreshTree();
    openFile(path);
  } catch (err) {
    toast(`Create failed: ${err.message}`, 'err');
  }
}

// ── agent awareness ────────────────────────────────────────────────────────

/** Does this project already tell other agents that graphs/ is intent? */
async function refreshAwarenessState() {
  const button = $('btn-awareness');
  if (!button) return;
  try {
    const info = await bridge.setupProject(state.workspace,
      { preview: true, createGraphs: false });
    button.dataset.info = JSON.stringify({
      graphsDir: info.graphsDir, wired: info.wired, files: info.files,
    });
    button.textContent = info.wired ? 'Agents aware ✓' : 'Make agents aware';
    button.classList.toggle('wired', Boolean(info.wired));
  } catch (_) {
    button.textContent = 'Make agents aware';
    button.classList.remove('wired');
  }
}

async function openAwarenessModal() {
  let info;
  try {
    info = await bridge.setupProject(state.workspace,
      { preview: true, includePreview: true, createGraphs: false });
  } catch (err) {
    toast(`Cannot inspect project: ${err.message}`, 'err');
    return;
  }
  const where = info.graphsDir === '.' ? 'this project root' : `${info.graphsDir}/`;
  const files = (info.files || []).map((f) => (
    `<li><code>${escapeHtml(f.path)}</code> — ${escapeHtml(f.action)}`
    + `${f.wired ? ', aware' : ''}</li>`
  )).join('');
  const block = info.preview?.['AGENTS.md'] || '(already written — preview hidden)';

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal modal-lg">
      <h3>Agent awareness</h3>
      <p>How other agents learn that <code>${escapeHtml(where)}</code> is design intent.</p>
      <div class="aware-files"><ul>${files}</ul></div>
      <pre class="aware-preview">${escapeHtml(block)}</pre>
      <div class="modal-actions">
        <button class="cancel" id="aware-cancel" type="button">Close</button>
        ${info.wired ? '<button class="cancel" id="aware-unwire" type="button">Unwire</button>' : ''}
        <button class="confirm" id="aware-apply" type="button">${info.wired ? 'Update' : 'Wire up'}</button>
      </div>
    </div>`;
  const close = () => backdrop.remove();
  document.body.appendChild(backdrop);
  backdrop.querySelector('#aware-cancel').onclick = close;
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });

  backdrop.querySelector('#aware-apply').onclick = async () => {
    close();
    try {
      const result = await bridge.setupProject(state.workspace, {});
      const wrote = (result.files || []).map((f) => `${f.path} (${f.action})`).join(', ');
      toast(`Agents aware: ${wrote}`, 'ok');
    } catch (err) {
      toast(`Could not wire awareness: ${err.message}`, 'err');
    }
    await refreshAwarenessState();
  };

  const unwire = backdrop.querySelector('#aware-unwire');
  if (unwire) {
    unwire.onclick = async () => {
      close();
      try {
        await bridge.setupProject(state.workspace, { unwire: true });
        toast('Agent awareness removed', 'ok');
      } catch (err) {
        toast(`Could not unwire: ${err.message}`, 'err');
      }
      await refreshAwarenessState();
    };
  }
}

/** Apply a chosen workspace directory. */
async function useWorkspace(dir) {
  try {
    const result = await bridge.setWorkspace(dir);
    state.workspace = result.project || result.workspace;
    state.graphsDir = result.graphsDir || '.';
    state.tabs = [];
    state.active = null;
    editor.setValue('');
    Object.assign(state.config, result);
    applyWorkspaceLabels();
    await refreshTree();
    refreshAwarenessState();
    // Sessions are location-scoped, so start a fresh one for the new workspace.
    if (agent) {
      agent.reset();
      renderChatEmpty();
      agent.connect(state.config, state.workspace, parseModelValue($('agent-model').value));
    }
    toast(`Workspace: ${result.workspace}`, 'ok');
  } catch (err) {
    toast(`Cannot open: ${err.message}`, 'err');
    throw err;
  }
}

/**
 * Workspace picker: browse folders, create one, or hand off to the desktop's
 * own chooser. Browsing is rooted anywhere so a brand-new project folder can be
 * made without leaving the editor.
 */
async function openWorkspaceModal() {
  let current = state.workspace;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal modal-lg">
      <h3>Open project</h3>
      <p>Pick the project root. Diagrams live in a directory inside it.</p>
      <div class="dir-bar">
        <button class="mini-btn" id="dir-up" type="button" title="Parent folder">↑</button>
        <button class="mini-btn" id="dir-home" type="button" title="Home folder">~</button>
        <input id="dir-path" class="dir-path" spellcheck="false" aria-label="Folder path" />
        <button class="mini-btn labeled" id="dir-go" type="button">Go</button>
        <button class="mini-btn" id="dir-refresh" type="button" title="Refresh">⟳</button>
      </div>
      <div class="dir-shortcuts" id="dir-shortcuts"></div>
      <div class="dir-list" id="dir-list"></div>
      <div class="setup-row">
        <label class="ctx-toggle">
          <input type="checkbox" id="dir-setup" checked />
          <span id="dir-setup-label">Set up for diagrams</span>
        </label>
        <span class="setup-note" id="dir-setup-note"></span>
      </div>
      <div class="dir-foot">
        <button class="mini-btn labeled" id="dir-new" type="button">New folder…</button>
        <button class="mini-btn labeled" id="dir-native" type="button" hidden>System dialog…</button>
        <span class="spacer"></span>
        <button class="cancel" id="dir-cancel" type="button">Cancel</button>
        <button class="confirm" id="dir-use" type="button">Use this project</button>
      </div>
    </div>`;

  const close = () => backdrop.remove();
  const listEl = backdrop.querySelector('#dir-list');
  const pathEl = backdrop.querySelector('#dir-path');
  const upBtn = backdrop.querySelector('#dir-up');
  const shortcutsEl = backdrop.querySelector('#dir-shortcuts');
  let parent = null;

  async function load(path) {
    listEl.innerHTML = '<div class="dir-empty">Loading…</div>';
    let data;
    try {
      data = await bridge.dirs(path);
    } catch (err) {
      listEl.innerHTML = `<div class="dir-empty err">${escapeHtml(err.message)}</div>`;
      return;
    }
    current = data.path;
    parent = data.parent;
    pathEl.value = data.path;
    upBtn.disabled = !parent;
    listEl.innerHTML = '';
    shortcutsEl.innerHTML = '';
    for (const item of data.shortcuts || []) {
      const button = document.createElement('button');
      button.className = 'mini-btn labeled';
      button.type = 'button';
      button.textContent = item.name;
      button.onclick = () => load(item.path);
      shortcutsEl.appendChild(button);
    }
    if (!data.dirs.length) {
      listEl.innerHTML = '<div class="dir-empty">No sub-folders here. Name one below, or use this folder.</div>';
    }
    for (const entry of data.dirs) {
      const row = document.createElement('div');
      row.className = `dir-item${entry.hidden ? ' hidden-dir' : ''}`;
      row.innerHTML = '<svg viewBox="0 0 24 24" class="ti-icon"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
        + `<span>${escapeHtml(entry.name)}</span>`;
      row.onclick = () => load(entry.path);
      listEl.appendChild(row);
    }
    refreshSetupHint().catch(() => {});
  }

  upBtn.onclick = () => parent && load(parent);
  backdrop.querySelector('#dir-home').onclick = () => load('');
  backdrop.querySelector('#dir-refresh').onclick = () => load(current);
  backdrop.querySelector('#dir-go').onclick = () => load(pathEl.value.trim());
  pathEl.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); load(pathEl.value.trim()); } };

  backdrop.querySelector('#dir-new').onclick = async () => {
    const name = await promptModal({
      title: 'New folder',
      label: `Create a folder inside ${current}`,
      value: 'new-project',
    });
    if (!name) return;
    try {
      const created = await bridge.mkdir(current, name);
      await refreshTree();
      await load(created.path);
      setStatusMsg(`created ${created.path}`);
    } catch (err) {
      toast(`Could not create folder: ${err.message}`, 'err');
    }
  };

  const nativeBtn = backdrop.querySelector('#dir-native');
  if (state.config?.nativePicker) {
    nativeBtn.hidden = false;
    nativeBtn.onclick = async () => {
      nativeBtn.disabled = true;
      nativeBtn.textContent = 'Waiting…';
      try {
        const picked = await bridge.pickDirectory(current);
        if (picked?.path) { close(); await useWorkspace(picked.path); }
      } catch (err) {
        toast(`System dialog failed: ${err.message}`, 'err');
      } finally {
        nativeBtn.disabled = false;
        nativeBtn.textContent = 'System dialog…';
      }
    };
  }

  backdrop.querySelector('#dir-cancel').onclick = close;

  // The checkbox defaults from what is already in the folder, so a fresh
  // project gets set up in one gesture while a real project is never edited
  // without a deliberate tick.
  const setupBox = backdrop.querySelector('#dir-setup');
  const setupNote = backdrop.querySelector('#dir-setup-note');
  async function refreshSetupHint() {
    try {
      const state_ = await bridge.setupProject(current, { preview: true });
      const files = state_.files || [];
      const wired = state_.wired;
      const willCreate = !state_.graphsExisted;
      const parts = [];
      parts.push(willCreate ? `will create ${state_.graphsDir}/` : `diagrams: ${state_.graphsDir}/`);
      parts.push(wired ? 'agents already aware' : 'will make agents aware');
      setupNote.textContent = parts.join(' · ');
      setupBox.checked = !wired || willCreate;
      setupBox.dataset.wired = wired ? '1' : '';
    } catch (err) {
      setupNote.textContent = err.message;
    }
  }

  backdrop.querySelector('#dir-use').onclick = async () => {
    const setUp = setupBox.checked;
    close();
    if (setUp) {
      try {
        const result = await bridge.setupProject(current, {});
        const created = result.graphsCreated ? `created ${result.graphsDir}/` : `diagrams in ${result.graphsDir}/`;
        setStatusMsg(
          `${created} · ${result.wired ? 'agents aware' : 'awareness not written'}`,
        );
      } catch (err) {
        toast(`Setup failed: ${err.message}`, 'err');
      }
    }
    await useWorkspace(current).catch(() => {});
  };
  backdrop.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });

  document.body.appendChild(backdrop);
  await load(current);
}

async function editLedger() {
  const tab = findTab(state.active);
  if (!tab || !tab.path) { toast('Save the diagram first', 'warn'); return; }
  const path = ledgerPathFor(tab.path);
  let current = '';
  try { current = (await bridge.read(path)).content; } catch (_) { current = '# Design gaps\n\n## Open questions\n\n- \n'; }
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h3>Edit gap ledger</h3>
      <p>${escapeHtml(path)}</p>
      <textarea id="modal-text">${escapeHtml(current)}</textarea>
      <div class="modal-actions">
        <button class="cancel">Cancel</button>
        <button class="confirm">Save</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const done = () => backdrop.remove();
  backdrop.querySelector('.cancel').onclick = done;
  backdrop.querySelector('.confirm').onclick = async () => {
    const text = backdrop.querySelector('#modal-text').value;
    try {
      await bridge.write(path, text);
      done();
      await refreshTree();
      loadLedger(tab);
      toast('Ledger saved', 'ok');
    } catch (err) { toast(`Save failed: ${err.message}`, 'err'); }
  };
}

function confirmDiscard(name) {
  return window.confirm(`“${name}” has unsaved changes. Close anyway?`);
}

// ── templates & status ─────────────────────────────────────────────────────
const TEMPLATES = [
  { name: 'Flowchart', desc: 'Process with a decision', source: 'flowchart TD\n    A[Start] --> B{Decision}\n    B -->|yes| C[Do work]\n    B -->|no| D[Stop]\n    C --> E[Done]\n    D --> E\n' },
  { name: 'Error paths', desc: 'Happy path plus recovery', source: 'flowchart TD\n    Start([Request]) --> Parse{Valid?}\n    Parse -->|no| Reject[400 Bad request]\n    Parse -->|yes| Call[Call service]\n    Call -->|timeout| Retry{Attempts < 3?}\n    Retry -->|yes| Call\n    Retry -->|no| Fail[503 Unavailable]\n    Call -->|ok| Save[(Persist)]\n    Save --> Respond[200 OK]\n' },
  { name: 'State machine', desc: 'Lifecycle of an entity', source: 'stateDiagram-v2\n    [*] --> Draft\n    Draft --> Review: submit\n    Review --> Draft: request changes\n    Review --> Published: approve\n    Published --> Archived: archive\n    Archived --> [*]\n' },
  { name: 'Sequence', desc: 'Interaction between parts', source: 'sequenceDiagram\n    participant U as User\n    participant A as API\n    participant D as Database\n    U->>A: POST /graphs\n    A->>D: insert graph\n    D-->>A: id\n    A-->>U: 201 Created\n' },
  { name: 'Codebase map', desc: 'Systems and boundaries', source: 'flowchart LR\n    subgraph Client\n        UI[Web UI]\n        CLI[CLI]\n    end\n    subgraph Server\n        API[HTTP API]\n        Core[Core services]\n    end\n    subgraph Data\n        DB[(Database)]\n        FS[(Files)]\n    end\n    UI --> API\n    CLI --> API\n    API --> Core\n    Core --> DB\n    Core --> FS\n' },
  { name: 'Data model', desc: 'Entities and relations', source: 'erDiagram\n    PROJECT ||--o{ GRAPH : contains\n    GRAPH ||--o{ REVISION : has\n    REVISION }o--|| AUTHOR : written_by\n' },
];

function renderTemplates() {
  const host = $('template-grid');
  if (!host) return;
  host.innerHTML = '';
  for (const template of TEMPLATES) {
    const button = document.createElement('button');
    button.innerHTML = `<strong>${escapeHtml(template.name)}</strong><span>${escapeHtml(template.desc)}</span>`;
    button.onclick = () => {
      openUntitled(template.source);
      scheduleRender(0);
    };
    host.appendChild(button);
  }
}

let statusTimer = null;
function setStatusMsg(text) {
  $('status-msg').textContent = text;
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => { $('status-msg').textContent = ''; }, 2600);
}

function toast(message, kind = '', actions = []) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div>${escapeHtml(message)}</div>`;
  if (actions.length) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;margin-top:8px';
    for (const action of actions) {
      const button = document.createElement('button');
      button.className = 'mini-btn';
      button.textContent = action.label;
      button.onclick = () => { action.onClick(); el.remove(); };
      row.appendChild(button);
    }
    el.appendChild(row);
  }
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), actions.length ? 9000 : 3600);
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

boot().catch((err) => {
  console.error(err);
  toast(`Startup failed: ${err.message}`, 'err');
});

window.__mermaidStudio = {
  state,
  bridge,
  oc,
  get agent() { return agent; },
  get editor() { return editor; },
  sendChat,
  renderChat,
  analyzeGraph,
  markdownToHtml,
  handleNotice,
  loadModels,
  openWorkspaceModal,
  openModelPalette,
  setModelRef,
  modelEntries,
  composerCopy,
  get blocks() { return state.pendingBlocks; },
};
