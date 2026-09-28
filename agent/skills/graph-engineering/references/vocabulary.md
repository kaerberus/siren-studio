# Visual vocabulary

Use the same shape and colour for the same meaning in every diagram. A reader
who learns the vocabulary once can read every graph you produce.

## Shapes (flowchart)

| Shape | Syntax | Meaning |
| --- | --- | --- |
| Stadium | `A([Text])` | Entry or terminal state |
| Rectangle | `A[Text]` | Process / action |
| Diamond | `A{Text}` | Decision |
| Cylinder | `A[(Text)]` | State store / persistence |
| Hexagon | `A{{Text}}` | Preparation or setup |
| Subroutine | `A[[Text]]` | Call into another diagram |
| Parallelogram | `A[/Text/]` | Input or output |
| Circle | `A((Text))` | Connector / junction |

A `[[subroutine]]` whose label names a diagram file is a **link**: the editor
opens that file when the node is clicked, so it is how a graph-of-graphs is
navigated.

- Keep the extension: `Sub[[see 03-payment.mmd]]` links, `Sub[see 03-payment]`
  is an ordinary node.
- The file has to exist; `graph_validate` warns about a reference that goes
  nowhere.
- A node label is the only place a reference counts — not a comment, not an
  edge label.

## classDef palette

```mermaid
classDef start fill:#1f6feb,stroke:#1f6feb,color:#ffffff
classDef decision fill:#d29922,stroke:#d29922,color:#111111
classDef error fill:#f85149,stroke:#f85149,color:#ffffff
classDef external fill:#8b5cf6,stroke:#8b5cf6,color:#ffffff
classDef data fill:#3fb950,stroke:#3fb950,color:#111111
classDef process fill:#30363d,stroke:#8b949e,color:#ffffff
classDef async fill:#0d9488,stroke:#0d9488,color:#ffffff
classDef terminal fill:#21262d,stroke:#8b949e,color:#ffffff
```

| Class | Use for |
| --- | --- |
| `start` | Entry points and external triggers |
| `decision` | Branch points |
| `error` | Failure and rejection paths |
| `external` | Third-party or out-of-process dependencies |
| `data` | Databases, caches, queues, files |
| `process` | Ordinary work |
| `async` | Deferred, queued or event-driven steps |
| `terminal` | Successful end states |

## Layout

- `TD` control flow; `LR` architecture and data flow.
- Group by **trust boundary**, not by language or package. Subgraphs named
  `Client`, `Edge`, `Service`, `Data`, `Third party`.
- Keep the happy path roughly straight; push error paths to the side.
- Order subgraphs in the direction of the flow.

## Edges

- Solid `-->` synchronous call or transition.
- Dashed `-.->` asynchronous, event-driven, or "eventually".
- Thick `==>` the primary emphasis path (use at most once per diagram).
- Label every conditional edge with the predicate, using the same words as the
  code where possible (`if (retries < 3)` → `|retries < 3|`).

## Anti-patterns

- Colour used to encode meaning the reader must decode without a legend.
- Dozens of `classDef`s; if you need more than ~8 classes, split the diagram.
- A "misc", "other", or "etc." node. Name the thing or leave it out.
- Bidirectional arrows to mean "they talk" — model the direction of each call.
