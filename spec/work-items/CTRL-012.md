# CTRL-012 — Browser Control Surface Foundation

Status: `COMPLETE`

## Authorization

CTRL-012 was the sole executable Work Item after CTRL-011 completion. It was dispatched from exact `main` base `398c0e8c06c2bae4cb4a864990b36cb0fd47b88f` and implemented in PR #38. Architect approval was recorded against exact reviewed head `0edc3a2c933384a5f52ec3de33cf4794eabac0f7`; the PR was merged once, producing merge commit `951584850609a5804b27348f0e540a80306be7d8`.

Automation stage: `STAGE-7-END-TO-END-AUTONOMOUS-GOVERNED-LOOP`.

## Completion record

CTRL-012's Browser Control Surface Foundation was reviewed and accepted. The implementation established the Chromium Manifest V3 extension shell, typed closed message boundary, non-authoritative Worker/Architect registration, canonical repository selection, GET-only repository authority projection pinned to one observed commit SHA, generic provider-tab discovery, popup operator UI, tests and fresh-session documentation.

The implementation deliberately did **not** implement provider-specific Z.ai or ChatGPT DOM automation. Those capabilities remain owned by later roadmap Work Items CTRL-014 and CTRL-015. The implementation also did not add local product checkout, VS Code integration, desktop-agent execution, authoritative extension persistence, or new lifecycle/merge/review/evidence predicates.

## Evidence

- Implementation PR: #38.
- Dispatched base: `398c0e8c06c2bae4cb4a864990b36cb0fd47b88f`.
- Reviewed head: `0edc3a2c933384a5f52ec3de33cf4794eabac0f7`.
- Architect approval review: `5120711328`.
- Merge commit: `951584850609a5804b27348f0e540a80306be7d8`.
- Worker-reported extension suite: `node --test 'extension/tests/**/*.test.js'` — 80/80 pass.
- Worker-reported Python suite: 651 passed + 209 subtests.
- Worker-reported mypy strict: 0 issues in 38 source files.
- Worker-reported ruff check/format: clean.
- Worker-reported no-external-I/O guard: 8/8 + 129 subtests.
- Worker-reported `scripts/audit_ctrl_012.sh 398c0e8c06c2bae4cb4a864990b36cb0fd47b88f`: PASS, 8/8.
- Worker-reported Chromium real-load probe: MV3 service worker registered, popup rendered, live typed-message chain exercised against a public repository, provider-tab primitives verified, and a rate-limited probe demonstrated the typed fail-closed unavailable state.

The live GitHub branch contained exactly the CTRL-012 implementation surface plus the established mechanical real-repository test-pin advancement; no `controller/` or `spec/` implementation semantics changed. The PR was approved on the live head and merged exactly once.

## Reconciliation

Observed implementation merge evidence:

```text
PR: #38
base: main @ 398c0e8c06c2bae4cb4a864990b36cb0fd47b88f
approved head: 0edc3a2c933384a5f52ec3de33cf4794eabac0f7
merge: 951584850609a5804b27348f0e540a80306be7d8
```

Reconciliation updates this Work Order and machine state to `COMPLETE`, records CTRL-012 in the completed ledger, preserves Stage 7, and activates no successor. CTRL-013 is only planned and requires a separate explicit governance activation after reconciliation.

No runtime implementation semantics are changed by this reconciliation checkpoint.

## Fresh-session source of truth

1. `spec/state/controller-program-state.json`
2. `spec/roadmap/roadmap.md`
3. `spec/architecture/controller-architecture.md`
4. `spec/operations/controller-build-process.md`
5. this Work Order
6. `spec/operations/fresh-session-handoff.md`
7. `AGENTS.md`

No conversation transcript is required to understand CTRL-012 or its completion evidence.
