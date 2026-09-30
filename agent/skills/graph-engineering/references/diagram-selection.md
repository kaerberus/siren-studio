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

- Extract a subflow into its own `NN-topic.mmd` and link to it from the parent
  with `click Payment "03-payment.mmd"`.
- Or collapse a cluster into one node and offer the detail as a follow-up.

`graph_validate` reports a size advisory past roughly 25 nodes or 5 subgraphs.
Treat it as a prompt to consider splitting, not as an error, and not as a hard cap.

### How the link is written

Mermaid's own `click` directive, so the intent travels with the diagram:

    click Payment "03-payment.mmd" "Open the payment detail"

- Targeting is by node **id**, so the node's label stays free for prose. Never put
  a filename in a label to make a link — that is a caption.
- The target is a filename in this directory, or a path from the project root. The
  file has to exist: `graph_validate` warns when a link points nowhere, because that
  is not something you can see from inside your own reasoning.
- The editor opens the target in a tab and marks the linked node visibly. Ids are
  not drawn, so that mark is how a reader knows there is somewhere to go.

### A split is several files

Propose it before doing it, then: pick a free `NN`; write the child `.mmd` *and*
its `.gaps.md`; validate the child as well as the parent; replace the moved detail
in the parent with one linked node rather than keeping both; and record the
decision in the parent's ledger under `## Decisions`.
