/**
 * Canonical repository identity validation tests (CTRL-012).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateRepositoryIdentity } from "../src/repository.js";

test("canonical owner/name identities validate with owner/name split", () => {
  for (const identity of ["pectoraux/controller", "pectoraux/smallapp", "a/b", "A-1234-x/repo_name.v2"]) {
    const result = validateRepositoryIdentity(identity);
    assert.equal(result.ok, true, identity);
    assert.equal(result.repository, identity);
    const [owner, name] = identity.split("/");
    assert.equal(result.owner, owner);
    assert.equal(result.name, name);
  }
});

test("ambiguous or invalid identities fail closed with INVALID_REPOSITORY", () => {
  const bad = [
    "",                            // empty
    "   ",                         // whitespace-only
    " pectoraux/controller",       // leading whitespace
    "pectoraux/controller ",       // trailing whitespace
    "pectoraux",                   // no slash
    "pectoraux/",                  // empty name
    "/controller",                 // empty owner
    "pectoraux/controller/x",      // extra path segment
    "pectoraux//controller",       // double slash
    "pectoraux controller",        // space instead of slash
    "-pectoraux/controller",       // leading hyphen owner
    "pectoraux-/controller",       // trailing hyphen owner
    "-/controller",                // hyphen-only owner
    "x".repeat(40) + "/controller", // owner too long
    "owner/..",                    // dot-dot repo name
    "owner/.",                     // dot repo name
    "owner/repo!",                 // illegal character in repo name
    42,                            // not a string
    null,
  ];
  for (const identity of bad) {
    const result = validateRepositoryIdentity(identity);
    assert.equal(result.ok, false, JSON.stringify(identity));
    assert.equal(result.error.code, "INVALID_REPOSITORY", JSON.stringify(identity));
  }
});

test("the 39-character owner boundary", () => {
  assert.equal(validateRepositoryIdentity("x".repeat(39) + "/repo").ok, true);
  assert.equal(validateRepositoryIdentity("x".repeat(40) + "/repo").ok, false);
});

test("single-character owner and hyphenated owners validate", () => {
  assert.equal(validateRepositoryIdentity("p/repo").ok, true);
  assert.equal(validateRepositoryIdentity("p-x-y/repo").ok, true);
});
