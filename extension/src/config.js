/**
 * Typed configuration model + persistence.
 *
 * The extension is CONFIG-DRIVEN: one validated config object in
 * chrome.storage.local ("controller.config") drives the whole loop. Unknown
 * fields are refused, malformed values fall back to defaults with a recorded
 * reason — never a silent guess (the fail-closed posture of the repo family).
 *
 * v1.1 — the intelligence layer is an ordered CHAIN of sources (the owner's
 * recovery requirement): another chat.z.ai session, a local muse spark agent,
 * a local GitHub Copilot bridge, or any other HTTP agent. The chain rotates
 * on failure, benches a source after a configurable number of consecutive
 * failures, and cools it back in automatically. Legacy single-driver configs
 * migrate into the same shape without changing their behavior.
 */

const CONFIG_KEY = "controller.config";

/** @typedef {{ token: string, owner: string, repo: string, autoMerge: boolean, mergeMethod: string }} GithubConfig */
/** @typedef {{ enabled: boolean, intervalMinutes: number }} LoopConfig */
/** @typedef {{ id: string, kind: "chatzai-web"|"local-http", url: string, enabled: boolean }} ChainSource */
/** @typedef {{ driver: "chain"|"chatzai-web"|"local-http"|"none", localEndpoint: string, timeoutSeconds: number, failureThreshold: number, cooldownMinutes: number, chain: ChainSource[] }} IntelligenceConfig */
/** @typedef {{ tabId: number|null, resurrect: boolean, continuePrompt: string, directive: string, watchdogIntervalSeconds: number, idleContinueAfterSeconds: number }} ChatConfig */
/** @typedef {{ onlyMergeBranchPrefixes: string[], requireGreenChecks: boolean, requireIntelligenceReview: boolean }} SafetyConfig */

/**
 * The default intelligence chain: the chat.z.ai session first, then the two
 * local agent shapes the owner named (muse spark, GitHub Copilot bridge),
 * then one open slot for any other HTTP agent. Only the chat session is
 * enabled by default — local endpoints must be deliberately switched on.
 */
export const DEFAULT_CHAIN = Object.freeze([
  { id: "chatzai-web", kind: "chatzai-web", url: "", enabled: true },
  { id: "muse-spark", kind: "local-http", url: "http://127.0.0.1:8788/", enabled: false },
  { id: "github-copilot", kind: "local-http", url: "http://127.0.0.1:8789/", enabled: false },
  { id: "any-agent", kind: "local-http", url: "", enabled: false },
]);

export const DEFAULT_CONFIG = Object.freeze({
  github: {
    token: "",
    owner: "",
    repo: "",
    autoMerge: true,
    mergeMethod: "squash",
  },
  loop: {
    enabled: false,
    intervalMinutes: 2,
  },
  intelligence: {
    driver: "chain",
    localEndpoint: "http://127.0.0.1:8765",
    timeoutSeconds: 120,
    failureThreshold: 2,
    cooldownMinutes: 5,
    chain: DEFAULT_CHAIN.map((s) => ({ ...s })),
  },
  chat: {
    tabId: null,
    resurrect: true,
    continuePrompt: "continue",
    directive:
      "You are the resident supervisor for this repository. Standing loop: monitor -> harvest -> review -> approve/require-changes -> dispatch next. The GitHub repository is the sole source of truth; verify live, never trust memory. No early returns until the roadmap is complete.",
    watchdogIntervalSeconds: 30,
    idleContinueAfterSeconds: 45,
  },
  safety: {
    onlyMergeBranchPrefixes: ["work/", "ctrl/", "dist/", "uia/", "maint/"],
    requireGreenChecks: true,
    requireIntelligenceReview: false,
  },
});

const MERGE_METHODS = new Set(["merge", "squash", "rebase"]);
const DRIVERS = new Set(["chain", "chatzai-web", "local-http", "none"]);
const SOURCE_KINDS = new Set(["chatzai-web", "local-http"]);

function asString(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function asBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function asNumberInRange(value, fallback, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function asPrefixList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value.filter((p) => typeof p === "string" && p.trim() !== "").map((p) => p.trim());
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Validate one chain source entry. Returns { source, issue } — issue is null
 * when the entry is clean; a malformed entry is repaired (or dropped by the
 * caller when unrepairable) with the refusal recorded.
 */
function normalizeChainSource(entry, index) {
  if (typeof entry !== "object" || entry === null) {
    return { source: null, issue: `intelligence.chain[${index}] is not an object — dropped` };
  }
  const id = asString(entry.id, "").trim();
  const kind = asString(entry.kind, "").trim();
  const url = asString(entry.url, "").trim();
  const enabled = asBool(entry.enabled, false);
  if (id === "") {
    return { source: null, issue: `intelligence.chain[${index}].id is empty — dropped` };
  }
  if (!SOURCE_KINDS.has(kind)) {
    return { source: null, issue: `intelligence.chain[${index}].kind "${kind}" refused (use "chatzai-web" or "local-http") — dropped` };
  }
  if (kind === "local-http" && url === "") {
    // An endpoint-less local source is kept but cannot be enabled.
    return { source: { id, kind, url: "", enabled: false }, issue: `intelligence.chain "${id}" has no url — disabled until one is set` };
  }
  if (kind === "chatzai-web" && url !== "") {
    return { source: { id, kind, url: "", enabled }, issue: `intelligence.chain "${id}" (chatzai-web) ignores its url — cleared` };
  }
  return { source: { id, kind, url, enabled }, issue: null };
}

/**
 * Normalize the whole chain: validate entries, repair/drop malformed ones,
 * de-duplicate ids, and cap the length (an unbounded chain is a config foot-gun).
 */
function normalizeChain(value, issues, { limit = 8 } = {}) {
  if (!Array.isArray(value)) return null; // caller decides the migration path
  const sources = [];
  const seen = new Set();
  for (let i = 0; i < value.length && sources.length < limit; i += 1) {
    const { source, issue } = normalizeChainSource(value[i], i);
    if (issue) issues.push(issue);
    if (!source) continue;
    let id = source.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${source.id}-${suffix}`;
      suffix += 1;
    }
    if (id !== source.id) issues.push(`intelligence.chain id "${source.id}" duplicated — renamed "${id}"`);
    seen.add(id);
    sources.push({ ...source, id });
  }
  if (value.length > limit) issues.push(`intelligence.chain truncated to ${limit} sources`);
  return sources;
}

/**
 * Validate + normalize a partial config object into a full config.
 * Returns { config, issues } — issues is a list of human-readable refusals
 * (shown in the options page); the config is still usable (defaults filled).
 *
 * Migration (v1 -> v1.1): a legacy config without intelligence.chain keeps its
 * driver semantics exactly (chatzai-web | local-http | none) and gains a
 * materialized chain for the options UI; a fresh config defaults to the
 * rotating chain.
 */
export function normalizeConfig(partial) {
  const issues = [];
  const raw = typeof partial === "object" && partial !== null ? partial : {};
  const g = typeof raw.github === "object" && raw.github !== null ? raw.github : {};
  const l = typeof raw.loop === "object" && raw.loop !== null ? raw.loop : {};
  const i = typeof raw.intelligence === "object" && raw.intelligence !== null ? raw.intelligence : {};
  const c = typeof raw.chat === "object" && raw.chat !== null ? raw.chat : {};
  const s = typeof raw.safety === "object" && raw.safety !== null ? raw.safety : {};

  const mergeMethod = MERGE_METHODS.has(g.mergeMethod) ? g.mergeMethod : DEFAULT_CONFIG.github.mergeMethod;
  if (g.mergeMethod !== undefined && !MERGE_METHODS.has(g.mergeMethod)) {
    issues.push(`github.mergeMethod "${g.mergeMethod}" refused; using "${mergeMethod}"`);
  }
  const driver = DRIVERS.has(i.driver) ? i.driver : DEFAULT_CONFIG.intelligence.driver;
  if (i.driver !== undefined && !DRIVERS.has(i.driver)) {
    issues.push(`intelligence.driver "${i.driver}" refused; using "${driver}"`);
  }

  // ── the intelligence chain (with legacy migration) ──────────────────────
  let chain = normalizeChain(i.chain, issues);
  if (chain === null) {
    // No (or unusable) chain provided — migrate the legacy single-driver shape.
    // Fresh configs default to the rotating chain with chatzai-web enabled;
    // legacy local-http configs put their single endpoint first; "none" keeps
    // every source off. Behavior of legacy driver selections is unchanged.
    const chatzaiOn = driver === "chain" || driver === "chatzai-web";
    chain = DEFAULT_CHAIN.map((src) => ({ ...src, enabled: src.id === "chatzai-web" && chatzaiOn }));
    if (driver === "local-http") {
      const legacyUrl = asString(i.localEndpoint, DEFAULT_CONFIG.intelligence.localEndpoint).trim();
      chain = [
        { id: "local-endpoint", kind: "local-http", url: legacyUrl, enabled: true },
        ...chain.map((src) => ({ ...src, enabled: false })),
      ];
    }
  }
  if (driver === "chain" && !chain.some((src) => src.enabled)) {
    issues.push('intelligence.driver is "chain" but no source is enabled — the loop will WAIT honestly until one is');
  }
  if (chain.some((src) => src.kind === "chatzai-web" && src.enabled) === false && driver === "chain") {
    // Honest hint, not a refusal: the chain may deliberately be local-only.
    if (chain.some((src) => src.kind === "chatzai-web")) issues.push("chatzai-web source is disabled — dead-session recovery will use local agents only");
  }

  const config = {
    github: {
      token: asString(g.token, DEFAULT_CONFIG.github.token).trim(),
      owner: asString(g.owner, DEFAULT_CONFIG.github.owner).trim(),
      repo: asString(g.repo, DEFAULT_CONFIG.github.repo).trim(),
      autoMerge: asBool(g.autoMerge, DEFAULT_CONFIG.github.autoMerge),
      mergeMethod,
    },
    loop: {
      enabled: asBool(l.enabled, DEFAULT_CONFIG.loop.enabled),
      intervalMinutes: asNumberInRange(l.intervalMinutes, DEFAULT_CONFIG.loop.intervalMinutes, 1, 120),
    },
    intelligence: {
      driver,
      localEndpoint: asString(i.localEndpoint, DEFAULT_CONFIG.intelligence.localEndpoint).trim(),
      timeoutSeconds: asNumberInRange(i.timeoutSeconds, DEFAULT_CONFIG.intelligence.timeoutSeconds, 5, 600),
      failureThreshold: asNumberInRange(i.failureThreshold, DEFAULT_CONFIG.intelligence.failureThreshold, 1, 10),
      cooldownMinutes: asNumberInRange(i.cooldownMinutes, DEFAULT_CONFIG.intelligence.cooldownMinutes, 1, 1440),
      chain,
    },
    chat: {
      tabId: typeof c.tabId === "number" ? c.tabId : null,
      resurrect: asBool(c.resurrect, DEFAULT_CONFIG.chat.resurrect),
      continuePrompt: asString(c.continuePrompt, DEFAULT_CONFIG.chat.continuePrompt) || "continue",
      directive: asString(c.directive, DEFAULT_CONFIG.chat.directive),
      watchdogIntervalSeconds: asNumberInRange(c.watchdogIntervalSeconds, DEFAULT_CONFIG.chat.watchdogIntervalSeconds, 1, 300),
      idleContinueAfterSeconds: asNumberInRange(c.idleContinueAfterSeconds, DEFAULT_CONFIG.chat.idleContinueAfterSeconds, 2, 600),
    },
    safety: {
      onlyMergeBranchPrefixes: asPrefixList(s.onlyMergeBranchPrefixes, DEFAULT_CONFIG.safety.onlyMergeBranchPrefixes),
      requireGreenChecks: asBool(s.requireGreenChecks, DEFAULT_CONFIG.safety.requireGreenChecks),
      requireIntelligenceReview: asBool(s.requireIntelligenceReview, DEFAULT_CONFIG.safety.requireIntelligenceReview),
    },
  };

  if (config.loop.enabled && (config.github.token === "" || config.github.owner === "" || config.github.repo === "")) {
    issues.push("loop.enabled refused in practice: github token/owner/repo must be set before the loop can run");
  }
  return { config, issues };
}

/** Load config from storage (defaults when absent). */
export async function loadConfig(storage) {
  const stored = await storage.local.get(CONFIG_KEY);
  return normalizeConfig(stored[CONFIG_KEY]).config;
}

/** Persist config. Refuses to persist anything that does not normalize cleanly. */
export async function saveConfig(storage, partial) {
  const { config, issues } = normalizeConfig(partial);
  await storage.local.set({ [CONFIG_KEY]: config });
  return { config, issues };
}

export { CONFIG_KEY };
