/**
 * Typed configuration model + persistence.
 *
 * The extension is CONFIG-DRIVEN: one validated config object in
 * chrome.storage.local ("controller.config") drives the whole loop. Unknown
 * fields are refused, malformed values fall back to defaults with a recorded
 * reason — never a silent guess (the fail-closed posture of the repo family).
 */

const CONFIG_KEY = "controller.config";

/** @typedef {{ token: string, owner: string, repo: string, autoMerge: boolean, mergeMethod: string }} GithubConfig */
/** @typedef {{ enabled: boolean, intervalMinutes: number }} LoopConfig */
/** @typedef {{ driver: "chatzai-web"|"local-http"|"none", localEndpoint: string }} IntelligenceConfig */
/** @typedef {{ tabId: number|null, resurrect: boolean, continuePrompt: string, directive: string }} ChatConfig */
/** @typedef {{ onlyMergeBranchPrefixes: string[], requireGreenChecks: boolean, requireIntelligenceReview: boolean }} SafetyConfig */

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
    driver: "chatzai-web",
    localEndpoint: "http://127.0.0.1:8765",
  },
  chat: {
    tabId: null,
    resurrect: true,
    continuePrompt: "continue",
    directive:
      "You are the resident supervisor for this repository. Standing loop: monitor -> harvest -> review -> approve/require-changes -> dispatch next. The GitHub repository is the sole source of truth; verify live, never trust memory. No early returns until the roadmap is complete.",
  },
  safety: {
    onlyMergeBranchPrefixes: ["work/", "ctrl/", "dist/", "uia/", "maint/"],
    requireGreenChecks: true,
    requireIntelligenceReview: false,
  },
});

const MERGE_METHODS = new Set(["merge", "squash", "rebase"]);
const DRIVERS = new Set(["chatzai-web", "local-http", "none"]);

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
 * Validate + normalize a partial config object into a full config.
 * Returns { config, issues } — issues is a list of human-readable refusals
 * (shown in the options page); the config is still usable (defaults filled).
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
    },
    chat: {
      tabId: typeof c.tabId === "number" ? c.tabId : null,
      resurrect: asBool(c.resurrect, DEFAULT_CONFIG.chat.resurrect),
      continuePrompt: asString(c.continuePrompt, DEFAULT_CONFIG.chat.continuePrompt) || "continue",
      directive: asString(c.directive, DEFAULT_CONFIG.chat.directive),
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
