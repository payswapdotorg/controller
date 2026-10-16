/**
 * Manifest + bundle structural tests (the Firefox compatibility surface):
 * Playwright cannot load Firefox extensions headlessly, so the Firefox target
 * is verified structurally here: correct MV3 event-page manifest (scripts,
 * gecko id, no service_worker), the IIFE bundle parses, and the shared source
 * manifest stays dual-target clean.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

test("the source manifest is a dual-target-clean MV3 manifest", () => {
  const manifest = readJson("manifest.json");
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ["alarms", "scripting", "storage", "tabs"]);
  assert.ok(manifest.background.service_worker === "src/service.js");
  assert.ok(manifest.host_permissions.includes("https://api.github.com/*"));
  assert.ok(manifest.host_permissions.includes("https://chat.z.ai/*"));
  assert.ok(manifest.content_scripts[0].matches.includes("https://chat.z.ai/*"));
});

test("the chromium dist manifest keeps the service worker + module type", () => {
  const manifest = readJson("dist/chromium/manifest.json");
  assert.equal(manifest.background.service_worker, "service.js");
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.minimum_chrome_version, "110");
  assert.ok(existsSync(join(root, "dist/chromium/service.js")));
  assert.ok(existsSync(join(root, "dist/chromium/content/chatzai-content.js")));
  // Opera-class compatibility: no Chrome-only permission flags.
  for (const permission of manifest.permissions) {
    assert.match(permission, /^(storage|tabs|alarms|scripting)$/);
  }
});

test("the firefox dist manifest is an event page with a gecko id", () => {
  const manifest = readJson("dist/firefox/manifest.json");
  assert.equal(manifest.background.scripts[0], "background.js");
  assert.equal(manifest.background.service_worker, undefined);
  assert.equal(manifest.browser_specific_settings.gecko.id, "controller@payswapdotorg.github");
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "115.0");
  assert.ok(existsSync(join(root, "dist/firefox/background.js")));
});

test("the firefox bundles parse as classic scripts", () => {
  for (const bundle of ["dist/firefox/background.js", "dist/firefox/content/chatzai-content.js"]) {
    execFileSync(process.execPath, ["--check", join(root, bundle)], { stdio: "pipe" });
  }
});

test("the chromium service worker bundle parses", () => {
  execFileSync(process.execPath, ["--check", join(root, "dist/chromium/service.js")], { stdio: "pipe" });
});

test("the popup/options surfaces are present in both targets", () => {
  for (const target of ["chromium", "firefox"]) {
    assert.ok(existsSync(join(root, `dist/${target}/popup/popup.html`)));
    assert.ok(existsSync(join(root, `dist/${target}/popup/popup.js`)));
    assert.ok(existsSync(join(root, `dist/${target}/options/options.html`)));
    assert.ok(existsSync(join(root, `dist/${target}/options/options.js`)));
    assert.ok(existsSync(join(root, `dist/${target}/icons/icon-128.png`)));
  }
});
