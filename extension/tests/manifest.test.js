/**
 * Manifest and packaging tests (CTRL-012): the extension loads
 * unpacked with exactly the declared, minimal surface — every
 * manifest-referenced file exists, permissions are minimal, no remote
 * code, no content scripts, no provider host permissions.
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
  assert.deepEqual(manifest.host_permissions, [
    "https://api.github.com/*",
    "https://raw.githubusercontent.com/*",
  ]);
});

test("the manifest grants NO provider host permissions (adapters come later)", () => {
  const manifest = loadManifest();
  const hosts = JSON.stringify(manifest.host_permissions ?? []);
  assert.equal(hosts.includes("chat.z.ai"), false);
  assert.equal(hosts.includes("chatgpt.com"), false);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.deepEqual(manifest.optional_permissions ?? [], []);
});

test("every manifest-referenced file exists on disk (load-unpacked proof)", () => {
  const manifest = loadManifest();
  const referenced = [
    manifest.action.default_popup,
    manifest.background.service_worker,
    "popup/popup.js",
    "popup/popup.css",
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

test("the extension source contains no provider DOM automation (CTRL-014/015 scope)", () => {
  // Background modules run in the service worker: no DOM API at all.
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

test("no credential fields, auth headers, or secret material in any extension source", () => {
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
    "popup/popup.js",
    "popup/popup.html",
    "manifest.json",
  ];
  // Credential FIELD NAMES (a colon makes it code, not doctrine prose),
  // auth headers, and secret prefixes. Comments may say "the extension
  // never stores passwords"; code may never HAVE one.
  const banned = [
    /ghp_[A-Za-z0-9]/,
    /github_pat_/,
    /sk-[A-Za-z0-9]/,
    /Bearer\s/,
    /Authorization/,
    /(password|secret|credential|cookie|apikey)\s*:/,
    /(password|secret|credential|cookie|apikey)\s*=/,
  ];
  for (const source of sources) {
    const text = readExtensionFile(source);
    for (const pattern of banned) {
      assert.equal(pattern.test(text), false, `${source} contains credential pattern ${pattern}`);
    }
  }
});
