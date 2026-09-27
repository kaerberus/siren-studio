# Request render pipeline — design gaps

_Question this diagram answers: what happens to an incoming render request, end to end?_
_Source of truth: prototype — not yet implemented._

## Open questions
- [ ] If the renderer fails after we wrote the draft, is the draft left behind? — *default:* keep it as `failed` for reconciliation — **P1**
- [ ] Does `Queue render job` retry on transient renderer errors? — *default:* yes, 3 attempts with exponential backoff — **P1**
- [ ] Is there a timeout on `Render diagram`? — *default:* 30s, then treated as a renderer error — **P2**

## Assumptions
- Validation is cheap and synchronous, so it happens before persisting.
- The renderer is an external process and can fail independently of the API.

## Unmodelled paths
- Auth failure (401) is out of scope for this diagram; it happens before `Start`.
- Rate limiting and backpressure on the queue are not represented yet.

## Decisions
- 2026-09-27 Failures return 502 with no partial body (default).

## Changes
- 2026-09-27 Initial diagram: happy path plus validation, renderer and queue failures.
