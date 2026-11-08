# Retrieval evaluation: draft labels

2026-11-08: `fixtures/retrieval/corpus.json` and `npm run eval` now provide a separate frozen
34-case, 14-snapshot synthetic/representative corpus through the shipped injection handler.
It is regression evidence, not owner approval of the representative labels below. Label provenance is
machine-readable; strict fixture checks never change `reviewedBy: null` into ground truth.

These are assistant-proposed labels for review, not user-confirmed ground truth. They use the
fictional file names and paraphrases of observed task types. They do not contain full logged prompts.
Do not tune or enable a floor on this set alone: freeze representative file snapshots, obtain
owner review, and include examples where an important file is ranked second or third.

| Prompt | Must retrieve | Clearly irrelevant | Rationale |
| --- | --- | --- | --- |
| Why is my knowledge file not in the prompt? | knowledge/pi-memory3-injection-limits.md | knowledge/pineledger-export-formats.md | Injection cap diagnosis |
| What happens when two sessions update the same memory file? | knowledge/concurrent-writes.md | knowledge/pineledger-export-guide.md | Concurrent bank writes |
| How do I build LUMO on macOS? | knowledge/lumo-build-macos.md | knowledge/harbor-calculator-prototype.md | Project-specific build |
| What is the Harbor calculator prototype stack? | knowledge/harbor-calculator-prototype.md | knowledge/pineledger-export-formats.md | Prototype implementation |
| How do I import the Pineledger export into LUMO safely? | knowledge/lumo-csv-import.md | knowledge/harbor-calculator-prototype.md | Import procedure |
| What is 2 + 2? | none | all knowledge files | No bank knowledge needed |

These labels distinguish mandatory recall from noise, but no-memory cases require a policy
choice: the current planned floor intentionally preserves the top hit, so it cannot solve them.
The existing `injection-eval.test.ts` covers synthetic positive and negative examples; this draft
is a starting point for a separate, frozen owner-reviewed evaluation, not a substitute for it.
