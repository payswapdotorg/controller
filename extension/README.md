# Controller — the resident browser supervisor loop

The v1.1 generation of the Controller extension: an unsupervised, resident supervisor
that runs in **Firefox and Chromium/Opera** and closes the mechanical loop of governed
GitHub delivery:

```
monitor → harvest → review → dispatch → wait → monitor …
```

**North star (as instructed by the owner):** connect the extension to a
[chat.z.ai](https://chat.z.ai) session → point it at the repository of record (the
sole source of truth) → it handles everything from start to finish without
supervision — **without you ever pressing a continue button**. When it needs a
source of intelligence to work through recovery cases, that intelligence comes
from a rotating chain: **another chat.z.ai session → a local muse spark agent →
a local GitHub Copilot bridge → any other HTTP agent** — and only then an
honest WAIT. Never a guess.

## What it actually does

- **Monitor** — every cycle re-derives repository state live from the GitHub REST
  API (main HEAD, open PRs with CI roll-up, open issues). No state is ever trusted
  from memory; the repository is the sole source of truth.
- **Harvest** — merges PRs that are: non-draft, mergeable, CI-green (configurable),
  and on an allowed branch prefix (`work/`, `ctrl/`, … configurable). Everything
  else is held open with the reason logged.
- **Review** — with `requireIntelligenceReview` on, every merge needs an explicit
  intelligence `APPROVE`; `REQUIRE-CHANGES` posts the reason on the PR; a driver
  failure holds the PR open (fail-closed, never merge on uncertainty).
- **Dispatch** — when the queue empties, the loop sends a status brief to the
  intelligence source and parses one typed directive: `DISPATCH: <title>` + a
  fenced body (creates the next work-order issue + a dispatch-record comment),
  or `WAIT: <reason>` (honest rest). Unparseable replies are recorded verbatim
  and treated as WAIT.
- **No-continue-button** — the chat.z.ai content script runs an idle watchdog:
  when the session sits idle with an enabled composer, it FIRST clicks the page's
  real Continue affordance when one is surfaced (the exact button no human should
  need), and otherwise auto-sends your configured continue prompt. Dead sessions
  are **resurrected**: a fresh chat.z.ai tab is opened, the standing directive is
  replayed, and the loop continues. While a supervisor-driven exchange is in
  flight the watchdog stays quiet — the two never fight over the composer.
- **Rotating intelligence chain (v1.1)** — recovery intelligence is an ordered
  chain, not a single radio choice: `chatzai-web → muse-spark → github-copilot →
  any-agent`. The first source that answers carries the turn; a source that fails
  `failureThreshold` times in a row is benched for `cooldownMinutes` and returns
  to rotation with a clean slate. Every rotation event is logged and attributed
  (`source "muse-spark" answered`), and the popup shows per-source health. Local
  asks are bounded by a timeout — a hung agent can never hang the cycle.
- **Deterministic-only mode** — with no usable source, the loop still harvests
  green in-fence PRs and honestly waits when judgment is needed.

## Install

### Firefox (142+, current stable/ESR)

1. `npm install && npm run build` in `extension/` (produces `dist/firefox/`).
2. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
   → pick `extension/dist/firefox/manifest.json`.
   (For permanent install, sign the package with
   [web-ext](https://github.com/mozilla/web-ext) `sign` — the package lints
   clean: `npm run lint:firefox` → 0 errors / 0 notices / 0 warnings, including
   the AMO `data_collection_permissions` declaration: the Controller collects
   nothing.)

### Opera (and Chrome / Edge / Brave — same Chromium engine)

1. Same build step (produces `dist/chromium/`).
2. Open `opera://extensions` (or `chrome://extensions`) → enable **Developer
   mode** → **Load unpacked** → pick `extension/dist/chromium/`.

## Configure

Open the popup → **Settings**:

| Field | Meaning |
| --- | --- |
| GitHub token | PAT with `repo` scope (merge + issues). Stored only in this browser's extension storage. |
| Owner / Repository | The repository of record, e.g. `payswapdotorg` / `arena-2.0`. |
| Merge method / auto-merge | `squash` / `merge` / `rebase`, and whether harvesting may merge at all. |
| Intelligence mode | `chain` (rotating — recommended) \| `chatzai-web` \| `local-http` \| `none` (v1 behaviors preserved). |
| Chain sources | Ordered list: id, kind (`chatzai-web` \| `local-http`), url, enabled. Defaults: chat.z.ai session, muse spark (`127.0.0.1:8788`), GitHub Copilot bridge (`127.0.0.1:8789`), one open slot. |
| Ask timeout / bench threshold / cooldown | Per-source ask timeout; consecutive failures before benching; bench duration. |
| Watchdog tick / idle threshold / continue prompt | How often the watchdog checks, how long the session may idle before auto-continue, and the prompt typed when no continue button exists. |
| Continue prompt + directive | What the watchdog auto-sends, and the standing directive replayed on resurrect. |
| Interval / branch prefixes / gates | Cycle cadence (1–120 min), the merge fence, CI + review gates. |

Then: log into chat.z.ai in a normal tab, press **Attach chat.z.ai tab**, hit
**test** on the Intelligence sources panel (a per-source probe), and **Start
loop**.

### The local agent contract

Every local chain source answers the same contract:

```
POST {url}
Content-Type: application/json

{ "kind": "review" | "dispatch" | "recovery" | "directive",
  "brief":  "<the human-readable status/review brief>",
  "context": { ...typed context, e.g. the PR object or snapshot... } }

<- 200 { "reply": "<directive text>" }   // or { "text": "..." }
```

The directive text is parsed for `DISPATCH: <title>` + fenced body, `WAIT:`,
`APPROVE`, `REQUIRE-CHANGES:`, `DEFER` — anything else is recorded verbatim and
treated as WAIT. A muse spark agent, a GitHub Copilot CLI bridge, or any
script that answers this contract can serve as a recovery source.

## Architecture

```
popup/options ──typed messages──▶ service (background)
                                    │
                        alarm every intervalMinutes
                                    ▼
                              supervisor FSM
                          ┌──────────┴──────────┐
                   github client          intelligence chain
                 (source of truth)   ┌──────┴──────┐
                                     │ chatzai-web  │ local-http x N
                              content script in     (muse spark / copilot /
                              the chat.z.ai tab      any agent endpoint)
```

- `src/supervisor.js` — the FSM (pure, fully unit-tested over injected fakes).
- `src/github.js` — REST client with typed errors (auth / rate-limit / not-found).
- `src/intelligence.js` — the rotating driver chain, directive parser, brief builders.
- `src/chatzai.js` — attach / send / resurrect the chat session.
- `src/content/chatzai-content.js` — resilient multi-strategy DOM driver + the
  idle watchdog (real Continue-button click first, typed prompt fallback).
- `src/content/continue-match.js` — the pure continue-control matcher (unit-tested).
- `src/config.js` — validated config model (chain schema, legacy migration,
  watchdog timings; refusals recorded, never guessed).
- `scripts/build.mjs` — one source → `dist/chromium` (service worker) +
  `dist/firefox` (event page, gecko id, data-collection declaration).

## Testing

- **69 unit tests** (`npm test`): supervisor policy matrix (harvest gates,
  review verdicts, fail-closed behaviors, dispatch directives, unparsed
  replies), GitHub client roll-ups and error classes, the intelligence chain
  (rotation, benching, cooldown restore, timeout bounds, attribution, all-fail
  honesty), legacy drivers, config normalization + migration, the continue
  matcher decision table, and structural manifest/bundle checks for both
  targets.
- **E2E** (`npm run e2e`, Playwright Chromium): loads the real built extension,
  mocks `api.github.com` and `chat.z.ai` at the network layer, and runs a REAL
  local muse spark agent (an HTTP server the test starts itself). Verifies:
  1. one FULL loop: monitor → merge of the green in-fence PR → dispatch brief
     delivered into the chat session → intelligence verdict → honest WAIT;
  2. the no-continue-button surface: the page surfaces a real Continue button
     and the watchdog clicks it by itself;
  3. chain recovery: the chat session dies, cannot resurrect, the chain rotates
     to the local muse spark agent, whose DISPATCH directive creates the next
     work order issue;
  4. fail-closed: every source fails → an honest WAIT naming each source.
  `CONTROLLER_E2E_HEADLESS=1 npm run e2e` runs the same suite in Chromium's
  new headless mode (CI-friendly); headed remains the default.
- **Firefox validation** (`npm run lint:firefox`, web-ext/addons-linter on
  `dist/firefox`): 0 errors / 0 notices / 0 warnings. Firefox cannot be driven
  headlessly with extensions via Playwright; that target is covered by the
  lint, the manifest/bundle structure tests, and the shared logic suite.
  Disclosed honestly.

## v1.1 change log (owner-directed follow-up, 2026-10-17)

- **Rotating intelligence chain** — the owner's recovery requirement ("another
  chat.z.ai session / local muse spark agent / local GitHub Copilot agent /
  any available source") is now an ordered, health-tracked chain instead of a
  single-driver radio. Bench after N consecutive failures, cooldown back in,
  per-source attribution in the log and popup, per-source probes.
- **Real Continue-button clicking** — the watchdog now clicks the page's actual
  continue affordance (icon-only buttons included, CJK labels included) before
  falling back to typing the continue prompt; timings are config-driven.
- **Chromium message-boundary defect FIXED** — the v1 background listener mixed
  `sendResponse` with an async (Promise) return, which current Chromium closes
  as "no response" before the first await settles; the E2E caught it at
  `config:set`. The listener now returns literal `true` and lets the async
  handler respond — verified by the E2E in headed AND new-headless modes.
- **Watchdog/driver arbitration** — one exchange at a time on the composer;
  the watchdog never interrupts an in-flight supervisor exchange.
- **Bounded local asks** — every local-agent ask is timeout-bounded (race, not
  just an abort signal) so a hung agent cannot hang a cycle.
- **Firefox packaging hygiene** — description under AMO's 250-char limit,
  `data_collection_permissions: none` declared, `strict_min_version: 142`
  (the first release supporting the declaration); web-ext lint fully clean.

## Security posture

- The PAT lives in `chrome.storage.local` on your machine only; it is attached
  to `api.github.com` requests and nowhere else. Use a fine-grained,
  least-scope token where possible.
- The extension never exfiltrates anything: no telemetry, no analytics, no
  remote logging — `data_collection_permissions: none` is declared to AMO.
- Local agent endpoints receive exactly the brief/context payloads shown
  above; keep them on loopback unless you trust your network.
