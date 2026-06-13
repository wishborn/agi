import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerIdentityProvidersRoute } from "./identity-api.js";
import type { OAuthHandler } from "./oauth-handler.js";
import type { Db } from "@agi/db-schema/client";
import { IDENTITY_PROVIDER_ORDER, type IdentityProviderView } from "./identity-providers.js";

interface ConnRow {
  provider: string;
  accountLabel: string | null;
  role: string;
}

/** Minimal Db stub: select(...).from(table) resolves to the given rows. */
function fakeDb(rows: ConnRow[]): Db {
  return {
    select: () => ({ from: () => Promise.resolve(rows) }),
  } as unknown as Db;
}

function makeApp(opts: {
  rows?: ConnRow[];
  availableOAuth?: string[];
  federationEnabled?: boolean;
  startFlow?: (provider: string) => { authUrl: string; state: string } | null;
  writes?: Array<{ provider: string; creds: { clientId: string; clientSecret: string } | null }>;
}) {
  const app = Fastify({ logger: false });
  const oauthHandler = {
    getAvailableProviders: () => opts.availableOAuth ?? [],
    startFlow: opts.startFlow ?? (() => null),
  } as unknown as OAuthHandler;
  registerIdentityProvidersRoute(app, {
    oauthHandler,
    db: fakeDb(opts.rows ?? []),
    federationEnabled: () => opts.federationEnabled ?? false,
    writeOAuthApp: (provider, creds) => {
      opts.writes?.push({ provider, creds });
      return true;
    },
  });
  return app;
}

async function getProviders(app: ReturnType<typeof makeApp>): Promise<IdentityProviderView[]> {
  const res = await app.inject({ method: "GET", url: "/api/auth/providers" });
  expect(res.statusCode).toBe(200);
  return (res.json() as { providers: IdentityProviderView[] }).providers;
}

describe("GET /api/auth/providers — canonical 6 + live status (s212 t774)", () => {
  it("returns all 6 canonical providers in stable order", async () => {
    const app = makeApp({});
    const providers = await getProviders(app);
    expect(providers.map((p) => p.id)).toEqual(IDENTITY_PROVIDER_ORDER);
  });

  it("defaults: GitHub available, redirect providers need-config, Civicognita federation-gated", async () => {
    const app = makeApp({});
    const providers = await getProviders(app);
    const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
    expect(byId.github!.status).toBe("available");
    expect(byId.google!.status).toBe("needs-config");
    expect(byId.x!.status).toBe("needs-config");
    expect(byId.civicognita!.status).toBe("federation-gated");
  });

  it("reflects an existing GitHub connection with its account label", async () => {
    const app = makeApp({ rows: [{ provider: "github", accountLabel: "octocat", role: "owner" }] });
    const providers = await getProviders(app);
    const gh = providers.find((p) => p.id === "github")!;
    expect(gh.status).toBe("connected");
    expect(gh.connectedLabel).toBe("octocat");
  });

  it("a configured OAuth app flips a redirect provider to 'available'", async () => {
    const app = makeApp({ availableOAuth: ["google"] });
    const providers = await getProviders(app);
    expect(providers.find((p) => p.id === "google")!.status).toBe("available");
    expect(providers.find((p) => p.id === "meta")!.status).toBe("needs-config");
  });

  it("federation online makes Civicognita connectable", async () => {
    const app = makeApp({ federationEnabled: true });
    const providers = await getProviders(app);
    expect(providers.find((p) => p.id === "civicognita")!.status).toBe("available");
  });
});

describe("OAuth app credential endpoints (s212 t779)", () => {
  it("PUT /api/auth/providers/:id/app persists creds for a redirect provider", async () => {
    const writes: Array<{ provider: string; creds: { clientId: string; clientSecret: string } | null }> = [];
    const app = makeApp({ writes });
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/providers/google/app",
      payload: { clientId: "cid", clientSecret: "sec" },
    });
    expect(res.statusCode).toBe(200);
    expect(writes).toEqual([{ provider: "google", creds: { clientId: "cid", clientSecret: "sec" } }]);
  });

  it("PUT rejects missing creds (400) and non-redirect providers (400)", async () => {
    const app = makeApp({});
    const missing = await app.inject({ method: "PUT", url: "/api/auth/providers/google/app", payload: { clientId: "cid" } });
    expect(missing.statusCode).toBe(400);
    // github is device-mode, not a redirect provider that accepts an app
    const wrong = await app.inject({ method: "PUT", url: "/api/auth/providers/github/app", payload: { clientId: "a", clientSecret: "b" } });
    expect(wrong.statusCode).toBe(400);
  });

  it("DELETE /api/auth/providers/:id/app clears creds", async () => {
    const writes: Array<{ provider: string; creds: { clientId: string; clientSecret: string } | null }> = [];
    const app = makeApp({ writes });
    const res = await app.inject({ method: "DELETE", url: "/api/auth/providers/meta/app" });
    expect(res.statusCode).toBe(200);
    expect(writes).toEqual([{ provider: "meta", creds: null }]);
  });

  it("POST /api/auth/start/:provider returns the authUrl when an app is configured", async () => {
    const app = makeApp({ startFlow: (p) => ({ authUrl: `https://auth/${p}`, state: "st" }) });
    const res = await app.inject({ method: "POST", url: "/api/auth/start/google" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { authUrl: string }).authUrl).toBe("https://auth/google");
  });

  it("POST /api/auth/start/:provider is 400 when the provider isn't connectable", async () => {
    const app = makeApp({ startFlow: () => null });
    const res = await app.inject({ method: "POST", url: "/api/auth/start/meta" });
    expect(res.statusCode).toBe(400);
  });
});
