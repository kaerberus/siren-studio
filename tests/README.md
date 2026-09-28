# Dev suites

Regression coverage for the editor, the bridge and the plugin. **Dev only** —
neither Node nor jsdom is needed to use Mermaid Studio.

```sh
tests/bootstrap.sh    # once: fetch Node + jsdom if you don't have them
tests/run.sh
```

`run.sh` starts an **isolated bridge** on port 8788 against a throwaway
workspace under `/tmp/opencode/mermaid-tests`, so your live editor and your real
project are never touched. Override with `TEST_ROOT`, `TEST_PORT`,
`TEST_WORKSPACE`, `TEST_BASE`.

The `chat` and `permissions` suites additionally need the OpenCode service
running (`opencode service status`); they spawn their own throwaway
`opencode serve` on port 4099 so they don't disturb your session.

## What each suite covers

| suite | covers |
| --- | --- |
| `smoke.mjs` | editor boot, tabs, preview, outline, gaps panel, chat rendering, model palette, smart view, missing-agent handling, file tree, workspace picker |
| `smart-view.mjs` | the transposition decision across portrait / landscape / square panes |
| `export-e2e.mjs` | `buildExportSvg` output rasterisable by real Mermaid (`<img>`), labels kept, no external refs |
| `project-setup.py` | project/diagrams-directory detection guards, awareness wiring, idempotent re-run, unwire |
| `plugin-bridge.py` | the plugin's bridge API: validation round-trip, focus delivery, the size advisory |
| `chat-e2e.mjs` | a live agent round-trip through the app's own `agent.js` |
| `permissions-e2e.py` | graph-engineer may write diagrams and ledgers only, has no shell, and is the only agent that can see the graph tools |

## Notes

- `smoke.mjs` and the other jsdom suites stub Mermaid's `render`, because Mermaid
  needs a real browser to lay out. `export-e2e.mjs` is the exception: it loads
  the **vendored** bundle for real (via `vm.runInContext`, since the bundle
  starts with `"use strict"` and top-level `var` does not leak from strict-mode
  `eval`) and checks the markup against it.
- Tests must run against a bridge whose project the developer's editor is *not*
  using. That is why the suites read their bridge URL and workspace from the
  environment rather than hardcoding them.
- `permissions-e2e.py` points the throwaway server's plugin at the test bridge
  with `MERMAID_STUDIO_URL`, rather than relying on whichever bridge owns the
  primary registration file.
