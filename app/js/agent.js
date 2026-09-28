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

  let turn = null;            // see beginTurn()
  let lastRequest = null;     // { text, context } for Retry
  let assistantCount = 0;     // assistant messages seen in the session so far

  const modelLabel = () => (model ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ''}` : 'default model');
  const shortId = () => (sessionId ? sessionId.replace(/^ses_/, '').slice(0, 6) : '');
  const readyLabel = () => `ready · ${modelLabel()}${shortId() ? ` · ${shortId()}` : ''}`;
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

  async function createFreshSession(title) {
    const payload = {
      title: title || 'Graph Engineering',
      agent: AGENT_ID,
      location: { directory },
    };
    if (model) payload.model = model;
    const created = await oc.createSession(payload);
    sessionId = created.data.id;
    await oc.switchAgent(sessionId, AGENT_ID).catch(() => {});
    if (model) await oc.switchModel(sessionId, model).catch(() => {});
    return sessionId;
  }

  /** Reuse the newest session for this workspace, unless `force` starts a new one. */
  async function ensureSession({ force = false } = {}) {
    if (sessionId) return sessionId;
    if (!force) {
      const reused = await findReusableSession();
      if (reused) {
        sessionId = reused;
        await oc.switchAgent(sessionId, AGENT_ID).catch(() => {});
        if (model) await oc.switchModel(sessionId, model).catch(() => {});
        return sessionId;
      }
    }
    return createFreshSession();
  }

  /** Start a brand-new conversation, abandoning the current one. */
  async function newSession(title) {
    sessionId = null;
    turn = null;
    lastRequest = null;
    setBusy(false);
    notice(null);
    if (logEl) logEl.innerHTML = '';
    try {
      await createFreshSession(title);
      setStatus(readyLabel());
      startStream();
      return sessionId;
    } catch (err) {
      setStatus(`offline · ${err.message}`);
      return null;
    }
  }

  async function connect(config, workspace, selectedModel) {
    directory = workspace || config?.workspace || '/';
    if (selectedModel) model = selectedModel;
    setStatus('connecting…');

    let available = hasAgent(config);
    if (!available) {
      // The agent list is the only way to know whether the agent exists: creating
      // a session with an unknown agent id succeeds regardless, so the call tells
      // us nothing. Refresh rather than report a stale "not installed".
      const fresh = await oc.agents().catch(() => null);
      const list = fresh?.data || [];
      if (list.length) {
        if (config?.oc) config.oc.agents = list;
        available = list.some((agent) => agent.id === AGENT_ID);
      }
    }

    try {
      await ensureSession();
      setStatus(available ? readyLabel() : `${AGENT_ID} not installed`);
      startStream();
    } catch (err) {
      setStatus(`offline · ${err.message}`);
    }
  }

  function hasAgent(config) {
    return (config?.oc?.agents || []).some((agent) => agent.id === AGENT_ID);
  }

  async function setModel(next) {
    model = next || null;
    if (sessionId) {
      try { await oc.switchModel(sessionId, model); } catch (_) { /* surface via status */ }
    }
    setStatus(readyLabel());
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
    // turnAssistantCount lets us tell "our" reply apart from earlier messages,
    // without comparing clocks across processes.
    turn = {
      startedAt: now, lastContentAt: now, lastKey: null, turnAssistantCount: assistantCount,
      done: false, stalled: false, notifiedEmpty: false,
    };
    notice(null);
  }

  async function refresh() {
    if (!sessionId) return;
    const result = await oc.context(sessionId);
    const messages = result?.data || [];
    if (onMessages) onMessages(messages);

    const assistants = messages.filter((m) => m.type === 'assistant');
    const last = assistants[assistants.length - 1];
    const key = contentKey(last);
    const lastCompleted = Boolean(last && last.time?.completed);
    const isNewAssistant = assistants.length > (turn ? turn.turnAssistantCount : 0);
    assistantCount = assistants.length;

    let busy;
    if (turn && !turn.done) {
      const decision = turnDecision({
        active: true, done: false, isNewAssistant, lastCompleted,
        contentKey: key, lastKey: turn.lastKey, lastContentAt: turn.lastContentAt,
        now: Date.now(), stallMs, notifiedEmpty: turn.notifiedEmpty,
      });
      turn.lastContentAt = decision.lastContentAt;
      turn.lastKey = key;
      turn.done = decision.done;
      busy = decision.busy;
      if (decision.stalled !== turn.stalled) {
        turn.stalled = decision.stalled;
        notice(decision.stalled
          ? { type: 'stalled', model: modelLabel(), elapsed: Math.round((Date.now() - turn.lastContentAt) / 1000) }
          : null);
      }
      if (decision.empty && !turn.notifiedEmpty) {
        turn.notifiedEmpty = true;
        notice({ type: 'empty', model: modelLabel() });
      }
    } else {
      // No turn of ours: adopt the session's own notion of activity.
      busy = turn ? false : Boolean(last && !lastCompleted);
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
    connect, send, retry, stop, reset, newSession, disconnect, setModel, refresh,
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
 * Decide how an in-flight turn is progressing. A turn is only "empty" once it
 * has actually produced a reply and that reply carried no content — never just
 * because the assistant message has not appeared yet.
 * @returns {{progressed:boolean,lastContentAt:number,done:boolean,busy:boolean,stalled:boolean,empty:boolean}}
 */
export function turnDecision({
  active, done, isNewAssistant, lastCompleted,
  contentKey: key, lastKey, lastContentAt, now, stallMs, notifiedEmpty,
}) {
  const progressed = key !== lastKey;
  const at = progressed ? now : lastContentAt;

  let finished = done;
  let busy = false;
  if (active && !done) {
    if (isNewAssistant && lastCompleted) { finished = true; busy = false; }
    else busy = true; // still waiting — no assistant message yet, or one in flight
  }

  return {
    progressed,
    lastContentAt: at,
    done: finished,
    busy,
    stalled: Boolean(busy && now - at > stallMs),
    empty: Boolean(finished && !key && !notifiedEmpty),
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
