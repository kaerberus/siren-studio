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

When a graph exceeds roughly 20 nodes:

- Extract a subflow into its own `NN-topic.mmd` and reference it from the parent
  as `Sub[[see 03-payment.mmd]]`.
- Or collapse a cluster into one node and offer the detail as a follow-up.
