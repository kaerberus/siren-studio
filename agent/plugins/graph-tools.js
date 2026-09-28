/**
 * Mermaid Studio tools for OpenCode.
 *
 * Exactly two tools, and only because the built-ins genuinely cannot do them:
 *
 *   graph_validate  the real Mermaid parser is the only parse oracle in the
 *                   system; the bridge relays a request to the open editor and
 *                   returns its verdict. `read` sees the source, but nothing
 *                   built in can tell you whether it parses.
 *   graph_focus     tells the editor which diagram to show. Nothing built in
 *                   can drive the editor's UI.
 *
 * Deliberately NOT here (they were wrappers over built-ins and added noise to
 * every agent's tool list): graph_list, graph_read, graph_write. Use `glob`,
 * `read` and `write` instead — the editor's file watcher reloads on any write.
 *
 * The editor is a separate local process. This plugin finds it through, in
 * order: the `url` plugin option, `$MERMAID_STUDIO_URL`, or the registration
 * file the bridge writes on startup (default http://127.0.0.1:8777).
 *
 * Written as plain JavaScript with no imports, because a local plugin file has
 * no node_modules and OpenCode only requires the default export to be an object
 * with an `id` and a `setup` (or `effect`) function.
 */
const DEFAULT_URL = 'http://127.0.0.1:8777';

// Only these agents may use the tools. Enforced two ways: a permission deny for
// everyone else (see the global opencode.jsonc), plus this guard when the
// runtime tells us who is calling.
const GRAPH_AGENTS = ['graph-engineer', 'graph-reconcile'];

function stripSlash(url) {
  return String(url).replace(/\/+$/, '');
}

/** Where is the editor bridge listening? */
async function discoverUrl(options = {}) {
  if (options.url) return stripSlash(options.url);
  const env = (typeof process !== 'undefined' && process.env) || {};
  if (env.MERMAID_STUDIO_URL) return stripSlash(env.MERMAID_STUDIO_URL);
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const stateHome = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    const file = path.join(stateHome, 'opencode-mermaid', 'bridge.json');
    const registration = JSON.parse(await fs.readFile(file, 'utf8'));
    if (registration && registration.url) return stripSlash(registration.url);
  } catch (_) {
    // No registration file: fall through to the default port.
  }
  return DEFAULT_URL;
}

async function api(url, route, init) {
  let response;
  try {
    response = await fetch(url + route, init);
  } catch (err) {
    throw new Error(
      `Mermaid Studio is not reachable at ${url}. Start it with "python3 start.py" `
      + `from the opencode-mermaid checkout. (${err.message})`,
    );
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  if (!response.ok) {
    const detail = (data && data.error) || `HTTP ${response.status}`;
    throw new Error(String(detail));
  }
  return data;
}

/** Returns a refusal message, or null when the caller is allowed. */
function refuseCaller(context) {
  const caller = context && context.agent;
  if (!caller) return null; // runtime did not tell us; permissions still apply
  if (GRAPH_AGENTS.includes(String(caller))) return null;
  return `graph tools are only available to ${GRAPH_AGENTS.join(' and ')}, not ${caller}.`;
}

export default {
  id: 'graph-tools',
  async setup(ctx) {
    const options = ctx.options || {};
    let cachedUrl = null;
    const url = async () => {
      if (!cachedUrl) cachedUrl = await discoverUrl(options);
      return cachedUrl;
    };

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: 'graph',
        description: 'Mermaid diagrams in the workspace open in Mermaid Studio',
      });

      const common = { namespace: 'graph', codemode: true };

      editor.add({
        name: 'validate',
        description:
          'Validate Mermaid source. Always runs a structural lint; when the editor is open it '
          + 'is checked with the real Mermaid parser and that verdict wins. Pass `path` to '
          + 'validate a diagram in the workspace, or `source` for text you have not written yet. '
          + 'Use this after authoring or editing a diagram.',
        input: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Diagram path relative to the workspace.' },
            source: { type: 'string', description: 'Mermaid source to validate instead.' },
          },
          additionalProperties: false,
        },
        options: common,
        execute: async (input, context) => {
          const refusal = refuseCaller(context);
          if (refusal) return { content: refusal };

          const base = await url();
          const payload = {};
          if (typeof input.source === 'string') payload.source = input.source;
          else if (input.path) payload.path = String(input.path).replace(/^\/+/, '');
          else return { content: 'Pass either `path` or `source`.' };

          const result = await api(base, '/api/validate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const errors = (result.errors || [])
            .map((e) => `- line ${e.line}: ${e.message}`).join('\n');
          const warnings = (result.warnings || [])
            .map((e) => `- line ${e.line}: ${e.message}`).join('\n');
          const head = result.ok
            ? `Valid (checked by ${result.checked_by}).`
            : `Invalid (checked by ${result.checked_by}).`;
          const parts = [head];
          if (errors) parts.push(`Errors:\n${errors}`);
          if (warnings) parts.push(`Warnings:\n${warnings}`);
          return { content: parts.join('\n\n') };
        },
      });

      editor.add({
        name: 'focus',
        description:
          'Ask the Mermaid Studio editor to open a diagram and bring it to the front. Use it '
          + 'to show the user the diagram you are talking about. Requires the editor to be open.',
        input: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Diagram path relative to the workspace.' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        options: common,
        execute: async (input, context) => {
          const refusal = refuseCaller(context);
          if (refusal) return { content: refusal };

          const base = await url();
          const path = String(input.path || '').replace(/^\/+/, '');
          const result = await api(base, '/api/focus', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path }),
          });
          return {
            content: result.delivered
              ? `Opened ${path} in the editor.`
              : `Sent a request to open ${path}, but no editor appears to be connected.`,
          };
        },
      });
    });
  },
};
