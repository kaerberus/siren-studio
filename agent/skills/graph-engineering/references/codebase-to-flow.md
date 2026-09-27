# Extracting flows from a codebase

Goal: a diagram that a maintainer would recognise as true, with citations they
can verify. Read before you draw.

## 1. Find the entry points

Look for the edges of the system, not the middle:

- HTTP/RPC route registrations
- CLI command tables and argument parsers
- Message/topic consumers and scheduled jobs
- Event handlers, webhooks, and UI callbacks
- `main`/bootstrap functions and their startup sequence

Record each entry point as `path:line` in the ledger.

## 2. Trace one request at a time

Pick a single entry point and follow it. At each step ask:

- What is called next? (follow the call, not the file order)
- What can fail here, and what happens then?
- What is read or written, and where does it live?
- Is anything deferred, queued, cached, or retried?

Stop when you reach a response, a terminal state, or a boundary you have chosen
to collapse into a single node.

## 3. Find the state

- Databases, tables, and ORM models
- Caches, queues, and object storage
- In-memory state that outlives a request (sessions, pools, feature flags)
- Enumerations and status columns — these are the states of your state diagram

A status enum is almost always a `stateDiagram-v2` waiting to be written.

## 4. Map the boundaries

Group nodes by trust boundary: client, edge, service, data, third party. A
subgraph per boundary usually mirrors how the team already thinks.

## 5. Hunt for the unspoken

These are where gaps hide:

- `try`/`catch` that swallows the error
- `TODO`, `FIXME`, and `XXX`
- Retry loops and their absence around network calls
- Default values that mask missing data
- Comments that disagree with the code
- Feature flags with two live branches
- Code paths with no tests

## 6. Calibrate altitude

- **Level 0** — the whole system, ≤ 12 nodes, one node per component.
- **Level 1** — one request or job end to end, ≤ 20 nodes.
- **Level 2** — one algorithm or state machine in detail.

Always deliver Level 0 or 1 first and offer to drill down. Never start at
Level 2 unless asked.

## 7. Verify

For each node in the diagram, you should be able to point at the code that
implements it. If you cannot, the node is either a design intent (mark it as
such) or a guess (remove it or list it as a gap).
