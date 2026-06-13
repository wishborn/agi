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
}) {
  const app = Fastify({ logger: false });
  const oauthHandler = {
    getAvailableProviders: () => opts.availableOAuth ?? [],
  } as unknown as OAuthHandler;
  registerIdentityProvidersRoute(app, {
    oauthHandler,
    db: fakeDb(opts.rows ?? []),
    federationEnabled: () => opts.federationEnabled ?? false,
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
