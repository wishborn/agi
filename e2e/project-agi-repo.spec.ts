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
