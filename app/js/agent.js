// agent.js — Graph Engineer chat backed by an OpenCode session.
//
// Responsibilities:
//  - reuse (or create) one session per workspace, pinned to the chosen model
//  - send prompts with the current diagram / ledger inlined
//  - poll the session context and report messages
//  - distinguish "thinking" from "hung": a turn that produces no output for
//    `stallMs` is reported as stalled so the UI can offer Retry / Stop
//  - report a completed-but-empty turn (the model answered with nothing)

import { oc } from './bridge.js';

const AGENT_ID = 'graph-engineer';
const POLL_MS = 1500;
const STALL_MS = 45000;

export function createAgent({
  logEl, onStatus, onBusy, onMessages, onNotice, stallMs = STALL_MS,
}) {
  let sessionId = null;
  let directory = null;
  let model = null;
  let stream = null;
  let pollTimer = null;
  let refreshTimer = null;
  let running = false;

  let turn = null;            // { startedAt, lastContentAt, lastKey, stalled, notifiedEmpty }
  let lastRequest = null;     // { text, context } for Retry

  const modelLabel = () => (model ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ''}` : 'default model');
  const notice = (value) => { if (onNotice) onNotice(value); };

  function setStatus(text) { if (onStatus) onStatus(text); }
  function setBusy(value) {
    running = value;
    if (onBusy) onBusy(value);
    if (value) schedulePoll(); else stopPoll();
  }

  // ── session lifecycle ────────────────────────────────────────────────────
  async function findReusableSession() {
    try {
      const listing = await oc.sessions();
      const items = listing?.data || [];
      const candidates = items
        .filter((s) => s.agent === AGENT_ID
          && !s.parentID
          && s.location?.directory === directory)
        .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
      return candidates.length ? candidates[0].id : null;
    } catch (_) {
      return null;
    }
  }

  async function ensureSession() {
    if (sessionId) return sessionId;
    const reused = await findReusableSession();
    if (reused) {
      sessionId = reused;
      if (model) await oc.switchModel(sessionId, model).catch(() => {});
      await oc.switchAgent(sessionId, AGENT_ID).catch(() => {});
      return sessionId;
    }
    const payload = { title: 'Graph Engineering', agent: AGENT_ID, location: { directory } };
    if (model) payload.model = model;
    const created = await oc.createSession(payload);
    sessionId = created.data.id;
    await oc.switchAgent(sessionId, AGENT_ID).catch(() => {});
    if (model) await oc.switchModel(sessionId, model).catch(() => {});
    return sessionId;
  }

  async function connect(config, workspace, selectedModel) {
    directory = workspace || config?.workspace || '/';
    if (selectedModel) model = selectedModel;
    setStatus('connecting…');
    const available = (config?.oc?.agents || []).some((a) => a.id === AGENT_ID);
    try {
      await ensureSession();
      setStatus(available ? `ready · ${modelLabel()}` : `${AGENT_ID} not installed`);
      startStream();
    } catch (err) {
      setStatus(`offline · ${err.message}`);
    }
  }

  async function setModel(next) {
    model = next || null;
    if (sessionId) {
      try { await oc.switchModel(sessionId, model); } catch (_) { /* surface via status */ }
    }
    setStatus(`ready · ${modelLabel()}`);
  }

  function startStream() {
    if (stream) return;
    stream = oc.subscribe((event) => {
      const type = event?.type || '';
      if (!type.startsWith('session.') && !type.startsWith('message.')) return;
      const blob = JSON.stringify(event.data || {});
      if (sessionId && blob.includes(sessionId)) scheduleRefresh();
    });
  }

  function scheduleRefresh(delay = 180) {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh().catch(() => {});
    }, delay);
  }

  function schedulePoll() {
    stopPoll();
    pollTimer = setInterval(() => refresh().catch(() => {}), POLL_MS);
  }

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ── turn tracking ────────────────────────────────────────────────────────
  function beginTurn() {
    const now = Date.now();
    turn = { startedAt: now, lastContentAt: now, lastKey: null, stalled: false, notifiedEmpty: false };
    notice(null);
  }

  async function refresh() {
    if (!sessionId) return;
    const result = await oc.context(sessionId);
    const messages = result?.data || [];
    if (onMessages) onMessages(messages);

    const assistants = messages.filter((m) => m.type === 'assistant');
    const last = assistants[assistants.length - 1];
    const busy = Boolean(last && !last.time?.completed);
    const key = contentKey(last);

    if (turn) {
      const decision = turnDecision({
        busy, contentKey: key, lastKey: turn.lastKey,
        lastContentAt: turn.lastContentAt, now: Date.now(),
        stallMs, notifiedEmpty: turn.notifiedEmpty,
      });
      turn.lastContentAt = decision.lastContentAt;
      turn.lastKey = key;
      if (decision.progressed && key) turn.sawContent = true;

      if (decision.stalled !== turn.stalled) {
        turn.stalled = decision.stalled;
        notice(decision.stalled
          ? { type: 'stalled', model: modelLabel(), elapsed: Math.round((Date.now() - turn.lastContentAt) / 1000) }
          : null);
      }
      if (decision.empty) {
        turn.notifiedEmpty = true;
        notice({ type: 'empty', model: modelLabel() });
      }
    }

    if (busy !== running) setBusy(busy);
  }

  // ── sending ──────────────────────────────────────────────────────────────
  function buildPrompt(text, context) {
    const parts = [text.trim()];
    if (context?.graph && context.attachGraph) {
      parts.push(`Current diagram (${context.graphPath || 'untitled'}):`);
      parts.push('```mermaid\n' + context.graph.trim() + '\n```');
    }
    if (context?.gaps && context.attachGaps) {
      parts.push(`Current gap ledger (${context.gapsPath || 'none'}):`);
      parts.push('```markdown\n' + context.gaps.trim() + '\n```');
    }
    return parts.join('\n\n');
  }

  async function send(text, context = {}) {
    if (!text || !text.trim()) return;
    lastRequest = { text, context };
    await ensureSession();
    beginTurn();
    setBusy(true);
    await oc.prompt(sessionId, { text: buildPrompt(text, context), delivery: 'steer' });
    scheduleRefresh(120);
  }

  async function retry() {
    if (!lastRequest) return;
    notice(null);
    await send(lastRequest.text, lastRequest.context);
  }

  async function stop() {
    if (!sessionId) return;
    await oc.interrupt(sessionId).catch(() => {});
    if (turn) { turn.stalled = false; turn.notifiedEmpty = true; }
    notice(null);
    setBusy(false);
    scheduleRefresh(120);
  }

  function reset() {
    sessionId = null;
    turn = null;
    lastRequest = null;
    setBusy(false);
    notice(null);
    if (logEl) logEl.innerHTML = '';
  }

  function disconnect() {
    if (stream) { stream.close(); stream = null; }
    stopPoll();
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  }

  return {
    connect, send, retry, stop, reset, disconnect, setModel, refresh,
    get sessionId() { return sessionId; },
    get busy() { return running; },
    get model() { return model; },
  };
}

// ── pure helpers (unit-tested) ─────────────────────────────────────────────

/** Signature of an assistant message's output; null when it has produced none. */
export function contentKey(message) {
  if (!message) return null;
  const parts = message.content || [];
  const texts = parts.filter((p) => p.type === 'text').map((p) => p.text || '');
  const tools = parts.filter((p) => p.type === 'tool');
  if (!texts.join('') && !tools.length) return null;
  return `${texts.join('').length}:${tools.length}:${tools.map((t) => t.name).join(',')}`;
}

/**
 * Decide how a turn is progressing.
 * @returns {{progressed:boolean,lastContentAt:number,stalled:boolean,empty:boolean}}
 */
export function turnDecision({
  busy, contentKey: key, lastKey, lastContentAt, now, stallMs, notifiedEmpty,
}) {
  const progressed = key !== lastKey;
  const at = progressed ? now : lastContentAt;
  return {
    progressed,
    lastContentAt: at,
    stalled: Boolean(busy && now - at > stallMs),
    empty: Boolean(!busy && !key && !notifiedEmpty),
  };
}

export function extractAssistant(message) {
  const text = [];
  const reasoning = [];
  const tools = [];
  for (const part of message.content || []) {
    if (part.type === 'text') text.push(part.text);
    else if (part.type === 'reasoning') reasoning.push(part.text);
    else if (part.type === 'tool') tools.push(part);
  }
  return {
    text: text.join(''),
    reasoning: reasoning.join(''),
    tools,
    completed: Boolean(message.time && message.time.completed),
  };
}

export function toolLabel(tool) {
  const status = tool.state?.status || 'pending';
  if (status === 'error') return `${tool.name} · error`;
  if (status === 'running') return `${tool.name} · running…`;
  if (status === 'completed') {
    const input = tool.state?.input || {};
    const hint = input.path || input.filePath || input.command || input.pattern || '';
    return `${tool.name}${hint ? ` · ${String(hint).slice(0, 64)}` : ''}`;
  }
  return `${tool.name} · streaming…`;
}
