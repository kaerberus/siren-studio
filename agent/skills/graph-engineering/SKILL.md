---
name: Graph Engineering
description: Use when turning a codebase, prototype or process into Mermaid diagrams, when hunting for design gaps in an existing graph or design, or when refining flowchart/state/sequence/ER diagrams for a reader. Covers diagram selection, a consistent visual vocabulary, Mermaid syntax that parses, and a systematic gap-analysis checklist.
---

# Graph engineering

A repeatable method for producing Mermaid diagrams that are *true* and for using
them to find what the design has not decided yet.

## Method

1. **Frame the question.** What decision or understanding should the reader walk
   away with? Write it down in the ledger. Every later choice serves this.
2. **Pick the diagram type.** See `references/diagram-selection.md`. Choosing the
   wrong type is the most common failure.
3. **Recon the source of truth.** For code, follow
   `references/codebase-to-flow.md`. For a prototype, interview the intent.
4. **Draft at the right altitude.** Coarse first: entry points, happy path,
   major stores, external dependencies. Add detail only where the question is.
5. **Apply the vocabulary.** Use `references/vocabulary.md` so meaning is
   consistent within and across diagrams.
6. **Make it parse.** Follow `references/mermaid-syntax.md`. Validate before
   presenting.
7. **Run the gap analysis.** Use `references/gap-checklist.md` item by item.
   Record results in the ledger using `references/ledger-template.md`.
8. **Present and iterate.** Answer first; show the diagram only when it changed;
   then only the gaps that gate the next step, each with a default. Keep it
   short — the diagram lives in the file, not in the chat.

## Non-negotiables

- When you do show Mermaid, show complete, copy-pasteable source — never a
  fragment that assumes prior context.
- One concern per diagram; split rather than sprawl.
- Every decision node has every branch labelled.
- Every diagram has a sibling `*.gaps.md` ledger.
- Cite `path:line` for claims about real code.

## Reference files

- `references/diagram-selection.md` — which diagram type answers which question
- `references/mermaid-syntax.md` — syntax that reliably parses, plus pitfalls
- `references/vocabulary.md` — classDef palette and shape conventions
- `references/gap-checklist.md` — the systematic gap taxonomy
- `references/codebase-to-flow.md` — extracting flows from source code
- `references/ledger-template.md` — the gap-ledger format
