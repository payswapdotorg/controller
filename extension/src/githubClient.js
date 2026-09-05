/**
 * The GitHub app API client (CTRL-013) — the typed observation/mutation
 * surface for repository evidence and the three Controller-authorized
 * mutations.
 *
 * Layering and doctrine (mirrors controller/github.py, CTRL-003, which
 * is the accepted boundary this extension surface must NOT replace):
 *
 * * **Transport.** One injected fetch. When the identity holds a
 *   session token, requests carry a transient `Authorization: Bearer`
 *   header; without a connection, only unauthenticated public reads can
 *   succeed (the controlled MVP repositories are public). The token is
 *   never persisted, never logged, and never appears in an error.
 *   A 401 invalidates the session token and fail-closes with
 *   AUTHORIZATION_REQUIRED (never an automatic reconnect).
 *
 * * **Observation.** GitHub JSON is normalized into frozen typed values
 *   field-compatible with the Python core's dataclasses (GithubRef,
 *   GithubPullRequest, GithubReview, GithubComment, GithubCommitStatus):
 *   required fields are validated, lists are sorted by stable IDs, and
 *   a structurally unusable response is GITHUB_MALFORMED — never a
 *   guessed default. Known documented shape variants are tolerated
 *   exactly the way the Python core tolerates them (e.g. the PR LIST
 *   endpoint omits the `merged` boolean but reports `merged_at`, from
 *   which the flag is derived as observed evidence). Unknown extra
 *   response fields are ignored (GitHub adds fields over time); the
 *   CLOSED-form doctrine applies to the extension's own boundary
 *   (messages, configuration), not to GitHub's wire format.
 *
 * * **Correlation.** `correlateWorkPullRequest` returns a typed OUTCOME
 *   (correlated / no-open-pr / ambiguous / base-drift / head-drift) —
 *   observed evidence with the same integrity discipline the Python
 *   adapter's correlation enforces. The decision about what an outcome
 *   MEANS is the Controller runtime's (returned to the boundary, not
 *   re-decided here).
 *
 * * **Mutation.** Exactly three, the same three the accepted Python
 *   adapter exposes: createBranch (explicit base SHA, never a default),
 *   openPullRequest (one-PR rule + base identity gates), and
 *   mergePullRequest (the transport of a runtime-issued
 *   authorization, carrying its complete closed identity — work
 *   item included, merge method frozen — through to the executed
 *   mutation and its typed result). NO governance predicate is
 *   evaluated here: no eligibility, no review/approval state, no
 *   required-checks policy, no lifecycle. The runtime-authorization
 *   binding (repository authority + the Architect's exact-head
 *   APPROVE) lives one layer up in the service
 *   (mergeAuthorization.js); this client performs only the
 *   transport-level identity/exact-head safety checks on the bound
 *   authorization and lets GitHub's own exact-head `sha` parameter
 *   refuse a moved head. The merge method is frozen to "merge" (the
 *   core's _POLICY_MERGE_METHOD).
 *
 * * **Fail-closed mapping.** 401 -> AUTHORIZATION_REQUIRED (after
 *   invalidation); repo-scoped 403/404 -> REPOSITORY_INACCESSIBLE;
 *   403-with-exhausted-quota and 429 -> RATE_LIMITED (reset surfaced);
 *   5xx/timeout/transport -> GITHUB_UNAVAILABLE; unusable bodies ->
 *   GITHUB_MALFORMED. Nothing is auto-retried.
 */

import { failure } from "./errors.js";

const REQUEST_TIMEOUT_MS = 15000;

/** @private — normalize an apiRoot so path joins are unambiguous. */
function _stripTrailingSlash(url) {
  return typeof url === "string" && url.endsWith("/") ? url.slice(0, -1) : url;
}

/** The only merge method the frozen merge policy ever authorizes. */
export const POLICY_MERGE_METHOD = "merge";

/** Repository list pagination: page size and the bounded walk (truncation is explicit). */
const REPOSITORIES_PAGE_SIZE = 100;
const REPOSITORIES_MAX_PAGES = 10;

/**
 * Build the GitHub app API client.
 *
 * @param {{ fetchImpl: Function, identity?: object, apiRoot?: string,
 *           timeoutMs?: number }} wiring — `identity` is the
 *        createGitHubIdentity() value (or any { currentToken, invalidate }).
 */
export function createGitHubClient({ fetchImpl, identity = null, apiRoot = "https://api.github.com", timeoutMs = REQUEST_TIMEOUT_MS }) {
  const api = _stripTrailingSlash(apiRoot);

  return {
    /** The identity this client is bound to (tests assert header wiring). */
    identity,

    // -- account / discovery ------------------------------------------------

    /** GET /user — the authenticated account view. */
    async getAuthenticatedUser() {
      const result = await _request("GET", `${api}/user`, { fetchImpl, identity, timeoutMs, context: "authenticated user" });
      if (!result.ok) {
        return result;
      }
      const login = _requireString(result.value, "login", "authenticated user");
      if (!login.ok) {
        return login;
      }
      return {
        ok: true,
        user: Object.freeze({
          login: login.value,
          name: _optionalString(result.value.name) ?? null,
          avatarUrl: _optionalString(result.value.avatar_url) ?? null,
        }),
      };
    },

    /**
     * GET /user/repos — repositories the connection is permitted to
     * access. Deterministically sorted by canonical `owner/name`;
     * bounded pagination with an EXPLICIT truncation marker (never a
     * silent cutoff).
     */
    async listAccessibleRepositories() {
      const repositories = [];
      let truncated = false;
      for (let page = 1; page <= REPOSITORIES_MAX_PAGES; page += 1) {
        const result = await _request(
          "GET",
          `${api}/user/repos?per_page=${REPOSITORIES_PAGE_SIZE}&page=${page}` +
            "&visibility=all&affiliation=owner,collaborator,organization_member&sort=full_name",
          { fetchImpl, identity, timeoutMs, context: `accessible repositories (page ${page})`, list: true }
        );
        if (!result.ok) {
          return result;
        }
        const items = result.value;
        if (!Array.isArray(items)) {
          return failure("GITHUB_MALFORMED", "accessible repositories response is not a list");
        }
        for (const item of items) {
          const normalized = _normalizeRepositorySummary(item);
          if (!normalized.ok) {
            return normalized;
          }
          repositories.push(normalized.repository);
        }
        if (items.length < REPOSITORIES_PAGE_SIZE) {
          break; // last page
        }
        const hasMore = result.hasMore === true;
        if (!hasMore) {
          break; // no rel="next" link
        }
        if (page === REPOSITORIES_MAX_PAGES) {
          truncated = true; // bounded walk ended with more pages existing
        }
      }
      repositories.sort((a, b) => (a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0));
      return { ok: true, repositories: Object.freeze(repositories), truncated };
    },

    // -- repository observation --------------------------------------------

    /** GET /repos/{owner}/{name} — canonical identity + default branch. */
    async getRepository(owner, name) {
      const result = await _request(
        "GET",
        `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        { fetchImpl, identity, timeoutMs, context: `repository ${owner}/${name}`, repositoryScoped: true }
      );
      if (!result.ok) {
        return result;
      }
      // The observed identity must be exactly the requested one — the
      // extension never silently substitutes another repository.
      const observedName = _optionalString(result.value.full_name);
      if (observedName !== null && observedName !== `${owner}/${name}`) {
        return failure(
          "GITHUB_MALFORMED",
          `repository lookup for '${owner}/${name}' observed '${observedName}' — refusing the substitution`
        );
      }
      const normalized = _normalizeRepositorySummary(result.value);
      if (!normalized.ok) {
        return normalized;
      }
      return { ok: true, repository: normalized.repository };
    },

    /** GET /repos/{owner}/{name}/branches/{branch} — the branch head SHA. */
    async getBranchHead(owner, name, branch) {
      const result = await _request(
        "GET",
        `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches/${encodeURIComponent(branch)}`,
        { fetchImpl, identity, timeoutMs, context: `branch ${owner}/${name}/${branch}`, repositoryScoped: true }
      );
      if (!result.ok) {
        return result;
      }
      const commit = result.value.commit;
      if (typeof commit !== "object" || commit === null || typeof commit.sha !== "string" || commit.sha.length === 0) {
        return failure("GITHUB_MALFORMED", `branch ${owner}/${name}/${branch} response omits commit.sha`);
      }
      return { ok: true, sha: commit.sha };
    },

    /** GET /repos/{owner}/{name}/pulls — typed PR list, sorted by number. */
    async listPullRequests(owner, name, { state, headBranch = null }) {
      let url = `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=${encodeURIComponent(state)}`;
      if (headBranch !== null) {
        url += `&head=${encodeURIComponent(`${owner}:${headBranch}`)}`;
      }
      const result = await _request("GET", url, {
        fetchImpl, identity, timeoutMs,
        context: `pull requests ${owner}/${name} (${state}${headBranch !== null ? `, head ${headBranch}` : ""})`,
        repositoryScoped: true, list: true,
      });
      if (!result.ok) {
        return result;
      }
      const items = result.value;
      if (!Array.isArray(items)) {
        return failure("GITHUB_MALFORMED", "pull request list response is not a list");
      }
      const pullRequests = [];
      for (const item of items) {
        const normalized = _normalizePullRequest(item, "pull request list entry");
        if (!normalized.ok) {
          return normalized;
        }
        pullRequests.push(normalized.pullRequest);
      }
      pullRequests.sort((a, b) => a.number - b.number);
      return { ok: true, pullRequests: Object.freeze(pullRequests) };
    },

    /** GET /repos/{owner}/{name}/pulls/{number} — one typed PR. */
    async getPullRequest(owner, name, prNumber) {
      const result = await _request(
        "GET",
        `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${prNumber}`,
        { fetchImpl, identity, timeoutMs, context: `pull request #${prNumber}`, repositoryScoped: true }
      );
      if (!result.ok) {
        return result;
      }
      const normalized = _normalizePullRequest(result.value, `pull request #${prNumber}`);
      if (!normalized.ok) {
        return normalized;
      }
      return { ok: true, pullRequest: normalized.pullRequest };
    },

    /** GET /repos/{o}/{n}/pulls/{number}/reviews — typed reviews, sorted by id. */
    async getReviews(owner, name, prNumber) {
      const result = await _request(
        "GET",
        `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${prNumber}/reviews`,
        { fetchImpl, identity, timeoutMs, context: `reviews of PR #${prNumber}`, repositoryScoped: true, list: true }
      );
      if (!result.ok) {
        return result;
      }
      const items = result.value;
      if (!Array.isArray(items)) {
        return failure("GITHUB_MALFORMED", "review list response is not a list");
      }
      const reviews = [];
      for (const item of items) {
        const normalized = _normalizeReview(item, `review of PR #${prNumber}`);
        if (!normalized.ok) {
          return normalized;
        }
        reviews.push(normalized.review);
      }
      reviews.sort((a, b) => a.reviewId - b.reviewId);
      return { ok: true, reviews: Object.freeze(reviews) };
    },

    /** GET /repos/{o}/{n}/issues/{number}/comments — typed comments, sorted by id. */
    async getComments(owner, name, prNumber) {
      const result = await _request(
        "GET",
        `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${prNumber}/comments`,
        { fetchImpl, identity, timeoutMs, context: `comments of PR #${prNumber}`, repositoryScoped: true, list: true }
      );
      if (!result.ok) {
        return result;
      }
      const items = result.value;
      if (!Array.isArray(items)) {
        return failure("GITHUB_MALFORMED", "comment list response is not a list");
      }
      const comments = [];
      for (const item of items) {
        const normalized = _normalizeComment(item, `comment of PR #${prNumber}`);
        if (!normalized.ok) {
          return normalized;
        }
        comments.push(normalized.comment);
      }
      comments.sort((a, b) => a.commentId - b.commentId);
      return { ok: true, comments: Object.freeze(comments) };
    },

    /** GET /repos/{o}/{n}/commits/{sha}/status — the combined commit status. */
    async getCommitStatus(owner, name, sha) {
      const result = await _request(
        "GET",
        `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(sha)}/status`,
        { fetchImpl, identity, timeoutMs, context: `commit status ${sha.slice(0, 12)}`, repositoryScoped: true }
      );
      if (!result.ok) {
        return result;
      }
      const normalized = _normalizeCommitStatus(result.value, `commit status ${sha.slice(0, 12)}`);
      if (!normalized.ok) {
        return normalized;
      }
      return { ok: true, status: normalized.status };
    },

    // -- correlation (typed outcomes, evidence only) --------------------------

    /**
     * Correlate a work-order branch to its open PR. Returns a typed
     * outcome; the meaning of each outcome is decided by the Controller
     * boundary, not here:
     *
     *   correlated  — exactly one open PR, base (and optionally head)
     *                 matches the authority-derived SHAs;
     *   no-open-pr  — zero open PRs for the branch;
     *   ambiguous   — more than one open PR (one-PR-per-work-item
     *                 contradiction observed);
     *   base-drift  — the PR's base SHA is not the expected base;
     *   head-drift  — the PR's head SHA is not the expected head.
     */
    async correlateWorkPullRequest(owner, name, { branch, baseSha, headSha = null }) {
      const listed = await this.listPullRequests(owner, name, { state: "open", headBranch: branch });
      if (!listed.ok) {
        return listed;
      }
      const matches = listed.pullRequests;
      if (matches.length === 0) {
        return { ok: true, outcome: "no-open-pr", candidates: Object.freeze([]) };
      }
      if (matches.length > 1) {
        return {
          ok: true,
          outcome: "ambiguous",
          candidates: Object.freeze(matches.map((pr) => pr.number)),
        };
      }
      const pr = matches[0];
      if (pr.baseSha !== baseSha) {
        return {
          ok: true,
          outcome: "base-drift",
          pullRequest: pr,
          observedBaseSha: pr.baseSha,
        };
      }
      if (headSha !== null && pr.headSha !== headSha) {
        return {
          ok: true,
          outcome: "head-drift",
          pullRequest: pr,
          observedHeadSha: pr.headSha,
        };
      }
      return { ok: true, outcome: "correlated", pullRequest: pr };
    },

    // -- mutations (the three Controller-authorized, gated) -----------------

    /**
     * Mutation 1: create a work branch at an EXPLICIT base SHA (never a
     * default — the SHA is authority-derived caller input, exactly as
     * the Python adapter requires).
     */
    async createBranch(owner, name, branch, fromSha) {
      const valid = _validateBranchName(branch);
      if (!valid.ok) {
        return valid;
      }
      const result = await _request(
        "POST",
        `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/refs`,
        {
          fetchImpl, identity, timeoutMs,
          context: `created ref refs/heads/${branch}`,
          repositoryScoped: true,
          payload: { ref: `refs/heads/${branch}`, sha: fromSha },
        }
      );
      if (!result.ok) {
        return result;
      }
      const object = result.value.object;
      if (typeof object !== "object" || object === null || typeof object.sha !== "string" || object.sha.length === 0) {
        return failure("GITHUB_MALFORMED", "created ref response omits object.sha");
      }
      return { ok: true, ref: Object.freeze({ ref: branch, sha: object.sha }) };
    },

    /**
     * Mutation 2: open the one work-order PR. In-transport gates mirror
     * the Python adapter's own: the one-PR rule (an existing open PR for
     * the branch refuses) and the base identity gate (the observed base
     * branch head must equal the authority-derived baseSha — drift is a
     * typed stale refusal, never an auto-rebase).
     */
    async openPullRequest(owner, name, { branch, baseBranch, baseSha, title, body }) {
      const existing = await this.listPullRequests(owner, name, { state: "open", headBranch: branch });
      if (!existing.ok) {
        return existing;
      }
      if (existing.pullRequests.length > 0) {
        return failure(
          "MUTATION_REFUSED",
          `one-PR-per-work-item violated: open PR #${existing.pullRequests[0].number} already exists for branch '${branch}'`
        );
      }
      const baseHead = await this.getBranchHead(owner, name, baseBranch);
      if (!baseHead.ok) {
        return baseHead;
      }
      if (baseHead.sha !== baseSha) {
        return failure(
          "STALE_REFERENCE",
          `base branch '${baseBranch}' head ${baseHead.sha} does not match the expected base ${baseSha}`
        );
      }
      const result = await _request(
        "POST",
        `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`,
        {
          fetchImpl, identity, timeoutMs,
          context: `opened PR for branch ${branch}`,
          repositoryScoped: true,
          payload: { title, head: branch, base: baseBranch, body },
        }
      );
      if (!result.ok) {
        return result;
      }
      const normalized = _normalizePullRequest(result.value, "opened pull request");
      if (!normalized.ok) {
        return normalized;
      }
      return { ok: true, pullRequest: normalized.pullRequest };
    },

    /**
     * Mutation 3: merge a PR as the transport of a runtime-issued
     * authorization. The CALLER is the service, which has already
     * bound the authorization to the repository authority and the
     * Architect's exact-head APPROVE (mergeAuthorization.js); this
     * client executes ONLY the transport-level identity binding of
     * the authorization it is handed: the PR must be open and
     * unmerged, its base ref/SHA and head SHA must match the
     * authorization exactly, GitHub's own `sha` parameter re-pins the
     * exact head at execution time, the merge method is the frozen
     * policy constant, and the work item is carried through so the
     * executed mutation and its typed result stay bound to the exact
     * authorization identity. Everything else the frozen merge
     * predicate requires (eligibility, approvals, required checks,
     * one-PR rule) is evaluated by the Controller runtime BEFORE
     * issuing the authorization; this surface does not duplicate any
     * of it.
     *
     * @param {string} owner
     * @param {string} name
     * @param {{ prNumber: number, workItem: string, baseRef: string,
     *           baseSha: string, headSha: string }} authorization the
     *        bound authorization identity (all six fields closed; the
     *        merge method is frozen here, never caller-supplied)
     */
    async mergePullRequest(owner, name, { prNumber, workItem, baseRef, baseSha, headSha }) {
      if (typeof workItem !== "string" || workItem.length === 0) {
        return failure(
          "INTERNAL_ERROR",
          "the merge transport requires the complete runtime authorization identity: 'workItem' is missing " +
            "(the merge cannot execute unbound to the authorized work item)"
        );
      }
      const observed = await this.getPullRequest(owner, name, prNumber);
      if (!observed.ok) {
        return observed;
      }
      const pr = observed.pullRequest;
      if (pr.merged) {
        return failure("MUTATION_REFUSED", `PR #${prNumber} (${workItem}) is already merged`);
      }
      if (pr.state !== "open") {
        return failure("MUTATION_REFUSED", `PR #${prNumber} (${workItem}) is ${pr.state}, not open`);
      }
      if (pr.baseRef !== baseRef) {
        return failure(
          "STALE_REFERENCE",
          `PR #${prNumber} (${workItem}) targets base ref '${pr.baseRef}', not the authorized base ref '${baseRef}'`
        );
      }
      if (pr.baseSha !== baseSha) {
        return failure(
          "STALE_REFERENCE",
          `PR #${prNumber} (${workItem}) base ${pr.baseSha} does not match the authorized base ${baseSha}`
        );
      }
      if (pr.headSha !== headSha) {
        return failure(
          "STALE_REFERENCE",
          `PR #${prNumber} (${workItem}) head ${pr.headSha} does not match the authorized head ${headSha}`
        );
      }
      const result = await _request(
        "POST",
        `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${prNumber}/merge`,
        {
          fetchImpl, identity, timeoutMs,
          context: `merge of PR #${prNumber} (${workItem})`,
          repositoryScoped: true,
          payload: { merge_method: POLICY_MERGE_METHOD, sha: headSha },
        }
      );
      if (!result.ok) {
        return result;
      }
      if (result.value.merged !== true) {
        return failure(
          "MUTATION_REFUSED",
          `GitHub did not report PR #${prNumber} (${workItem}) as merged (message: ${typeof result.value.message === "string" ? result.value.message.slice(0, 200) : "(none)"})`
        );
      }
      return {
        ok: true,
        merged: true,
        mergeCommitSha: typeof result.value.merge_commit_sha === "string" ? result.value.merge_commit_sha : null,
        prNumber,
        workItem,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The transport core (one place; typed fail-closed mapping)
// ---------------------------------------------------------------------------

/** @private */
async function _request(method, url, { fetchImpl, identity, timeoutMs, context, repositoryScoped = false, list = false, payload = null }) {
  const headers = { Accept: "application/vnd.github+json" };
  const token = identity !== null && typeof identity.currentToken === "function" ? identity.currentToken() : null;
  if (token !== null && typeof token === "string" && token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      ...(payload !== null ? { body: JSON.stringify(payload) } : {}),
      signal: _timeoutSignal(timeoutMs),
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      return failure("GITHUB_UNAVAILABLE", `${context}: timed out after ${timeoutMs}ms`);
    }
    // The error's class only — a transport error never carries a token,
    // and its message is not echoed into typed telemetry.
    return failure("GITHUB_UNAVAILABLE", `${context}: transport failure (${err && err.name ? err.name : "unknown"})`);
  }
  // 401: the session token is invalid/expired. Discard it and fail
  // closed — never an automatic re-authorization (the operator decides).
  if (response.status === 401) {
    if (identity !== null && typeof identity.invalidate === "function") {
      identity.invalidate();
    }
    return failure(
      "AUTHORIZATION_REQUIRED",
      `${context}: GitHub rejected the session authorization (it may have expired); connect GitHub again`
    );
  }
  if (response.status === 429) {
    return failure("RATE_LIMITED", _rateLimitMessage(context, response));
  }
  if (response.status === 403) {
    if (_rateLimitExhausted(response)) {
      return failure("RATE_LIMITED", _rateLimitMessage(context, response));
    }
    if (repositoryScoped) {
      return failure(
        "REPOSITORY_INACCESSIBLE",
        `${context}: GitHub denied access (403) — the connection is not permitted to access this repository`
      );
    }
    return failure("AUTHORIZATION_REQUIRED", `${context}: GitHub denied access (403) for the current authorization`);
  }
  if (response.status === 404) {
    if (repositoryScoped) {
      return failure(
        "REPOSITORY_INACCESSIBLE",
        `${context}: not found (404) — the repository does not exist or is not accessible to this connection`
      );
    }
    return failure("GITHUB_NOT_FOUND", `${context}: not found (404)`);
  }
  if (response.status >= 500) {
    return failure("GITHUB_UNAVAILABLE", `${context}: GitHub answered HTTP ${response.status}`);
  }
  if (response.ok === false) {
    // Other 4xx: the surface refuses; the GitHub message (if any) is
    // surfaced bounded. Mutation endpoints land here for 405/409/422.
    const message = await _boundedBodyMessage(response);
    return failure(
      "MUTATION_REFUSED",
      `${context}: GitHub refused the request (HTTP ${response.status}${message.length > 0 ? `: ${message}` : ""})`
    );
  }
  let text;
  try {
    text = await response.text();
  } catch (err) {
    return failure("GITHUB_UNAVAILABLE", `${context}: response body unreadable (${err && err.name ? err.name : "unknown"})`);
  }
  if (list && text.length === 0) {
    return { ok: true, value: [], hasMore: _hasNextPage(response) };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return failure("GITHUB_MALFORMED", `${context}: response is not valid JSON`);
  }
  return { ok: true, value, hasMore: _hasNextPage(response) };
}

/** @private */
function _hasNextPage(response) {
  const headers = typeof response.headers?.get === "function" ? response.headers : null;
  if (headers === null) {
    return false;
  }
  const link = headers.get("Link");
  if (typeof link !== "string" || link.length === 0) {
    return false;
  }
  return /rel="next"/.test(link);
}

/** @private */
function _rateLimitExhausted(response) {
  const headers = typeof response.headers?.get === "function" ? response.headers : null;
  if (headers === null) {
    return false;
  }
  const remaining = headers.get("X-RateLimit-Remaining");
  return remaining === "0";
}

/** @private */
function _rateLimitMessage(context, response) {
  const headers = typeof response.headers?.get === "function" ? response.headers : null;
  const retryAfter = headers !== null ? headers.get("Retry-After") : null;
  const reset = headers !== null ? headers.get("X-RateLimit-Reset") : null;
  if (retryAfter !== null && retryAfter !== undefined) {
    return `${context}: rate limited — retry after ${retryAfter}s`;
  }
  if (reset !== null && reset !== undefined) {
    return `${context}: rate limited — quota resets at epoch ${reset}`;
  }
  return `${context}: rate limited`;
}

/** @private */
async function _boundedBodyMessage(response) {
  try {
    const text = await response.text();
    if (text.length === 0) {
      return "";
    }
    const value = JSON.parse(text);
    if (typeof value === "object" && value !== null && typeof value.message === "string") {
      return value.message.slice(0, 200);
    }
  } catch {
    // Unreadable/non-JSON error body: no message, still typed.
  }
  return "";
}

/** @private */
function _timeoutSignal(timeoutMs) {
  if (typeof AbortController === "undefined") {
    return undefined;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") {
    timer.unref();
  }
  return controller.signal;
}

// ---------------------------------------------------------------------------
// Strict normalization (field-compatible with controller/github.py)
// ---------------------------------------------------------------------------

/** @private */
function _requireString(mapping, key, context) {
  const value = mapping[key];
  if (typeof value !== "string" || value.length === 0) {
    return failure("GITHUB_MALFORMED", `${context}: field '${key}' must be a non-empty string`);
  }
  return { ok: true, value };
}

/** @private */
function _optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** @private */
function _requirePositiveInt(mapping, key, context) {
  const value = mapping[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return failure("GITHUB_MALFORMED", `${context}: field '${key}' must be a positive integer`);
  }
  return { ok: true, value };
}

/** @private */
function _normalizeRepositorySummary(item) {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return failure("GITHUB_MALFORMED", "repository entry is not an object");
  }
  const fullName = _requireString(item, "full_name", "repository entry");
  if (!fullName.ok) {
    return fullName;
  }
  const owner = typeof item.owner === "object" && item.owner !== null ? _optionalString(item.owner.login) : null;
  const name = _requireString(item, "name", "repository entry");
  if (!name.ok) {
    return name;
  }
  if (owner === null || `${owner}/${name.value}` !== fullName.value) {
    return failure(
      "GITHUB_MALFORMED",
      `repository entry 'full_name' '${fullName.value}' disagrees with owner/name fields — refusing rather than guessing`
    );
  }
  return {
    ok: true,
    repository: Object.freeze({
      repository: fullName.value,
      owner,
      name: name.value,
      defaultBranch: _optionalString(item.default_branch),
      description: _optionalString(item.description),
      private: item.private === true,
      pushedAt: _optionalString(item.pushed_at),
    }),
  };
}

/** @private */
function _normalizePullRequest(item, context) {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return failure("GITHUB_MALFORMED", `${context}: not an object`);
  }
  const number = _requirePositiveInt(item, "number", context);
  if (!number.ok) {
    return number;
  }
  const state = _requireString(item, "state", context);
  if (!state.ok) {
    return state;
  }
  const title = _requireString(item, "title", context);
  if (!title.ok) {
    return title;
  }
  if (typeof item.head !== "object" || item.head === null || typeof item.base !== "object" || item.base === null) {
    return failure("GITHUB_MALFORMED", `${context}: head/base objects are missing`);
  }
  const headRef = _requireString(item.head, "ref", `${context}.head`);
  if (!headRef.ok) {
    return headRef;
  }
  const headSha = _requireString(item.head, "sha", `${context}.head`);
  if (!headSha.ok) {
    return headSha;
  }
  const baseRef = _requireString(item.base, "ref", `${context}.base`);
  if (!baseRef.ok) {
    return baseRef;
  }
  const baseSha = _requireString(item.base, "sha", `${context}.base`);
  if (!baseSha.ok) {
    return baseSha;
  }
  if (typeof item.draft !== "boolean") {
    return failure("GITHUB_MALFORMED", `${context}: 'draft' must be a boolean`);
  }
  const merged = _mergedFlag(item, context);
  if (!merged.ok) {
    return merged;
  }
  return {
    ok: true,
    pullRequest: Object.freeze({
      number: number.value,
      state: state.value,
      title: title.value,
      headRef: headRef.value,
      headSha: headSha.value,
      baseRef: baseRef.value,
      baseSha: baseSha.value,
      draft: item.draft,
      merged: merged.value,
      mergeableState: _optionalString(item.mergeable_state),
      mergeCommitSha: _optionalString(item.merge_commit_sha),
    }),
  };
}

/**
 * @private — the merged flag, tolerating GitHub's documented shape
 * variants (mirroring controller/github.py's _merged_flag doctrine):
 * the single-PR GET reports a `merged` boolean; LIST items omit it but
 * report `merged_at` (null when unmerged). When the boolean is absent
 * the flag is DERIVED from the observed `merged_at` evidence — never
 * guessed; absent boolean AND absent timestamp fails closed.
 */
function _mergedFlag(item, context) {
  if (typeof item.merged === "boolean") {
    return { ok: true, value: item.merged };
  }
  if ("merged_at" in item && (item.merged_at === null || typeof item.merged_at === "string")) {
    return { ok: true, value: item.merged_at !== null };
  }
  return failure(
    "GITHUB_MALFORMED",
    `${context}: neither 'merged' nor 'merged_at' is observed — refusing rather than guessing`
  );
}

/** @private */
function _normalizeReview(item, context) {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return failure("GITHUB_MALFORMED", `${context}: not an object`);
  }
  const reviewId = _requirePositiveInt(item, "id", context);
  if (!reviewId.ok) {
    return reviewId;
  }
  const state = _requireString(item, "state", context);
  if (!state.ok) {
    return state;
  }
  const user = typeof item.user === "object" && item.user !== null ? _optionalString(item.user.login) : null;
  if (user === null) {
    return failure("GITHUB_MALFORMED", `${context}: 'user.login' must be a non-empty string`);
  }
  return {
    ok: true,
    review: Object.freeze({
      reviewId: reviewId.value,
      state: state.value,
      author: user,
      commitId: _optionalString(item.commit_id),
      submittedAt: _optionalString(item.submitted_at),
    }),
  };
}

/** @private */
function _normalizeComment(item, context) {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return failure("GITHUB_MALFORMED", `${context}: not an object`);
  }
  const commentId = _requirePositiveInt(item, "id", context);
  if (!commentId.ok) {
    return commentId;
  }
  const user = typeof item.user === "object" && item.user !== null ? _optionalString(item.user.login) : null;
  if (user === null) {
    return failure("GITHUB_MALFORMED", `${context}: 'user.login' must be a non-empty string`);
  }
  const body = _requireString(item, "body", context);
  if (!body.ok) {
    return body;
  }
  return {
    ok: true,
    comment: Object.freeze({
      commentId: commentId.value,
      author: user,
      body: body.value,
      createdAt: _optionalString(item.created_at),
    }),
  };
}

/** @private */
function _normalizeCommitStatus(item, context) {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return failure("GITHUB_MALFORMED", `${context}: not an object`);
  }
  const state = _requireString(item, "state", context);
  if (!state.ok) {
    return state;
  }
  if (typeof item.total_count !== "number" || !Number.isInteger(item.total_count) || item.total_count < 0) {
    return failure("GITHUB_MALFORMED", `${context}: 'total_count' must be a non-negative integer`);
  }
  if (!Array.isArray(item.statuses)) {
    return failure("GITHUB_MALFORMED", `${context}: 'statuses' must be a list`);
  }
  const pairs = [];
  for (const entry of item.statuses) {
    if (typeof entry !== "object" || entry === null) {
      return failure("GITHUB_MALFORMED", `${context}: statuses entry is not an object`);
    }
    const entryContext = _requireString(entry, "context", `${context}.statuses`);
    if (!entryContext.ok) {
      return entryContext;
    }
    const entryState = _requireString(entry, "state", `${context}.statuses`);
    if (!entryState.ok) {
      return entryState;
    }
    pairs.push([entryContext.value, entryState.value]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    ok: true,
    status: Object.freeze({
      state: state.value,
      totalCount: item.total_count,
      statuses: Object.freeze(pairs.map((pair) => Object.freeze(pair))),
    }),
  };
}

// ---------------------------------------------------------------------------
// Mutation input hygiene (transport-level, not policy)
// ---------------------------------------------------------------------------

/** @private — GitHub ref-name rules that would make the API refuse anyway. */
const BRANCH_FORBIDDEN = /[\s~^:?*[\]/\\]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** @private */
function _validateBranchName(branch) {
  if (typeof branch !== "string" || branch.length === 0) {
    return failure("MUTATION_REFUSED", "branch name must be a non-empty string");
  }
  if (BRANCH_FORBIDDEN.test(branch) || CONTROL_CHARS.test(branch)) {
    return failure("MUTATION_REFUSED", `branch name '${branch}' contains characters GitHub ref names cannot contain`);
  }
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) {
    return failure("MUTATION_REFUSED", `branch name '${branch}' has an invalid '/' structure`);
  }
  if (branch.includes("..") || branch.endsWith(".")) {
    return failure("MUTATION_REFUSED", `branch name '${branch}' contains a forbidden '.' sequence`);
  }
  if (branch.endsWith(".lock")) {
    return failure("MUTATION_REFUSED", `branch name '${branch}' must not end with '.lock'`);
  }
  return { ok: true };
}
