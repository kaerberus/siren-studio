// editor.js — CodeMirror 5 wrapper with a Mermaid mode, linting and highlighting.

const CM = window.CodeMirror;

// ── Mermaid simple mode ────────────────────────────────────────────────────
const DIAGRAM_TYPES = [
  'flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'classDiagram-v2',
  'stateDiagram-v2', 'stateDiagram', 'erDiagram', 'journey', 'gantt', 'pie',
  'mindmap', 'timeline', 'gitGraph', 'quadrantChart', 'requirementDiagram',
  'C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'block-beta',
  'sankey-beta', 'xychart-beta', 'packet-beta', 'architecture-beta', 'zenuml',
];

const KEYWORDS = [
  'subgraph', 'end', 'direction', 'classDef', 'class', 'click', 'style',
  'linkStyle', 'participant', 'actor', 'note', 'loop', 'alt', 'else', 'opt',
  'par', 'and', 'rect', 'activate', 'deactivate', 'autonumber', 'state',
  'title', 'section', 'accTitle', 'accDescr', 'over', 'of', 'call', 'left',
  'right', 'as',
];

CM.defineSimpleMode('mermaid', {
  start: [
    { regex: /%%.*/, token: 'mermaid-comment' },
    { regex: new RegExp(`\\b(?:${DIAGRAM_TYPES.join('|')})\\b`), token: 'mermaid-keyword' },
    { regex: new RegExp(`\\b(?:${KEYWORDS.join('|')})\\b`), token: 'mermaid-keyword' },
    { regex: /\b(?:TD|TB|BT|RL|LR|DT)\b/, token: 'mermaid-keyword' },
    { regex: /"(?:[^"\\]|\\.)*"/, token: 'mermaid-string' },
    { regex: /\|[^|\n]*\|/, token: 'mermaid-label' },
    {
      regex: /(?:<-->|<--|-->|-->>|->>|<<--|<<-|-\.->|-\.-|==>|--x|--o|o--o|x--x|---|--|->|\.\.)/,
      token: 'mermaid-arrow',
    },
    { regex: /[[\]{}()]/, token: 'mermaid-bracket' },
    { regex: /[A-Za-z_][\w-]*/, token: 'mermaid-node' },
    { regex: /\d+(?:\.\d+)?/, token: 'mermaid-number' },
  ],
  meta: { lineComment: '%%' },
});

const LIGHT_THEME = 'eclipse';
const DARK_THEME = 'material-darker';

/**
 * Create the editor.
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {(text:string)=>void} [opts.onChange]
 * @param {(info:{line:number,ch:number})=>void} [opts.onCursor]
 * @param {(text:string)=>Promise<Array>} [opts.lint]
 */
export function createEditor({ host, onChange, onCursor, lint }) {
  const cm = CM(host, {
    value: '',
    mode: 'mermaid',
    theme: DARK_THEME,
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 4,
    tabSize: 4,
    styleActiveLine: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    gutters: ['CodeMirror-lint-markers'],
    lint: lint ? { async: true, delay: 450, getAnnotations: lint } : false,
    placeholder: 'flowchart TD\n    A[Start] --> B[Next]',
  });

  cm.on('change', (instance, change) => {
    if (change.origin !== 'setValue' && onChange) onChange(instance.getValue());
  });
  cm.on('cursorActivity', (instance) => {
    if (!onCursor) return;
    const pos = instance.getCursor();
    onCursor({ line: pos.line, ch: pos.ch });
  });

  const api = {
    cm,
    getValue: () => cm.getValue(),
    setValue(value) {
      cm.setValue(value || '');
      cm.clearHistory();
      cm.markClean?.();
    },
    setTheme(mode) {
      cm.setOption('theme', mode === 'light' ? LIGHT_THEME : DARK_THEME);
    },
    gotoLine(line, ch = 0) {
      cm.setCursor({ line, ch });
      const view = cm.getWrapperElement();
      const coords = cm.charCoords({ line, ch }, 'local');
      view.scrollTop = Math.max(0, coords.top - view.clientHeight / 3);
      cm.focus();
    },
    refresh: () => cm.refresh(),
    getLineCount: () => cm.lineCount(),
    highlightLines(lines, className = 'mermaid-node-highlight') {
      api.clearHighlight();
      for (const line of lines) {
        cm.addLineClass(line, 'background', className);
      }
    },
    clearHighlight() {
      const marks = host.querySelectorAll('.mermaid-node-highlight');
      marks.forEach((el) => el.classList.remove('mermaid-node-highlight'));
      for (let i = 0; i < cm.lineCount(); i += 1) {
        cm.removeLineClass(i, 'background', 'mermaid-node-highlight');
      }
    },
  };
  return api;
}
