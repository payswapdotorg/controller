/**
 * The repository-content client (CTRL-012).
 *
 * The browser MVP uses GitHub as the controlled-repository
 * execution/evidence surface, through supported GitHub REST/content
 * endpoints — never page-click automation (work order, Forbidden).
 * This client is GET-ONLY: it holds no mutation capability of any
 * kind, so no message routed through it can mutate authoritative
 * repository state (acceptance criterion 7's hard guarantee).
 *
 * For CTRL-012 the reads are unauthenticated public-repository reads
 * (pectoraux/controller is public). GitHub authentication for private
 * repositories and mutation surfaces is CTRL-013 scope; no token,
 * password, cookie, or credential is ever accepted, stored, or sent
 * by this client.
 *
 * Every failure is typed: transport/HTTP failure -> AUTHORITY_UNAVAILABLE,
 * 404 -> AUTHORITY_MISSING, structurally unusable payload -> AUTHORITY_MALFORMED.
 */

import { failure } from "./errors.js";

const REQUEST_TIMEOUT_MS = 15000;

/**
 * The GET-only GitHub content client.
 *
 * `fetchImpl` is injected so the whole surface is testable offline
 * (node --test) and so the browser wiring is a one-liner
 * (`new ControllerContentClient({ fetchImpl: fetch })`).
 */
export class ControllerContentClient {
  /**
   * @param {{ fetchImpl: Function, apiRoot?: string, rawRoot?: string, timeoutMs?: number }} options
   */
  constructor({ fetchImpl, apiRoot = "https://api.github.com", rawRoot = "https://raw.githubusercontent.com", timeoutMs = REQUEST_TIMEOUT_MS }) {
    this._fetch = fetchImpl;
    this._apiRoot = apiRoot;
    this._rawRoot = rawRoot;
    this._timeoutMs = timeoutMs;
  }

  /**
   * Fetch the repository's default branch name.
   *
   * @returns {Promise<{ ok: true, defaultBranch: string } | { ok: false, error: object }>}
   */
  async repositoryDefaultBranch(owner, name) {
    const result = await this._getJson(
      `${this._apiRoot}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      "repository lookup"
    );
    if (!result.ok) {
      if (result.error.code === "AUTHORITY_MISSING") {
        return failure(
          "AUTHORITY_MISSING",
          `repository '${owner}/${name}' was not found (is it public? GitHub authorization arrives with CTRL-013)`
        );
      }
      return result;
    }
    const body = result.value;
    if (typeof body.default_branch !== "string" || body.default_branch.length === 0) {
      return failure("AUTHORITY_MALFORMED", "repository lookup response omits 'default_branch'");
    }
    return { ok: true, defaultBranch: body.default_branch };
  }

  /**
   * Observe the HEAD commit SHA of `ref`.
   *
   * @returns {Promise<{ ok: true, sha: string } | { ok: false, error: object }>}
   */
  async branchHeadSha(owner, name, ref) {
    const result = await this._getJson(
      `${this._apiRoot}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(ref)}`,
      "branch head observation"
    );
    if (!result.ok) {
      return result;
    }
    const body = result.value;
    if (typeof body.sha !== "string" || body.sha.length === 0) {
      return failure("AUTHORITY_MALFORMED", "branch head response omits 'sha'");
    }
    return { ok: true, sha: body.sha };
  }

  /**
   * Fetch one repository file's text content, pinned to an exact commit
   * SHA. Pinning both authority reads to one observed SHA is what makes
   * the projection coherent — the extension never mixes two commits of
   * the authority surfaces, so a "stale" mixed read is structurally
   * impossible (work order, "State display").
   *
   * @returns {Promise<{ ok: true, text: string } | { ok: false, error: object }>}
   */
  async rawFile(owner, name, sha, path) {
    const url =
      `${this._rawRoot}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
      `/${encodeURIComponent(sha)}/${path}`;
    return this._getText(url, `content fetch ${path}`);
  }

  /** @private */
  async _getJson(url, context) {
    const text = await this._getText(url, context);
    if (!text.ok) {
      return text;
    }
    try {
      const value = JSON.parse(text.text);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return failure("AUTHORITY_MALFORMED", `${context}: response is not a JSON object`);
      }
      return { ok: true, value };
    } catch (err) {
      return failure("AUTHORITY_MALFORMED", `${context}: response is not valid JSON (${err})`);
    }
  }

  /** @private */
  async _getText(url, context) {
    let response;
    try {
      response = await this._fetch(url, {
        method: "GET",
        headers: { Accept: "application/vnd.github+json, text/plain, */*" },
        signal: this._timeoutSignal(),
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        return failure("AUTHORITY_UNAVAILABLE", `${context}: timed out after ${this._timeoutMs}ms`);
      }
      return failure("AUTHORITY_UNAVAILABLE", `${context}: transport failure (${err})`);
    }
    if (response.status === 404) {
      return failure("AUTHORITY_MISSING", `${context}: 404 not found (${url})`);
    }
    if (response.ok === false) {
      return failure(
        "AUTHORITY_UNAVAILABLE",
        `${context}: HTTP ${response.status} (${url})`
      );
    }
    let text;
    try {
      text = await response.text();
    } catch (err) {
      return failure("AUTHORITY_UNAVAILABLE", `${context}: response body unreadable (${err})`);
    }
    return { ok: true, text };
  }

  /** @private */
  _timeoutSignal() {
    if (typeof AbortController === "undefined") {
      // Environments without AbortController (older test fakes): no
      // timeout signal, the caller's fetch governs.
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    // Best-effort cleanup — Node keeps the process alive otherwise.
    if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") {
      timer.unref();
    }
    return controller.signal;
  }
}
