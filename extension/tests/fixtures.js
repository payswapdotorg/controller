/**
 * Shared fakes for the extension unit tests: storage, fetch (GitHub REST),
 * the intelligence driver, and the log sink.
 */

export function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: store.get(key) };
        const out = {};
        for (const k of key ?? []) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async set(values) {
        Object.assign(Object.fromEntries(store), values);
        for (const [k, v] of Object.entries(values)) store.set(k, v);
      },
    },
    snapshot: () => Object.fromEntries(store),
  };
}

export function fakeLog() {
  const entries = [];
  const log = (record) => entries.push(record);
  return { log, entries };
}

/**
 * A scripted GitHub REST fake: routes by method+path regex against queued
 * handlers; unhandled routes throw (tests must be explicit).
 */
export function fakeGithub(handlers = []) {
  const calls = [];
  const routes = [...handlers];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const path = href.replace("https://api.github.com", "").split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : null });
    const index = routes.findIndex((r) => r.method === method && r.path.test(path));
    if (index === -1) throw new Error(`no fake route for ${method} ${path}`);
    const route = routes[index];
    if (route.once) routes.splice(index, 1);
    if (route.status && !(route.status >= 200 && route.status < 300)) {
      return new Response(route.body ?? "", { status: route.status });
    }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

export function snapshotFixture(overrides = {}) {
  return {
    fetchedAt: "2026-10-16T00:00:00.000Z",
    defaultBranch: "main",
    mainHead: "abc1234def5678",
    openPullRequests: [],
    openIssues: [],
    ...overrides,
  };
}

export function prFixture(overrides = {}) {
  return {
    number: 10,
    title: "WO-1 — sample lane",
    headRef: "work/wo-1",
    headSha: "111222333",
    draft: false,
    mergeable: true,
    checkState: "green",
    author: "worker",
    createdAt: "2026-10-15T00:00:00Z",
    ...overrides,
  };
}

/** A scripted intelligence driver. */
export function fakeIntelligence(script = []) {
  const asks = [];
  const queue = [...script];
  return {
    kind: "fake",
    async ask(input) {
      asks.push(input);
      const next = queue.shift();
      if (!next) return { ok: false, error: "script exhausted", driver: "fake" };
      if (typeof next === "function") return next(input);
      return { ok: true, text: next, driver: "fake" };
    },
    asks,
  };
}

