# Request render pipeline — design gaps

_Question this diagram answers: what happens to an incoming render request, end to end?_
_Source of truth: prototype — not yet implemented._

## Open questions
- [ ] If the renderer fails after we wrote the draft, is the draft left behind? — *default:* keep it as `failed` for reconciliation — **P1**
- [ ] Does the render pipeline retry on transient renderer errors? — *default:* yes, 3 attempts with exponential backoff (now modelled in `02`) — **P1**
- [ ] Is there a timeout on `Render diagram`? — *default:* 30s, then treated as a renderer error — **P2**

## Assumptions
- Validation is cheap and synchronous, so it happens before persisting.
- The renderer is an external process and can fail independently of the API.
- `Render pipeline (detail)` is a **stub node**: it stands in for the whole pipeline, whose detail lives in `02-render-pipeline.mmd`, and it is the link to it.

## Unmodelled paths
- Auth failure (401) is out of scope for this diagram; it happens before `Start`.
- Rate limiting and backpressure on the queue are not represented yet.
- Everything past the queue hand-off (lease, cache, retry, artifact store) is modelled in `02-render-pipeline.mmd`, not here.

## Decisions
- 2026-09-27 Failures return 502 with no partial body (default).
- 2026-09-28 The `Pipeline` subgraph was grouping only: no nodes, edges or semantics added or removed, except that the hand-off edge targets the subgraph id instead of the worker node.
- 2026-09-28 The pipeline body was extracted to `02-render-pipeline.mmd`; this diagram keeps a stub subgraph so the end-to-end flow still fits one screen.
- 2026-09-30 **Link convention settled:** a link is Mermaid's own `click <nodeId> "<path>"` directive, and the editor opens the target in a tab instead of navigating the browser. Targeting is by node **id**, so labels stay free for prose — which is why the stub is now a single node rather than a subgraph. A target that does not exist is reported as a warning by `graph_validate`.
- 2026-09-30 The stub subgraph became one node: a one-node subgraph was only there to give the link something to hang on, and a node is what the reader clicks.
- 2026-09-30 **All classes set to the same neon pink (`#ff2fd0`), at the user's explicit instruction, for a styling test.** Deliberate, not an oversight: colour no longer distinguishes decision / error / data / terminal in this diagram. Revert is the single `classDef` block; the previous Okabe–Ito values were `start #0072b2/#004c78`, `decision #f0e442/#8a8000`, `error #c24e00/#8f3900`, `data #009e73/#006b4e`, `async #cc79a7/#8f4f72`, `process #3a3f45/#8b949e`, `terminal #e8e8e8/#9aa0a6`. Non-colour cues were left in place (dashed `async`, thick `error` border) since they are not colour; strip them too if total uniformity is wanted.
- 2026-09-30 Test override reverted: palette is Okabe–Ito again, matching the 2026-09-28 entry exactly. Class names, non-colour cues (dashed `async`, thick `error` border) and all node/edge/`click` semantics were never touched by the override, so nothing else needed changing back.
- 2026-09-30 **Blue-only palette adopted.** All seven classes are now one hue at seven lightness steps (`#04182c` → `#eaf4fc`). Colour-blind-safe by construction (a single hue cannot be confused *between* hues), but it is a **luminance-only encoding**: it survives greyscale and low-vision viewing, and it fails hard if the renderer applies a dark-mode filter or any theme that compresses lightness. The non-colour cues are now the primary channel, not a backup — keep them.
- 2026-09-30 Palette only: swapped Okabe–Ito for the blue-only ramp (exact values in this Decision). Nodes, edges, labels and `click` semantics unchanged. The last-good Okabe–Ito block remains recorded above, so the revert is still a one-block edit.

## Changes
- 2026-09-27 Initial diagram: happy path plus validation, renderer and queue failures.
- 2026-09-28 Palette only: swapped to Okabe–Ito CVD-safe colours, added lightness separation and non-colour cues (dashed `async`, thick-stroked `error`). Nodes, edges and semantics unchanged.
- 2026-09-28 Split the async stage into a `Pipeline` subgraph (`Worker`, `Render`) with `direction TB`, so the boundary is a linkable endpoint: `Persist` links in to the subgraph id, and `Render` links back out to `Ok`/`Fail`.
- 2026-09-28 Extracted the pipeline body to `02-render-pipeline.mmd`; `Pipeline` became `RenderPipeline`, `Worker`/`Render` were replaced by the stub node `Handoff`, and `click Handoff` links to the new file.
- 2026-09-30 `RenderPipeline` is a single subroutine node (`[[…]]`) instead of a subgraph, so it is clickable *and* visible as a link; its label is now free prose. `click RenderPipeline "02-render-pipeline.mmd"` replaces `click Handoff "graphs/…"`. Edges and semantics unchanged.
- 2026-09-30 Palette only: blue-only ramp replaces Okabe–Ito (see Decision). Nodes, edges, labels and `click` unchanged.
