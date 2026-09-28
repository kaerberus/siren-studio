/**
 * Mermaid Studio tools for OpenCode.
 *
 * Gives the Graph Engineer (and any other agent) a typed handle on the
 * workspace that the Mermaid Studio editor is showing, so it can list, read,
 * write, validate and focus diagrams — and have the editor pick the change up
 * live.
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
const GRAPH_RE = /\.(mmd|mermaid)$/i;

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

function ledgerPath(path) {
  return path.replace(GRAPH_RE, '') + '.gaps.md';
}

function formatSize(bytes) {
  if (typeof bytes !== 'number') return '';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatDate(seconds) {
  if (!seconds) return '';
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
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
        name: 'list',
        description:
          'List the Mermaid diagrams in the workspace the editor has open, with size, '
          + 'last-modified time and whether each has a design-gap ledger. Use this before '
          + 'reading or writing, to see what already exists.',
        input: {
          type: 'object',
          properties: {
            dir: {
              type: 'string',
              description: 'Restrict to a subdirectory of the workspace (optional).',
            },
          },
          additionalProperties: false,
        },
        options: common,
        execute: async (input) => {
          const base = await url();
          const tree = await api(base, '/api/fs/tree');
          const entries = tree.entries || [];
          const prefix = input && input.dir
            ? `${String(input.dir).replace(/^\/+|\/+$/g, '')}/` : '';
          const graphs = entries.filter((entry) => entry.type === 'file'
            && GRAPH_RE.test(entry.name) && entry.path.startsWith(prefix));
          const ledgers = new Set(entries
            .filter((entry) => entry.type === 'file' && entry.name.endsWith('.gaps.md'))
            .map((entry) => entry.path));
          if (!graphs.length) {
            return { content: `No Mermaid diagrams found in ${tree.root}${prefix ? ` under ${prefix}` : ''}.` };
          }
          const lines = graphs.map((entry) => {
            const ledger = ledgers.has(ledgerPath(entry.path)) ? 'ledger' : 'no ledger';
            return `- ${entry.path} (${formatSize(entry.size)}, ${formatDate(entry.mtime)}, ${ledger})`;
          });
          return {
            content: `${graphs.length} diagram(s) in ${tree.root}:\n${lines.join('\n')}`,
          };
        },
      });

      editor.add({
        name: 'read',
        description:
          'Read a Mermaid diagram and its design-gap ledger (' + '<name>.gaps.md' + ') '
          + 'from the workspace. Returns the raw Mermaid source so you can reason about it.',
        input: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Diagram path relative to the workspace.' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        options: common,
        execute: async (input) => {
          const base = await url();
          const path = String(input.path || '').replace(/^\/+/, '');
          const diagram = await api(base, `/api/fs/file?path=${encodeURIComponent(path)}`);
          const parts = [`# ${path}\n\n\`\`\`mermaid\n${diagram.content.trim()}\n\`\`\``];
          try {
            const ledger = await api(base,
              `/api/fs/file?path=${encodeURIComponent(ledgerPath(path))}`);
            parts.push(`## Gap ledger (${ledgerPath(path)})\n\n${ledger.content.trim()}`);
          } catch (_) {
            parts.push('## Gap ledger\n\n(none yet)');
          }
          return { content: parts.join('\n\n') };
        },
      });

      editor.add({
        name: 'write',
        description:
          'Write Mermaid source to a diagram in the workspace, and optionally its design-gap '
          + 'ledger. The editor reloads the file immediately, so the user sees your change. '
          + 'Prefer giving the whole diagram, not a fragment.',
        input: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Diagram path relative to the workspace.' },
            content: { type: 'string', description: 'Complete Mermaid source.' },
            ledger: {
              type: 'string',
              description: 'Optional Markdown for the companion <name>.gaps.md ledger.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const base = await url();
          const path = String(input.path || '').replace(/^\/+/, '');
          const written = [];
          if (typeof input.content === 'string') {
            await context.progress({ status: `writing ${path}` });
            const result = await api(base, '/api/fs/file', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path, content: input.content }),
            });
            written.push(`${path} (${formatSize(result.size)})`);
          }
          if (typeof input.ledger === 'string') {
            const ledger = ledgerPath(path);
            await api(base, '/api/fs/file', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: ledger, content: input.ledger }),
            });
            written.push(ledger);
          }
          if (!written.length) {
            return { content: 'Nothing to write: pass `content` and/or `ledger`.' };
          }
          return { content: `Wrote ${written.join(' and ')}. The editor has reloaded it.` };
        },
      });

      editor.add({
        name: 'validate',
        description:
          'Validate Mermaid source. Always runs a structural lint; when the editor is open it '
          + 'is checked with the real Mermaid parser and that verdict wins. Pass `path` to '
          + 'validate a file in the workspace, or `source` for text you have not written yet.',
        input: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Diagram path relative to the workspace.' },
            source: { type: 'string', description: 'Mermaid source to validate instead.' },
          },
          additionalProperties: false,
        },
        options: common,
        execute: async (input) => {
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
        execute: async (input) => {
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
