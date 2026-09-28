# Diagram selection

| The question the reader has | Diagram | Direction |
| --- | --- | --- |
| What happens, in what order, with what branches? | `flowchart` | `TD` |
| What states exist and how does it move between them? | `stateDiagram-v2` | n/a |
| Who calls whom, in what sequence, including async replies? | `sequenceDiagram` | n/a |
| What are the entities, keys and cardinalities? | `erDiagram` | n/a |
| How do components, services and boundaries fit together? | `flowchart` + `subgraph` | `LR` |
| What is the order of work and its dependencies? | `gantt` | n/a |
| How is a token/request transformed end to end? | `flowchart` | `LR` |
| What is the decision tree? | `flowchart` | `TD` |

## Choosing between flowchart and state diagram

- If the thing is **long-lived** and its identity persists while it changes
  (order, session, document, connection), use `stateDiagram-v2`.
- If the thing is a **journey that completes** (a request, a build, a checkout),
  use `flowchart`.

## Choosing between sequence and flowchart

- Use `sequenceDiagram` when the *ordering and ownership of messages between
  named participants* is the point.
- Use `flowchart` when *branching control flow* is the point. Branches in a
  sequence diagram get messy fast.

## Decomposition

Split when the graph answers more than one question — if you cannot state what it
answers in one sentence, it is two diagrams. Size is the symptom, not the test: a
diagram a reader has to pan or zoom to follow has stopped being a review tool.

- Extract a subflow into its own `NN-topic.mmd` and reference it from the parent
  as `Sub[[see 03-payment.mmd]]`.
- Or collapse a cluster into one node and offer the detail as a follow-up.

`graph_validate` reports a size advisory past roughly 25 nodes or 5 subgraphs.
Treat it as a prompt to consider splitting, not as an error, and not as a hard cap.

### What the reference has to look like

The editor turns a node label that names a diagram file into a link, so:

- keep the extension: `Sub[[see 03-payment.mmd]]` links, `Sub[see 03-payment]` does not;
- the file has to exist. `graph_validate` warns about a reference that goes nowhere,
  because that is not something you can see from inside your own reasoning;
- it counts in a node label only — not in a comment, an edge label or a `click`
  directive. A bare filename resolves anywhere in this directory; `sub/x.mmd` is
  resolved as written.

### A split is several files

Propose it before doing it, then: pick a free `NN`; write the child `.mmd` *and*
its `.gaps.md`; validate the child as well as the parent; replace the moved detail
in the parent with one referencing node rather than keeping both; and record the
decision in the parent's ledger under `## Decisions`.
