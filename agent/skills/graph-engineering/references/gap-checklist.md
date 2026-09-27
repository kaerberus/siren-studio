# Gap checklist

Work through every section. Record findings in the ledger even when the answer
is "handled" — an explicit "handled" is itself useful evidence.

Severity guide: **P0** blocks correctness, **P1** causes user-visible failure,
**P2** causes operational pain, **P3** is a clarity improvement.

## 1. Control flow

- [ ] Every decision has an explicit `no` / `else` branch.
- [ ] Every path reaches a terminal state; no accidental dead ends.
- [ ] Loops have a termination condition.
- [ ] Retries are bounded and have a backoff policy.
- [ ] No unreachable nodes.
- [ ] Mutually exclusive conditions cannot both fire.
- [ ] The order of independent steps is not accidentally load-bearing.

## 2. Failure and recovery

- [ ] Each external call models timeout, error, and retry.
- [ ] Cancellation is represented (user, caller, or deadline).
- [ ] Partial completion is represented and recoverable.
- [ ] Idempotency: what if this step runs twice?
- [ ] Compensating actions exist for irreversible steps.
- [ ] Failures are surfaced somewhere a human will see them.

## 3. State

- [ ] All states are named; no implicit "then it's fine".
- [ ] Illegal transitions are impossible or explicitly rejected.
- [ ] Initial and terminal states are explicit.
- [ ] Re-entry after completion is defined.
- [ ] Concurrent or re-entrant transitions are identified.
- [ ] State is owned by exactly one component.

## 4. Data and boundaries

- [ ] Inputs are validated before use.
- [ ] Invalid input has a defined path and a defined response shape.
- [ ] Empty, null, zero, maximum, and oversized inputs are considered.
- [ ] Auth/authorisation branches are explicit (anonymous, user, admin, service).
- [ ] Data crossing a trust boundary is called out.
- [ ] Schema evolution / versioning is considered where records persist.

## 5. Operational

- [ ] Key transitions and errors are observable.
- [ ] Rate limits, quotas, and backpressure are modelled.
- [ ] Clock, timezone, ordering, and duplicate delivery are considered.
- [ ] Resource cleanup happens on every path.
- [ ] Cost or load multipliers are called out.

## 6. Design intent

- [ ] Every assumption is written down, with its source.
- [ ] The design's load-bearing preconditions are stated.
- [ ] The branch most likely to be wrong is named, with a way to detect it.
- [ ] Alternatives considered are recorded with why they were rejected.

## Turning findings into questions

For each gap, write a question the user can answer, not a complaint:

> Weak: "Error handling is missing."
> Strong: "If the payment provider times out after we've written the order,
> do we (a) retry, (b) mark the order failed, or (c) leave it pending for
> reconciliation? *Default: (c), pending + reconciliation job.*"

Always attach a **recommended default** so the answer can be "yes, do that".
