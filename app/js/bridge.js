// bridge.js — thin client for the local bridge and the proxied OpenCode API.

async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data && data.error) message = data.error;
    } catch (_) { /* not json */ }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const bridge = {
  config: () => request('GET', '/api/config'),
  tree: () => request('GET', '/api/fs/tree'),
  read: (path) => request('GET', `/api/fs/file?path=${encodeURIComponent(path)}`),
  write: (path, content) => request('PUT', '/api/fs/file', { path, content }),
  remove: (path) => request('DELETE', `/api/fs/file?path=${encodeURIComponent(path)}`),
  move: (from, to) => request('POST', '/api/fs/move', { from, to }),
  dirs: (path) => request('GET', `/api/fs/dirs?path=${encodeURIComponent(path || '')}`),
  mkdir: (path, name) => request('POST', '/api/fs/mkdir', { path, name }),
  pickDirectory: (start) => request('POST', '/api/pick-directory', { start }),
  setWorkspace: (dir) => request('POST', '/api/workspace', { dir }),
  focus: (path) => request('POST', '/api/focus', { path }),
  openInOS: (path) => request('POST', '/api/open', { path }),

  /** Subscribe to bridge events (file changes, focus requests). */
  subscribe(handlers = {}, onStatus) {
    const source = new EventSource('/api/events');
    const names = ['ready', 'file-changed', 'file-created', 'file-deleted',
      'workspace-changed', 'focus'];
    for (const name of names) {
      source.addEventListener(name, (event) => {
        const handler = handlers[name];
        if (!handler) return;
        let data = {};
        try { data = JSON.parse(event.data); } catch (_) { /* ignore */ }
        handler(data);
      });
    }
    if (onStatus) {
      source.onopen = () => onStatus(true);
      source.onerror = () => onStatus(false);
    }
    return source;
  },
};

/** OpenCode API, proxied by the bridge (auth + SSE handled server-side). */
export const oc = {
  async call(path, { method = 'GET', body } = {}) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`/oc${path}`, opts);
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try { const d = await res.json(); if (d && d.error) message = d.error; } catch (_) {}
      throw new Error(message);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  },

  agents: () => oc.call('/api/agent'),
  models: () => oc.call('/api/model'),
  defaultModel: () => oc.call('/api/model/default'),
  createSession: (payload) => oc.call('/api/session', { method: 'POST', body: payload }),
  switchAgent: (id, agent) => oc.call(`/api/session/${id}/agent`, { method: 'POST', body: { agent } }),
  switchModel: (id, model) => oc.call(`/api/session/${id}/model`, { method: 'POST', body: { model } }),
  prompt: (id, payload) => oc.call(`/api/session/${id}/prompt`, { method: 'POST', body: payload }),
  context: (id) => oc.call(`/api/session/${id}/context`),
  interrupt: (id) => oc.call(`/api/session/${id}/interrupt`, { method: 'POST', body: {} }),
  sessions: () => oc.call('/api/session'),

  /** Live server event stream; yields parsed events. */
  subscribe(onEvent, onStatus) {
    const source = new EventSource('/oc/api/event');
    source.onmessage = (event) => {
      let parsed = null;
      try { parsed = JSON.parse(event.data); } catch (_) { return; }
      onEvent(parsed);
    };
    if (onStatus) {
      source.onopen = () => onStatus(true);
      source.onerror = () => onStatus(false);
    }
    return source;
  },
};

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
