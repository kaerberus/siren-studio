# Render pipeline (detail) — design gaps

_Question this diagram answers: what does the async render pipeline do with a queued job?_
_Source of truth: **provisional / filler** — created to exercise the editor's diagram linking. Steps beyond the queue → render → retry → store loop are placeholders, not agreed design._

## Open questions
- [ ] Is `Render diagram` idempotent for a given job id? — *default:* yes; the lease plus the artifact store make a duplicate run harmless — **P1**
- [ ] How many attempts before dead-lettering, and with what backoff? — *default:* 3 attempts, exponential from 1s (inherited from `01`) — **P1**
- [ ] Is the cache key the draft id, the draft content hash, or both? — *default:* content hash, so a re-render after an edit misses the cache — **P2**
- [ ] Does `Publish result` deliver at-least-once or exactly-once? — *default:* at-least-once; consumers dedupe on job id — **P2**

## Assumptions
- Work is claimed with a lease, so two workers cannot render the same job concurrently. Unverified — see the idempotency question.
- The worker pool is a separate deployment from the API in `01-example-flow.mmd`. This is the boundary the link crosses.
- `Emit metrics` is a **placeholder** giving the graph a filler terminal; no metric names, sinks or alert thresholds are agreed.

## Unmodelled paths
- Lease expiry and re-claim while a render is still in flight (the zombie-worker path) is not drawn.
- Cancellation of an in-flight render is not represented; no cancel edge exists.
- Dead-letter triage and replay are out of scope.

## Decisions
- 2026-09-28 Created as a **test fixture** for editor linking; expect a redraw once the real pipeline design lands.
- 2026-09-28 The retry loop stays internal to the worker pool (backoff re-renders) rather than returning to the queue, to keep the loop bounded on one screen.
- 2026-09-30 **Blue-only palette applied, matching `01-example-flow.mmd`.** The seven semantic classes use the same ramp and the same values, so the two diagrams read as one system.
- 2026-09-30 `external` and `filler` were **excluded from the ramp and left grey** — deliberately, even though the request was "same palette". On `01` there is no `external` or `filler`, so there was no precedent to copy; folding them into the blue would have made them indistinguishable from ramp steps with no cue that one is out-of-boundary and the other is a placeholder. `external` was previously the light blue `#56b4e9`, which sits at the same luminance as ramp step `#2d8fd4` and would collide after the swap.

## Changes
- 2026-09-28 Initial file: lease → load → cache → render/retry → store → publish, plus a filler metrics node and a dead-letter terminal.
- 2026-09-30 Palette only: seven semantic classes swapped to the blue-only ramp from `01-example-flow.mmd`; `external` and `filler` remained grey (see Decision). Nodes, edges, subgraph and semantics unchanged.
