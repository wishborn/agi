/**
 * agi-repo-manager — {project}.agi monorepo envelope (Phase 3, first slice).
 *
 * Formalizes a project folder as a git repository under the hard `{slug}.agi`
 * naming convention. The `.agi` suffix distinguishes the project *envelope*
 * from the actual repos it contains. Each entry under `repos/` that is itself
 * a git repo is registered as a git **submodule** of the envelope; the
 * envelope tracks `project.json`, `k/`, and `.gitmodules` directly while
 * ignoring scratch (`sandbox/`, `.trash/`).
 *
 * Owner-confirmed mechanics only. Deferred (NOT here): the Tynn-desktop
 * discovery handshake + shared schema convergence, `{slug}.agi` GitHub remote
 * auto-creation, and automatic submodule-pin advancement on upgrade.
 *
 * The `_aionima` meta-project is EXCLUDED — it keeps its `collection.json`
 * convention and is not a `{slug}.agi` project.
 *
 * All git invocations go through spawnSync with array args (no shell), so a
 * malicious path or URL cannot inject a command.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const GIT_TIMEOUT_MS = 30_000;

// Committer identity for envelope commits — the gateway acts on the owner's
// behalf. Passed per-commit so a missing global git config never blocks init.
const COMMIT_ENV = [
  "-c",
  "user.name=Aionima",
  "-c",
  "user.email=aion@aionima.local",
];

export interface AgiRepoStatus {
  /** True when the envelope folder is a git repo. */
  initialized: boolean;
  /** Submodule paths registered in `.gitmodules` (e.g. ["repos/agi"]). */
  submodules: string[];
  /** Subdirs under `repos/` that are git repos but NOT yet registered as
   *  submodules — candidates for import. */
  unregisteredRepos: string[];
}

export interface AgiRepoOpResult {
  ok: boolean;
  initialized?: boolean;
  registered?: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// git helper
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: GIT_TIMEOUT_MS });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? res.error?.message ?? "").trim(),
  };
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** A project is the `_aionima` meta-project — excluded from the .agi model. */
function isExcludedEnvelope(projectPath: string): boolean {
  return basename(projectPath) === "_aionima";
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Subdirs of `<projectPath>/repos/` that are themselves git repos. */
function detectRepoGitDirs(projectPath: string): string[] {
  const reposDir = join(projectPath, "repos");
  if (!existsSync(reposDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(reposDir, { withFileTypes: true })) {
    if (entry.isDirectory() && isGitRepo(join(reposDir, entry.name))) {
      out.push(entry.name);
    }
  }
  return out.sort();
}

/** Submodule paths listed in `<projectPath>/.gitmodules`. */
function readSubmodulePaths(projectPath: string): string[] {
  const modulesFile = join(projectPath, ".gitmodules");
  if (!existsSync(modulesFile)) return [];
  const text = readFileSync(modulesFile, "utf-8");
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (m?.[1]) paths.push(m[1]);
  }
  return paths.sort();
}

export function getAgiRepoStatus(projectPath: string): AgiRepoStatus {
  const initialized = isGitRepo(projectPath);
  const submodules = initialized ? readSubmodulePaths(projectPath) : [];
  const registered = new Set(submodules.map((p) => p.replace(/^repos\//, "")));
  const unregisteredRepos = detectRepoGitDirs(projectPath).filter((name) => !registered.has(name));
  return { initialized, submodules, unregisteredRepos };
}

// ---------------------------------------------------------------------------
// Init — make the envelope a git repo
// ---------------------------------------------------------------------------

/**
 * `git init` the project envelope, write a `.gitignore` that excludes scratch
 * (`sandbox/`, `.trash/`), and commit the skeleton (`project.json`, `k/`).
 * Idempotent: a no-op when the envelope is already a git repo.
 */
export function initAgiRepo(projectPath: string): AgiRepoOpResult {
  if (isExcludedEnvelope(projectPath)) {
    return { ok: false, error: "_aionima is a collection, not a {slug}.agi project" };
  }
  if (!existsSync(projectPath)) {
    return { ok: false, error: `project path does not exist: ${projectPath}` };
  }
  if (isGitRepo(projectPath)) {
    return { ok: true, initialized: true };
  }

  const init = git(["init"], projectPath);
  if (!init.ok) return { ok: false, error: `git init failed: ${init.stderr}` };

  // Scratch + soft-delete are envelope-local, never committed.
  const gitignore = join(projectPath, ".gitignore");
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, ["sandbox/", ".trash/", "node_modules/", ""].join("\n"), "utf-8");
  }

  // Stage envelope-owned content only (project.json, k/, .gitignore). repos/
  // entries become submodules separately, not regular tracked content.
  for (const rel of ["project.json", "k", ".gitignore"]) {
    if (existsSync(join(projectPath, rel))) git(["add", "--", rel], projectPath);
  }

  const commit = git([...COMMIT_ENV, "commit", "-m", "Initialize .agi envelope"], projectPath);
  // An empty skeleton with nothing staged yields "nothing to commit" — still a
  // successfully-initialized repo, so don't treat that as failure.
  if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
    return { ok: false, error: `initial commit failed: ${commit.stderr}` };
  }

  return { ok: true, initialized: true };
}

// ---------------------------------------------------------------------------
// Submodule registration
// ---------------------------------------------------------------------------

/**
 * Register `repos/<name>` as a git submodule pointing at `url`. Used when a new
 * repo is added to the project. Requires the envelope to be initialized.
 */
export function addRepoSubmodule(
  projectPath: string,
  name: string,
  url: string,
  branch?: string,
): AgiRepoOpResult {
  if (!isGitRepo(projectPath)) {
    return { ok: false, error: "envelope is not a .agi repo — initialize it first" };
  }
  const relPath = `repos/${name}`;
  const args = ["submodule", "add"];
  if (branch) args.push("-b", branch);
  args.push("--", url, relPath);

  const add = git(args, projectPath);
  if (!add.ok) {
    return { ok: false, error: `git submodule add failed: ${add.stderr}` };
  }
  git([...COMMIT_ENV, "commit", "-m", `Add submodule ${relPath}`], projectPath);
  return { ok: true, registered: [relPath] };
}

// ---------------------------------------------------------------------------
// Import — adopt an existing folder as a .agi envelope
// ---------------------------------------------------------------------------

/**
 * Adopt an existing project folder as a `{slug}.agi` envelope: initialize the
 * envelope if needed, then register every git repo already present under
 * `repos/` as a submodule (deriving the remote from its `origin`). Returns the
 * list of newly-registered submodule paths.
 */
export function importAgiRepo(projectPath: string): AgiRepoOpResult {
  if (isExcludedEnvelope(projectPath)) {
    return { ok: false, error: "_aionima is a collection, not a {slug}.agi project" };
  }

  if (!isGitRepo(projectPath)) {
    const init = initAgiRepo(projectPath);
    if (!init.ok) return init;
  }

  const already = new Set(readSubmodulePaths(projectPath).map((p) => p.replace(/^repos\//, "")));
  const registered: string[] = [];

  for (const name of detectRepoGitDirs(projectPath)) {
    if (already.has(name)) continue;
    const reposChild = join(projectPath, "repos", name);
    const originRes = git(["remote", "get-url", "origin"], reposChild);
    if (!originRes.ok || !originRes.stdout) {
      // No origin to point the submodule at — skip rather than fabricate one.
      continue;
    }
    const add = git(["submodule", "add", "--", originRes.stdout, `repos/${name}`], projectPath);
    if (add.ok) {
      registered.push(`repos/${name}`);
    }
  }

  if (registered.length > 0) {
    git([...COMMIT_ENV, "commit", "-m", `Import ${String(registered.length)} repo(s) as submodules`], projectPath);
  }

  return { ok: true, initialized: true, registered };
}
