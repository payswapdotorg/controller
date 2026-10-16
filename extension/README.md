# Controller — the resident browser supervisor loop

The v1 generation of the Controller extension: an unsupervised, resident supervisor
that runs in **Firefox and Chromium/Opera** and closes the mechanical loop of governed
GitHub delivery:

```
monitor → harvest → review → dispatch → wait → monitor …
```

**North star (as instructed by the owner):** connect the extension to a
[chat.z.ai](https://chat.z.ai) session → point it at the repository of record (the
sole source of truth) → it handles everything from start to finish without
supervision — **without you ever pressing a continue button**. When it needs a
source of intelligence to work through recovery cases, that intelligence comes from
the chat.z.ai session, a local agent endpoint (muse spark / GitHub Copilot bridge /
anything that speaks HTTP), or a deterministic fallback — never a guess.

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
  when the session sits idle with an enabled composer, it auto-sends your
  configured continue prompt. Dead sessions are **resurrected**: a fresh
  chat.z.ai tab is opened, the standing directive is replayed, and the loop
  continues.
- **Local intelligence** — `local-http` driver POSTs
  `{ kind, brief, context }` to your endpoint and reads `{ reply }` (or `{ text }`).
- **Deterministic-only mode** — with no driver, the loop still harvests
  green in-fence PRs and honestly waits when judgment is needed.

## Install

### Firefox

1. `npm install && npm run build` in `extension/` (produces `dist/firefox/`).
2. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
   → pick `extension/dist/firefox/manifest.json`.
   (For permanent install, sign the package with
   [web-ext](https://github.com/mozilla/web-ext) `sign` or use an unbranded build.)

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
| Intelligence driver | `chatzai-web` \| `local-http` \| `none`. |
| Local endpoint | Your local agent's URL (must answer POST → `{reply}`). |
| Continue prompt + directive | What the watchdog auto-sends, and the standing directive replayed on resurrect. |
| Interval / branch prefixes / gates | Cycle cadence (1–120 min), the merge fence, CI + review gates. |

Then: log into chat.z.ai in a normal tab, press **Attach chat.z.ai tab**, hit
**Test chat driver** (a one-message round-trip probe), and **Start loop**.

## Architecture

```
popup/options ──typed messages──▶ service (background)
                                    │
                        alarm every intervalMinutes
                                    ▼
                              supervisor FSM
                          ┌──────────┴──────────┐
                   github client            intelligence
                 (source of truth)     ┌───────┴────────┐
                                        │ chatzai-web    │ local-http │ none
                                 content script in
                                 the chat.z.ai tab
```

- `src/supervisor.js` — the FSM (pure, fully unit-tested over injected fakes).
- `src/github.js` — REST client with typed errors (auth / rate-limit / not-found).
- `src/intelligence.js` — driver registry, directive parser, brief builders.
- `src/chatzai.js` — attach / send / resurrect the chat session.
- `src/content/chatzai-content.js` — resilient multi-strategy DOM driver +
  the idle auto-continue watchdog.
- `src/config.js` — validated config model (refusals recorded, never guessed).
- `scripts/build.mjs` — one source → `dist/chromium` (service worker) +
  `dist/firefox` (event page, gecko id).

## Testing

- **43 unit tests** (`npm test`): supervisor policy matrix (harvest gates,
  review verdicts, fail-closed behaviors, dispatch directives, unparsed
  replies), GitHub client roll-ups and error classes, intelligence drivers,
  config normalization, and structural manifest/bundle checks for both targets.
- **E2E** (`npm run e2e`, Playwright Chromium, headed): loads the real built
  extension, mocks `api.github.com` and `chat.z.ai` at the network layer, and
  verifies one FULL loop: monitor → merge of the green in-fence PR → dispatch
  brief delivered into the chat session → intelligence verdict → honest WAIT.
  Firefox cannot be driven headlessly with extensions via Playwright; that
  target is covered structurally (manifest + parseable bundles) and by the
  shared logic suite. Disclosed honestly.

## Security posture

- The PAT lives in `chrome.storage.local` on your machine only; it is attached
  to API requests transiently and never leaves the GitHub host permissions.
- The extension never executes repository code; it only calls the REST API.
- All mutations are logged in the popup log ring (last 200 records).
- Merges are fenced (branch prefixes + CI gates + optional review verdict).
  Nothing is force-pushed; protected-branch rules on GitHub remain enforced.

## Honest limitations

- The chat.z.ai DOM driver uses layered generic selectors (ARIA textbox/submit
  semantics first). If the host app changes radically, the driver fails TYPED
  (`composer not found`, `completion timeout`) — the GitHub loop keeps running
  deterministically and the failure is surfaced in the popup log.
- The auto-continue watchdog uses a 45s idle heuristic; it never fires while a
  turn is streaming.
- `local-http` requires the endpoint to be reachable from the browser
  (CORS is bypassed via host permissions on `127.0.0.1`/`localhost`).

## Lineage

This v1 extension supersedes the CTRL-012/013 registration surface preserved at
`extension-legacy/` (the Pectoraux Controller program). The Python controller
under `controller/` is unchanged.
