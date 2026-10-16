#!/usr/bin/env node
/**
 * Generate the Controller icon (128px, the loop glyph: three nodes in a
 * directed cycle — monitor -> harvest -> review -> dispatch) via Playwright.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#0d1220"/>
  <g fill="none" stroke="#3f6df4" stroke-width="6" stroke-linecap="round">
    <path d="M 64 30 A 34 34 0 1 1 30.6 56" />
    <path d="M 98 72 A 34 34 0 0 1 41 92" opacity="0.45"/>
    <path d="M 26 46 l 5 11 l 11 -4" />
  </g>
  <circle cx="64" cy="30" r="7" fill="#3f6df4"/>
  <circle cx="30" cy="64" r="7" fill="#7ba0ff"/>
  <circle cx="98" cy="86" r="7" fill="#3f6df4" opacity="0.55"/>
</svg>`;

async function main() {
  const { chromium } = await import("playwright");
  await mkdir(resolve(root, "icons"), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
  await page.setContent(
    `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${ICON_SVG}</body></html>`,
  );
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(root, "icons/icon-128.png"), omitBackground: true });
  await browser.close();
  process.stdout.write("[icon] icons/icon-128.png written\n");
}

main().catch((error) => {
  process.stderr.write(`[icon] failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
