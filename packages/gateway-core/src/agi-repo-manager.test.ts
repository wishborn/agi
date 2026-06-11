/**
 * agi-repo-manager tests — Slice 0 hardening (story #207).
 * Pure-logic + real git via spawnSync; runs in the VM.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getAgiRepoStatus, initAgiRepo } from "./agi-repo-manager.js";
import { KNOWLEDGE_DIR } from "./project-config-path.js";

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `agi-repo-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("getAgiRepoStatus — never throws (no 500)", () => {
  it("returns the not-initialized shape for a gitless envelope", () => {
    const proj = join(tmp, "envelope");
    mkdirSync(join(proj, "repos"), { recursive: true });
    const status = getAgiRepoStatus(proj);
    expect(status.initialized).toBe(false);
    expect(status.submodules).toEqual([]);
    expect(Array.isArray(status.unregisteredRepos)).toBe(true);
  });

  it("degrades to not-initialized instead of throwing on a malformed .gitmodules", () => {
    const proj = join(tmp, "broken");
    mkdirSync(join(proj, ".git"), { recursive: true }); // looks initialized
    // A .gitmodules that's actually a directory would make readFileSync throw —
    // getAgiRepoStatus must swallow it, not 500.
    mkdirSync(join(proj, ".gitmodules"), { recursive: true });
    expect(() => getAgiRepoStatus(proj)).not.toThrow();
    expect(getAgiRepoStatus(proj).initialized).toBe(true);
  });

  it("returns a clean shape for a path that does not exist", () => {
    expect(() => getAgiRepoStatus(join(tmp, "nope"))).not.toThrow();
    expect(getAgiRepoStatus(join(tmp, "nope")).initialized).toBe(false);
  });
});

describe("initAgiRepo — chats excluded from the envelope", () => {
  it("writes a .gitignore that excludes the knowledge chat dir, sandbox and .trash", () => {
    const proj = join(tmp, "init-me");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "project.json"), "{}", "utf-8");

    const result = initAgiRepo(proj);
    expect(result.ok).toBe(true);

    const gitignore = readFileSync(join(proj, ".gitignore"), "utf-8");
    expect(gitignore).toContain(`${KNOWLEDGE_DIR}/chat/`);
    expect(gitignore).toContain("sandbox/");
    expect(gitignore).toContain(".trash/");
    // The envelope itself became a git repo.
    expect(existsSync(join(proj, ".git"))).toBe(true);
  });
});
