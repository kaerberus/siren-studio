// agent.js — Graph Engineer chat backed by an OpenCode session.

import { oc } from './bridge.js';

const AGENT_ID = 'graph-engineer';
const POLL_MS = 1500;

export function createAgent({ logEl, onStatus, onBusy, onMessages }) {
  let sessionId = null;
  let directory = null;
  let stream = null;
  let pollTimer = null;
  let refreshTimer = null;
  let running = false;

  function setStatus(text) { if (onStatus) onStatus(text); }
  function setBusy(value) {
    running = value;
    if (onBusy) onBusy(value);
    if (value) schedulePoll(); else stopPoll();
  }

  async function ensureSession() {
    if (sessionId) return sessionId;
    const payload = {
      title: 'Graph Engineering',
      agent: AGENT_ID,
      location: { directory },
    };
    const created = await oc.createSession(payload);
    sessionId = created.data.id;
    await oc.switchAgent(sessionId, AGENT_ID).catch(() => {});
    return sessionId;
  }

  async function connect(config, workspace) {
    directory = workspace || config?.workspace || '/';
    setStatus('connecting…');
    const available = (config?.oc?.agents || []).some((a) => a.id === AGENT_ID);
    try {
      await ensureSession();
      if (!available) {
        setStatus(`session ready · ${AGENT_ID} not installed`);
      } else {
        setStatus(`ready · ${AGENT_ID}`);
      }
      startStream();
    } catch (err) {
      setStatus(`offline · ${err.message}`);
    }
  }

  function startStream() {
    if (stream) return;
    stream = oc.subscribe(
      (event) => {
        const type = event?.type || '';
        if (!type.startsWith('session.') && !type.startsWith('message.')) return;
        const blob = JSON.stringify(event.data || {});
        if (sessionId && blob.includes(sessionId)) scheduleRefresh();
      },
      () => { /* connection state changes are reflected by polling */ },
    );
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

  async function refresh() {
    if (!sessionId) return;
    const result = await oc.context(sessionId);
    const messages = result?.data || [];
    if (onMessages) onMessages(messages);
    const lastAssistant = [...messages].reverse().find((m) => m.type === 'assistant');
    const last = messages[messages.length - 1];
    const busy = Boolean(lastAssistant && !lastAssistant.time?.completed) && last?.type !== 'idle';
    if (busy !== running) setBusy(busy);
  }

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
    await ensureSession();
    const payload = {
      text: buildPrompt(text, context),
      delivery: 'steer',
    };
    setBusy(true);
    await oc.prompt(sessionId, payload);
    scheduleRefresh(120);
  }

  async function stop() {
    if (!sessionId) return;
    await oc.interrupt(sessionId).catch(() => {});
    setBusy(false);
    scheduleRefresh(120);
  }

  function reset() {
    sessionId = null;
    setBusy(false);
    if (logEl) logEl.innerHTML = '';
  }

  function disconnect() {
    if (stream) { stream.close(); stream = null; }
    stopPoll();
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  }

  return {
    connect, send, stop, reset, disconnect, refresh,
    get sessionId() { return sessionId; },
    get busy() { return running; },
  };
}

// ── message rendering helpers ──────────────────────────────────────────────

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
