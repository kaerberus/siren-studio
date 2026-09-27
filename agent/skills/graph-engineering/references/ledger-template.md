# Gap ledger template

One ledger per diagram, named `<diagram>.gaps.md` beside `<diagram>.mmd`.
Start from this template. Keep it short and current — a stale ledger is worse
than none.

```markdown
# <Diagram title> — design gaps

_Question this diagram answers: <one sentence>_
_Source of truth: <code paths, docs, or "prototype — not yet implemented">_

## Open questions
- [ ] <question> — *default:* <what we assume until answered> — **P1**
- [ ] <question> — *default:* <...> — **P2**

## Assumptions
- <assumption> (source: `path:line`)

## Unmodelled paths
- <path not yet represented, and why it is out of scope for now>

## Decisions
- <YYYY-MM-DD> <decision> (<who or "default">)

## Changes
- <YYYY-MM-DD> <what changed in the diagram and why>
```

## Rules

- Questions are phrased so the answer can be "yes, use the default".
- Every assumption cites where it came from, ideally `path:line`.
- "Unmodelled paths" is not a to-do list for everything imaginable — it is the
  honest boundary of the current diagram.
- Record decisions with a date so the diagram's history is legible.
- When an open question is answered, move it to **Decisions** and update the
  diagram in the same change.
