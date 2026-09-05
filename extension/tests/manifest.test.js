/**
 * Manifest and packaging tests (CTRL-012 + CTRL-013 + CTRL-014): the
 * extension loads unpacked with exactly the declared, minimal
 * surface — every manifest-referenced file exists, permissions are
 * minimal, no remote code, and provider host permissions stay scoped
 * to exactly the authorized adapters.
 *
 * CTRL-013 refinements: the manifest legitimately gains the
 * `https://github.com/*` host permission (the OAuth device-flow
 * endpoints github.com/login/device/code and
 * github.com/login/oauth/access_token — API access, not page
 * automation) and an `oauth2` section documenting the public client
 * id + the minimal scope grant. Credential-pattern bans are refined:
 * the service worker legitimately ASSEMBLES a transient
 * Authorization header from the session-only token; what remains
 * banned is literal secret material (token prefixes with real-looking
 * bodies) and credential-shaped stored fields.
 *
 * CTRL-014 refinements: the manifest legitimately gains the
 * `https://chat.z.ai/*` provider host permission and EXACTLY ONE
 * content script (page/zaiPage.js — the generic closed-vocabulary
 * DOM primitive executor for the Z.ai Worker adapter). ChatGPT
 * remains unauthorized (no host permission, no content script —
 * CTRL-015 scope). The DOM-automation ban now separates the two
 * layers: background/service-worker modules STILL contain no DOM
 * API at all (all provider knowledge is locator strings inside the
 * adapter), while page/zaiPage.js is the single declared DOM
 * executor whose vocabulary is closed (probe/click/clickIndex/type/
 * pressEnter — no evaluation, no network, no storage, no remote
 * code).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { EXTENSION_ROOT, loadManifest, readExtensionFile } from "./fixtures.js";

test("the manifest parses as Manifest V3 with the minimal permissions", () => {
  const manifest = loadManifest();
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ["storage", "tabs"]);
  // The four hosts are: the GitHub REST API, raw repository content,
  // github.com for exactly the OAuth device-flow endpoints (API
  // posts, never page interaction — no github.com content script),
  // and chat.z.ai for exactly the CTRL-014 Z.ai Worker adapter's
  // page surface (the single declared content script).
  assert.deepEqual(manifest.host_permissions, [
    "https://api.github.com/*",
    "https://raw.githubusercontent.com/*",
    "https://github.com/*",
    "https://chat.z.ai/*",
  ]);
  // No other API permissions (no identity, no scripting, no webRequest...).
  assert.deepEqual(manifest.permissions, ["storage", "tabs"]);
});

test("the manifest documents the OAuth deployment configuration with the minimal scope", () => {
  const manifest = loadManifest();
  assert.deepEqual(manifest.oauth2, {
    client_id: "PASTE-YOUR-GITHUB-OAUTH-CLIENT-ID-HERE",
    scopes: ["public_repo"],
  });
  // The shipped client id is a recognizable PLACEHOLDER (Chrome refuses
  // to load a manifest with an empty one): the operator replaces it with
  // their own GitHub OAuth App's PUBLIC client id (documented in
  // README). The placeholder makes the connection fail closed as
  // AUTHORIZATION_NOT_CONFIGURED — never a guess.
  const identity = readExtensionFile("src/githubIdentity.js");
  assert.match(identity, /UNCONFIGURED_CLIENT_ID = "PASTE-YOUR-GITHUB-OAUTH-CLIENT-ID-HERE"/);
});

test("the manifest grants exactly the Z.ai provider host and ONE content script; ChatGPT stays unauthorized (CTRL-015 scope)", () => {
  const manifest = loadManifest();
  const hosts = JSON.stringify(manifest.host_permissions ?? []);
  assert.equal(hosts.includes("chat.z.ai"), true); // CTRL-014: the authorized Worker adapter surface
  assert.equal(hosts.includes("chatgpt.com"), false); // CTRL-015: not yet authorized
  // Exactly one content script, matched ONLY to the Z.ai origin,
  // loading only the local page surface, after the document settles.
  assert.equal(Array.isArray(manifest.content_scripts), true);
  assert.equal(manifest.content_scripts.length, 1);
  const script = manifest.content_scripts[0];
  assert.deepEqual(script.matches, ["https://chat.z.ai/*"]);
  assert.deepEqual(script.js, ["page/zaiPage.js"]);
  assert.equal(script.run_at, "document_idle");
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.deepEqual(manifest.optional_permissions ?? [], []);
});

test("the content script grants no automation API beyond the DOM primitives (no scripting/declarativeNetRequest)", () => {
  const manifest = loadManifest();
  // The content script is declared statically in the manifest: the
  // dynamic chrome.scripting API is NOT requested and never used.
  assert.equal(manifest.permissions.includes("scripting"), false);
  assert.equal(manifest.permissions.includes("declarativeNetRequest"), false);
  assert.equal(manifest.permissions.includes("webRequest"), false);
  assert.equal(manifest.permissions.includes("cookies"), false);
  const page = readExtensionFile("page/zaiPage.js");
  // Code-only scan (comment prose may legitimately mention the
  // provider origin; code may never reference a remote URL).
  const pageCode = page
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");
  // No remote code, no network, no storage, no credential surface.
  assert.equal(/https?:\/\/[^"'` ]+/.test(pageCode), false);
  assert.equal(pageCode.includes("fetch("), false);
  assert.equal(pageCode.includes("XMLHttpRequest"), false);
  assert.equal(pageCode.includes("localStorage"), false);
  assert.equal(pageCode.includes("chrome.storage"), false);
  // The closed op vocabulary; nothing evaluates arbitrary code.
  assert.equal(pageCode.includes("eval("), false);
  assert.equal(pageCode.includes("Function("), false);
  // The ONLY key the surface can press is Enter, on explicit command.
  assert.ok(/pressEnter/.test(page));
  assert.ok(!/pressTab|pressEscape|pressControl/.test(page));
});

test("the github.com host grant carries no page-automation surface", () => {
  // github.com is granted ONLY for the documented OAuth endpoints; no
  // content scripts, no scripting API, no injected anything — GitHub
  // page-click automation is forbidden by the Work Order and absent.
  const manifest = loadManifest();
  // github.com has NO content script: the only declared script is
  // matched to chat.z.ai alone.
  assert.equal(
    (manifest.content_scripts ?? []).every((cs) => JSON.stringify(cs.matches).includes("github.com") === false),
    true
  );
  assert.equal(manifest.permissions.includes("scripting"), false);
  assert.equal(manifest.permissions.includes("declarativeNetRequest"), false);
  const identity = readExtensionFile("src/githubIdentity.js");
  // The only github.com URLs the product CODE references are the two
  // OAuth endpoints (comment prose is excluded from the scan).
  const codeOnly = identity
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");
  const githubUrls = [...codeOnly.matchAll(/https:\/\/github\.com[^"'\s)]*/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(githubUrls)].sort(), [
    "https://github.com/login/device/code",
    "https://github.com/login/oauth/access_token",
  ]);
});

test("every manifest-referenced file exists on disk (load-unpacked proof)", () => {
  const manifest = loadManifest();
  const referenced = [
    manifest.action.default_popup,
    manifest.background.service_worker,
    "popup/popup.js",
    "popup/popup.css",
    ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js),
  ];
  for (const relative of referenced) {
    const path = join(EXTENSION_ROOT, relative);
    assert.equal(existsSync(path), true, `missing manifest-referenced file: ${relative}`);
    assert.equal(statSync(path).isFile(), true, relative);
  }
});

test("no remote code: the popup loads only local module scripts", () => {
  const html = readExtensionFile("popup/popup.html");
  const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ["popup.js"]);
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(html), false); // no inline scripts
  const js = readExtensionFile("popup/popup.js");
  assert.equal(/https?:\/\/[^"'` ]+/.test(js), false); // no remote script URLs
});

test("the popup speaks ONLY through the typed message boundary", () => {
  const js = readExtensionFile("popup/popup.js");
  assert.match(js, /chrome\.runtime\.sendMessage/);
  // The popup must not touch storage, network, or tabs directly:
  assert.equal(js.includes("chrome.storage"), false);
  assert.equal(js.includes("fetch("), false);
  assert.equal(js.includes("chrome.tabs"), false);
});

test("the service worker wires exactly the real chrome surfaces and one listener", () => {
  const js = readExtensionFile("src/service.js");
  assert.match(js, /chrome\.storage\.local/);
  assert.match(js, /chrome\.runtime\.onMessage\.addListener/);
  assert.match(js, /chrome\.tabs/);
  assert.equal((js.match(/onMessage\.addListener/g) ?? []).length, 1);
});

test("the background modules contain no DOM automation — all provider knowledge is locator strings inside the adapter (CTRL-014)", () => {
  // Background modules run in the service worker: no DOM API at all.
  // zaiAdapter.js and zaiPageBridge.js join this list: they carry
  // Z.ai locator STRINGS and typed sequencing only — the DOM itself
  // is touched exclusively by the declared content script.
  const backgroundSources = [
    "src/service.js",
    "src/messages.js",
    "src/providers.js",
    "src/registration.js",
    "src/repository.js",
    "src/controllerClient.js",
    "src/authority.js",
    "src/configuration.js",
    "src/tabDiscovery.js",
    "src/githubIdentity.js",
    "src/githubClient.js",
    "src/zaiAdapter.js",
    "src/zaiPageBridge.js",
    "src/errors.js",
    "src/forms.js",
  ];
  for (const source of backgroundSources) {
    const text = readExtensionFile(source);
    for (const pattern of [
      /document\.(querySelector|getElementById|getElementsBy|createElement|createTextNode|body|head|title|addEventListener)/,
      /querySelector/,
      /MutationObserver/,
      /insertCSS/,
      /executeScript/,
      /chrome\.scripting/,
      /dispatchEvent/,
      /\.click\(\)/,
    ]) {
      assert.equal(pattern.test(text), false, `${source} contains DOM-automation pattern ${pattern}`);
    }
  }
  // The popup renders its OWN page only: automation APIs stay banned,
  // and it neither fetches provider hosts nor injects scripts.
  const popup = readExtensionFile("popup/popup.js");
  for (const pattern of [
    /MutationObserver/,
    /insertCSS/,
    /executeScript/,
    /chrome\.scripting/,
    /dispatchEvent/,
    /\.click\(\)/,
  ]) {
    assert.equal(pattern.test(popup), false, `popup.js contains automation pattern ${pattern}`);
  }
  assert.equal(popup.includes("chrome.tabs"), false);
});

test("no credential material in any extension source", () => {
  const sources = [
    "src/service.js",
    "src/messages.js",
    "src/providers.js",
    "src/registration.js",
    "src/repository.js",
    "src/controllerClient.js",
    "src/authority.js",
    "src/configuration.js",
    "src/tabDiscovery.js",
    "src/githubIdentity.js",
    "src/githubClient.js",
    "src/zaiAdapter.js",
    "src/zaiPageBridge.js",
    "src/errors.js",
    "src/forms.js",
    "page/zaiPage.js",
    "popup/popup.js",
    "popup/popup.html",
    "manifest.json",
  ];
  // Literal credential material (token prefixes with real-looking
  // bodies, including the OAuth token types gho_/ghu_/ghs_/ghr_), and
  // credential-shaped literal field assignments. Comments may say
  // "the extension never stores passwords"; code may never HAVE a
  // literal secret. The transient `Authorization: Bearer ${token}`
  // header ASSEMBLY is legitimate CTRL-013 code — a literal token
  // after "Bearer " would not be.
  const banned = [
    /ghp_[A-Za-z0-9]{8,}/,
    /gho_[A-Za-z0-9]{8,}/,
    /ghu_[A-Za-z0-9]{8,}/,
    /ghs_[A-Za-z0-9]{8,}/,
    /ghr_[A-Za-z0-9]{8,}/,
    /github_pat_[A-Za-z0-9_]{8,}/,
    /sk-[A-Za-z0-9]{8,}/,
    /Bearer [A-Za-z0-9_\-]{16,}/,
    /(password|secret|credential|cookie|apikey)\s*:\s*["'`]/,
    /(password|secret|credential|cookie|apikey)\s*=\s*["'`]/,
  ];
  for (const source of sources) {
    const text = readExtensionFile(source);
    for (const pattern of banned) {
      assert.equal(pattern.test(text), false, `${source} contains credential pattern ${pattern}`);
    }
  }
  // The popup has no token/PAT input surface at all (the Work Order's
  // hard rule): no password input, no token-named input. (Comments may
  // discuss the token doctrine; input ELEMENTS are the surface.)
  const html = readExtensionFile("popup/popup.html");
  assert.equal(/type=["']password["']/.test(html), false);
  for (const input of ["token", "pat", "secret", "password", "credential", "apikey"]) {
    assert.equal(html.includes(`name="${input}"`), false, `popup has a ${input} input`);
    assert.equal(html.includes(`id="${input}`), false, `popup has a ${input} input`);
  }
  const popupJs = readExtensionFile("popup/popup.js");
  assert.equal(/name=["'](token|pat|secret|password|credential|apikey)["']/.test(popupJs), false);
  assert.equal(/\.value\s*&&\s*send\(\{[^}]*token/i.test(popupJs), false);
});
