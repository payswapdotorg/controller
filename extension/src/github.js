/**
 * GitHub REST client — the SOURCE-OF-TRUTH surface.
 *
 * The repository (not chat history, not extension state) is the sole source of
 * truth: every cycle re-derives state from live GitHub. All mutating actions
 * (merge / comment / create issue / create branch) are typed, logged by the
 * caller, and never guessed on failure.
 *
 * Auth: a personal access token supplied by the operator in the options page
 * (stored in chrome.storage.local; see README for the security posture).
 */

const API = "https://api.github.com";

export class GithubError extends Error {
  /**
   * @param {"http"|"rate-limit"|"auth"|"not-found"|"parse"|"network"} kind
   */
  constructor(kind, message, status) {
    super(message);
    this.name = "GithubError";
    this.kind = kind;
    this.status = status;
  }
}

function headers(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function request(token, path, init = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers: headers(token) });
  } catch (error) {
    throw new GithubError("network", `network failure on ${path}: ${error?.message ?? error}`);
  }
  if (response.status === 401) {
    throw new GithubError("auth", `unauthorized on ${path} (401) — check the token`, 401);
  }
  if (response.status === 403 || response.status === 429) {
    const reset = response.headers.get("x-ratelimit-reset");
    throw new GithubError(
      "rate-limit",
      `rate limited on ${path}${reset ? ` (resets ${new Date(Number(reset) * 1000).toISOString()})` : ""}`,
      response.status,
    );
  }
  if (response.status === 404) {
    throw new GithubError("not-found", `not found: ${path}`, 404);
  }
  if (!(response.status >= 200 && response.status < 300)) {
    const body = await response.text().catch(() => "");
    throw new GithubError("http", `HTTP ${response.status} on ${path}: ${body.slice(0, 300)}`, response.status);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  try {
    return text === "" ? null : JSON.parse(text);
  } catch {
    throw new GithubError("parse", `unparseable body on ${path}`);
  }
}

/** Check-runs conclusion roll-up for a commit: "green" | "failing" | "pending" | "none". */
function rollUpChecks(checkRuns) {
  const conclusions = (checkRuns ?? []).map((run) => run.conclusion).filter((c) => c !== undefined);
  if (conclusions.length === 0) {
    return (checkRuns ?? []).length > 0 ? "pending" : "none";
  }
  if (conclusions.some((c) => c === "failure" || c === "cancelled" || c === "timed_out")) return "failing";
  if (conclusions.some((c) => c === "neutral" || c === "skipped")) {
    return conclusions.every((c) => c === "neutral" || c === "skipped") ? "none" : "green";
  }
  return conclusions.every((c) => c === "success") ? "green" : "pending";
}

/**
 * One live snapshot of the repository of record:
 * main HEAD, open pull requests (with CI roll-up + mergeability), open issues.
 */
export async function getSnapshot(token, owner, repo) {
  const [repository, pullRequests, issues] = await Promise.all([
    request(token, `/repos/${owner}/${repo}`),
    request(token, `/repos/${owner}/${repo}/pulls?state=open&per_page=50`),
    request(token, `/repos/${owner}/${repo}/issues?state=open&per_page=50`),
  ]);
  const mainHead = repository?.default_branch ?? "main";
  const branch = await request(token, `/repos/${owner}/${repo}/branches/${encodeURIComponent(mainHead)}`);

  const openPullRequests = [];
  for (const pr of pullRequests ?? []) {
    let checkState = "none";
    try {
      const runs = await request(
        token,
        `/repos/${owner}/${repo}/commits/${encodeURIComponent(pr.head.sha)}/check-runs`,
      );
      checkState = rollUpChecks(runs?.total_count > 0 ? runs.check_runs : []);
    } catch (error) {
      if (error instanceof GithubError && error.kind === "not-found") {
        checkState = "none";
      } else {
        throw error;
      }
    }
    openPullRequests.push({
      number: pr.number,
      title: pr.title,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      draft: Boolean(pr.draft),
      mergeable: pr.mergeable === true,
      checkState,
      author: pr.user?.login ?? "",
      createdAt: pr.created_at,
    });
  }

  const openIssues = (issues ?? [])
    .filter((issue) => !("pull_request" in issue))
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: (issue.labels ?? []).map((l) => l.name),
      createdAt: issue.created_at,
    }));

  return {
    fetchedAt: new Date().toISOString(),
    defaultBranch: mainHead,
    mainHead: branch?.commit?.sha ?? null,
    openPullRequests,
    openIssues,
  };
}

/** Merge a pull request. The caller is responsible for the policy that authorizes this. */
export async function mergePullRequest(token, owner, repo, number, mergeMethod, message) {
  return request(token, `/repos/${owner}/${repo}/pulls/${number}/merge`, {
    method: "PUT",
    body: JSON.stringify({
      merge_method: mergeMethod,
      commit_title: message?.title,
      commit_message: message?.body,
    }),
  });
}

/** Leave an evidence comment on an issue or PR (same REST surface). */
export async function comment(token, owner, repo, number, body) {
  return request(token, `/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

/** Create an issue (the dispatch record surface for the next work order). */
export async function createIssue(token, owner, repo, title, body, labels = []) {
  return request(token, `/repos/${owner}/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body, labels }),
  });
}

/** Create a work branch for a dispatched worker. */
export async function createBranch(token, owner, repo, name, sha) {
  const ref = `refs/heads/${name}`;
  return request(token, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref, sha }),
  });
}

/** Validate the token: returns { login } or throws GithubError("auth"). */
export async function whoAmI(token) {
  const user = await request(token, "/user");
  return { login: user?.login ?? "" };
}
