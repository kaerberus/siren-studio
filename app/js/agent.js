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
  let configRef = null;       // the cached config, repaired with fresh agents
  let installed = null;       // true | false | null (unknown)
  let installedAt = 0;

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

    configRef = config;
    // The agent list is the only way to know whether the agent exists: creating a
    // session with an unknown agent id succeeds regardless, so the call tells us
    // nothing. Refresh rather than report a stale "not installed".
    const present = hasAgent(config) ? true : await refreshInstalled();

    try {
      await ensureSession();
      setStatus(present === false ? `${AGENT_ID} not installed` : readyLabel());
      startStream();
      // Replay the reused session's transcript now: the event stream only
      // reports activity that happens after we subscribe, so without this the
      // log stays empty on load and a reload looks like the history vanished.
      // It also seeds assistantCount, which beginTurn() uses as its baseline.
      await refresh().catch(() => {});
    } catch (err) {
      setStatus(`offline · ${err.message}`);
    }
  }

  function hasAgent(config) {
    return (config?.oc?.agents || []).some((agent) => agent.id === AGENT_ID);
  }

  /**
   * Is the agent installed? true / false / null when we could not find out.
   * Only ever reports false on positive evidence (a real, non-empty agent list
   * without it), so a failed or empty fetch never claims it is missing.
   */
  async function agentInstalled({ force = false } = {}) {
    if (!force && installed !== null && Date.now() - installedAt < 30_000) return installed;
    return refreshInstalled();
  }

  async function refreshInstalled() {
    try {
      const listing = await oc.agents();
      const list = listing?.data || [];
      if (!list.length) return installed;
      if (configRef?.oc) configRef.oc.agents = list;
      installed = list.some((agent) => agent.id === AGENT_ID);
      installedAt = Date.now();
    } catch (_) { /* leave the last known answer */ }
    return installed;
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

    // One OpenCode turn is several assistant messages — a step per tool call,
    // each with its own `completed` time — so "the last assistant finished" is
    // not the end of the turn. The session emits an `idle` message when it is
    // actually done; that is the signal, or the run would look finished after
    // the first step.
    const idle = endsWithIdle(messages);

    let busy;
    if (turn && !turn.done) {
      const decision = turnDecision({
        active: true, done: false, isNewAssistant, lastCompleted, idle,
        contentKey: key, lastKey: turn.lastKey, lastContentAt: turn.lastContentAt,
        now: Date.now(), stallMs, notifiedEmpty: turn.notifiedEmpty,
        visible: hasVisibleOutput(last), running: hasRunningTool(last),
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
      parts.push(attachmentHeader('diagram', context.graphPath));
      parts.push('```mermaid\n' + context.graph.trim() + '\n```');
    }
    if (context?.gaps && context.attachGaps) {
      parts.push(attachmentHeader('ledger', context.gapsPath));
      parts.push('```markdown\n' + context.gaps.trim() + '\n```');
    }
    return parts.join('\n\n');
  }

  async function send(text, context = {}) {
    if (!text || !text.trim()) return;
    if (await agentInstalled() === false) {
      // OpenCode accepts a session for an agent id it does not know, then fails
      // the turn asynchronously as AgentNotFound, leaving the session empty. Say
      // so here rather than let the stall notice blame the model.
      installed = null; // re-check next time, so Retry works after installing
      notice({ type: 'no-agent', agent: AGENT_ID });
      return;
    }
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

// The header lines `buildPrompt` writes before an inlined attachment. Declared
// once so the prompt builder and the transcript renderer cannot drift.
const ATTACHMENT_PREFIX = { diagram: 'Current diagram', ledger: 'Current gap ledger' };

/** Header line written before an attachment of `kind`. */
export function attachmentHeader(kind, path) {
  const fallback = kind === 'ledger' ? 'none' : 'untitled';
  return `${ATTACHMENT_PREFIX[kind]} (${path || fallback}):`;
}

/** Reverse of attachmentHeader: `{ kind, label }`, or null if not a header. */
export function parseAttachmentHeader(line) {
  const text = String(line).trimEnd();
  for (const [kind, prefix] of Object.entries(ATTACHMENT_PREFIX)) {
    const open = `${prefix} (`;
    if (text.startsWith(open) && text.endsWith('):')) {
      return { kind, label: text.slice(open.length, -2) };
    }
  }
  return null;
}

/** Strip the ```lang fence `buildPrompt` wrapped an attachment body in. */
function unfence(text) {
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1] : trimmed;
}

/**
 * Split a stored user prompt into what the reader typed and the diagram /
 * ledger `buildPrompt` inlined after it, so the transcript can show the
 * question and fold the files away. Render-only: the model still receives the
 * whole prompt, including unsaved buffer edits.
 * @returns {{question: string, attachments: Array<{kind: string, label: string, source: string}>}}
 */
export function splitPrompt(text) {
  const question = [];
  const attachments = [];
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const header = parseAttachmentHeader(line);
    if (header) {
      current = { ...header, body: [] };
      attachments.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      question.push(line);
    }
  }
  return {
    question: question.join('\n').trim(),
    attachments: attachments.map(({ kind, label, body }) => ({
      kind, label, source: unfence(body.join('\n')),
    })),
  };
}

/**
 * Signature of everything an assistant message has produced: visible text,
 * streamed reasoning, and each tool's status and output length. Null only when
 * the message carries nothing at all.
 *
 * Reasoning is included because it is progress the model is making even though
 * the reader cannot see it yet. Using this as the stall timer's input is what
 * stops a long think from looking like a hang.
 */
export function contentKey(message) {
  if (!message) return null;
  const parts = message.content || [];
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text || '').join('');
  const reasoning = parts.filter((p) => p.type === 'reasoning').map((p) => p.text || '').join('');
  const tools = parts.filter((p) => p.type === 'tool');
  if (!text && !reasoning && !tools.length) return null;
  const toolKey = tools.map((tool) => {
    const state = tool.state || {};
    const output = typeof state.output === 'string' ? state.output.length : 0;
    return `${tool.name}:${state.status || ''}:${output}`;
  }).join(',');
  return `${text.length}:${reasoning.length}:${tools.length}:${toolKey}`;
}

/** Does the message hold anything the reader can actually see? */
export function hasVisibleOutput(message) {
  const parts = message?.content || [];
  return parts.some((p) => (p.type === 'text' && Boolean(p.text)) || p.type === 'tool');
}

/**
 * Is a tool still in flight? A running tool is a wait, not a hang: the model may
 * be mid-step, or it may have asked the user a question and be waiting on the
 * answer. Either way the editor must not offer Retry/Stop for it.
 */
export function hasRunningTool(message) {
  const parts = message?.content || [];
  return parts.some((p) => p.type === 'tool' && p.state?.status === 'running');
}

/**
 * Has the session gone idle since the last user message? OpenCode closes a turn
 * with an `idle` message after the final assistant message; scanning back to the
 * user message distinguishes "the turn is over" from "between two steps".
 */
export function endsWithIdle(messages) {
  const list = messages || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const type = list[i]?.type;
    if (type === 'idle') return true;
    if (type === 'user') return false;
  }
  return false;
}

/**
 * Decide how an in-flight turn is progressing.
 *
 * `contentKey` drives the stall timer (any change at all is progress), while
 * `visible` decides emptiness (reasoning-only output is still "no output"), and
 * `running` suppresses the stall entirely while a tool is in flight. A turn is
 * only finished once `idle` says the session is done *and* a completed assistant
 * has arrived: one turn emits many assistant messages, so completing the first
 * is not the end. It is "empty" once it finishes having produced nothing the
 * reader can see — never just because the assistant message has not appeared yet.
 * @returns {{progressed:boolean,lastContentAt:number,done:boolean,busy:boolean,stalled:boolean,empty:boolean}}
 */
export function turnDecision({
  active, done, isNewAssistant, lastCompleted, idle,
  contentKey: key, lastKey, lastContentAt, now, stallMs, notifiedEmpty,
  visible, running,
}) {
  const progressed = key !== lastKey;
  const at = progressed ? now : lastContentAt;

  let finished = done;
  let busy = false;
  if (active && !done) {
    if (isNewAssistant && lastCompleted && idle) { finished = true; busy = false; }
    else busy = true; // a step in flight, or one turn still running between steps
  }

  return {
    progressed,
    lastContentAt: at,
    done: finished,
    busy,
    stalled: Boolean(busy && !running && now - at > stallMs),
    empty: Boolean(finished && !visible && !notifiedEmpty),
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
