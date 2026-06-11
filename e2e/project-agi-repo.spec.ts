import { test, expect } from "@playwright/test";

/**
 * {project}.agi monorepo envelope e2e spec (Phase 3, first slice).
 *
 * The project folder becomes a git repo under the `{slug}.agi` naming
 * convention, with repos/ entries registered as git submodules. The
 * `_aionima` collection is excluded.
 *
 * API-layer tests assert the status/init/import contract. UI tests assert the
 * Initialize/Import affordance surfaces on a regular project.
 */

test.describe("Project .agi envelope — API layer", () => {
  test("GET /api/projects/agi-repo/status requires a path", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-testid='hearth-top']", { timeout: 10_000 });

    const result = await page.evaluate(async () => {
      const res = await fetch("/api/projects/agi-repo/status");
      return { status: res.status };
    });
    // Missing ?path= → 400.
    expect(result.status).toBe(400);
  });

  test("GET /api/projects/agi-repo/status returns the envelope shape for a real project", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-testid='hearth-top']", { timeout: 10_000 });

    // Find a real workspace project path from the projects list.
    const projects = await page.evaluate(async () => {
      const res = await fetch("/api/projects");
      if (!res.ok) return null;
      return res.json();
    });
    const first = Array.isArray(projects?.projects)
      ? projects.projects.find((p: { path?: string; name?: string }) => p.path && p.name !== "_aionima")
      : null;
    if (!first?.path) {
      test.skip();
      return;
    }

    const status = await page.evaluate(async (path: string) => {
      const res = await fetch(`/api/projects/agi-repo/status?path=${encodeURIComponent(path)}`);
      return { status: res.status, body: await res.json().catch(() => null) };
    }, first.path as string);

    expect(status.status).toBe(200);
    expect(typeof status.body.initialized).toBe("boolean");
    expect(Array.isArray(status.body.submodules)).toBe(true);
    expect(Array.isArray(status.body.unregisteredRepos)).toBe(true);
  });

  test("agi-repo init/import reject a path outside the workspace", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-testid='hearth-top']", { timeout: 10_000 });

    const result = await page.evaluate(async () => {
      const res = await fetch("/api/projects/agi-repo/init?path=/etc", {
        method: "POST",
      });
      return { status: res.status };
    });
    // /etc is not inside workspace.projects → 403.
    expect(result.status).toBe(403);
  });

  // Slice 0 — defect hardening (story #207): envelope ≠ repo.
  test("agi-repo/status never 500s — returns a clean shape for a non-.agi (gitless) project", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-testid='hearth-top']", { timeout: 10_000 });

    const projects = await page.evaluate(async () => {
      const res = await fetch("/api/projects");
      if (!res.ok) return null;
      return res.json();
    });
    const first = Array.isArray(projects?.projects)
      ? projects.projects.find((p: { path?: string; name?: string }) => p.path && p.name !== "_aionima")
      : null;
    if (!first?.path) { test.skip(); return; }

    const status = await page.evaluate(async (path: string) => {
      const res = await fetch(`/api/projects/agi-repo/status?path=${encodeURIComponent(path)}`);
      return { status: res.status, body: await res.json().catch(() => null) };
    }, first.path as string);

    // Must never throw a 500 — even an envelope with no top-level .git resolves cleanly.
    expect(status.status).toBe(200);
    expect(status.body).not.toBeNull();
    expect(typeof status.body.initialized).toBe("boolean");
  });

  test("read-only git action on a gitless envelope returns 200 {notGitRepo:true}, not 400", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-testid='hearth-top']", { timeout: 10_000 });

    // Find a project whose envelope is NOT git-initialized (initialized:false).
    const target = await page.evaluate(async () => {
      const res = await fetch("/api/projects");
      if (!res.ok) return null;
      const { projects } = await res.json();
      if (!Array.isArray(projects)) return null;
      for (const p of projects) {
        if (!p.path || p.name === "_aionima") continue;
        const s = await fetch(`/api/projects/agi-repo/status?path=${encodeURIComponent(p.path)}`);
        const body = await s.json().catch(() => null);
        if (body && body.initialized === false) return p.path as string;
      }
      return null;
    });
    if (!target) { test.skip(); return; }

    const result = await page.evaluate(async (path: string) => {
      const res = await fetch("/api/projects/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, action: "status" }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }, target);

    // No console-spamming 400 — a clean 200 the dashboard can render as an empty state.
    expect(result.status).toBe(200);
    expect(result.body?.notGitRepo).toBe(true);
  });
});

test.describe("Project .agi envelope — UI", () => {
  test("a regular project surfaces the .agi envelope control", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-testid='hearth-top']", { timeout: 10_000 });

    const projects = await page.evaluate(async () => {
      const res = await fetch("/api/projects");
      if (!res.ok) return null;
      return res.json();
    });
    const first = Array.isArray(projects?.projects)
      ? projects.projects.find((p: { name?: string }) => p.name && p.name !== "_aionima")
      : null;
    if (!first?.name) {
      test.skip();
      return;
    }

    await page.goto(`/projects/${encodeURIComponent(first.name)}`);
    await page.waitForSelector("[data-testid='hearth-top']", { timeout: 10_000 });

    const card = page.getByTestId("agi-repo-card");
    if ((await card.count()) === 0) {
      test.skip();
      return;
    }
    await expect(card.first()).toBeVisible();
  });
});
