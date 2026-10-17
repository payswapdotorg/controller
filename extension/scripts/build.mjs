#!/usr/bin/env node
/**
 * Dual-target build: ONE source tree -> dist/firefox + dist/chromium.
 *
 *   dist/chromium  : MV3 service worker (ESM) — Chrome / Opera / Edge / Brave
 *                    (load unpacked, or package for the Chrome Web Store)
 *   dist/firefox   : MV3 event page (IIFE bundle — Firefox background scripts
 *                    are classic scripts) + browser_specific_settings.gecko.id
 *
 * The content script is an IIFE in both targets (content scripts cannot be
 * ES modules). esbuild is the only build dependency.
 */

import { cp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const esbuild = require("esbuild");

const SOURCE_MANIFEST = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const VERSION = SOURCE_MANIFEST.version;

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function buildTarget(target) {
  const out = join(root, "dist", target);
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "popup"), { recursive: true });
  await mkdir(join(out, "options"), { recursive: true });
  await mkdir(join(out, "icons"), { recursive: true });

  // Background
  if (target === "firefox") {
    await esbuild.build({
      entryPoints: [join(root, "src/service.js")],
      outfile: join(out, "background.js"),
      bundle: true,
      format: "iife",
      platform: "browser",
      target: ["firefox115"],
      logLevel: "info",
    });
  } else {
    await esbuild.build({
      entryPoints: [join(root, "src/service.js")],
      outfile: join(out, "service.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: ["chrome110"],
      logLevel: "info",
    });
  }

  // Content script (IIFE both targets).
  await esbuild.build({
    entryPoints: [join(root, "src/content/chatzai-content.js")],
    outfile: join(out, "content/chatzai-content.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    logLevel: "silent",
  });

  // Static surfaces.
  await cp(join(root, "popup"), join(out, "popup"), { recursive: true });
  await cp(join(root, "options"), join(out, "options"), { recursive: true });
  await cp(join(root, "icons"), join(out, "icons"), { recursive: true });

  // Manifest variant.
  const manifest = {
    ...SOURCE_MANIFEST,
    version: VERSION,
  };
  if (target === "firefox") {
    delete manifest.background;
    manifest.background = { scripts: ["background.js"] };
    manifest.content_scripts = [{ ...SOURCE_MANIFEST.content_scripts[0], js: ["content/chatzai-content.js"] }];
    manifest.browser_specific_settings = {
      gecko: {
        id: "controller@payswapdotorg.github",
        // 142 = the first release supporting data_collection_permissions;
        // current Firefox stable + ESR are well past it.
        strict_min_version: "142.0",
        // Firefox data-collection consent declaration (AMO requirement):
        // the Controller collects NOTHING — storage stays on the machine.
        data_collection_permissions: { required: ["none"] },
      },
    };
    // Firefox MV3 does not use scripting for our declared content script; keep
    // the permission anyway (harmless) so future programmatic injection works.
  } else {
    manifest.background = { service_worker: "service.js", type: "module" };
    manifest.content_scripts = [{ ...SOURCE_MANIFEST.content_scripts[0], js: ["content/chatzai-content.js"] }];
    manifest.minimum_chrome_version = "110";
  }
  await writeJson(join(out, "manifest.json"), manifest);
  process.stdout.write(`[build] dist/${target} ready (v${VERSION})\n`);
}

await buildTarget("chromium");
await buildTarget("firefox");
