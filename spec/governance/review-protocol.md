# Architect Review Protocol

The Architect review is a repository-grounded semantic gate.

## Inputs

- exact PR head SHA;
- intended base SHA;
- frozen architecture;
- authoritative roadmap/work order;
- changed-file list;
- CI results and evidence;
- previous review findings, if any.

## Decisions

`APPROVE` — all acceptance predicates satisfied and no blocking finding remains.

`REQUEST_CHANGES` — implementation is within the intended item but one or more concrete changes are required. Every finding gets a stable ID and exact required action.

`ESCALATE` — architecture, authority, security, roadmap, or repository state is contradictory and cannot be resolved by the worker without an authority decision.

## Review packet

```yaml
work_item: CTRL-001
pr: 0
head_sha: <sha>
base_sha: <sha>
iteration: 1
decision: REQUEST_CHANGES
findings:
  - id: CTRL001-F01
    severity: HIGH
    path: <repo path>
    criterion: <acceptance criterion>
    required_change: <specific action>
```

The packet is both the human-readable PR review and the machine-readable input to the next worker iteration. Findings are never silently dropped.

## Merge gate

An APPROVE decision is not itself a merge command. The controller separately verifies terminal CI, current head SHA, unresolved findings, roadmap eligibility and authority consistency before invoking merge.
