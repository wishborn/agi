/**
 * Identity API Routes — REST endpoints for local identity management.
 *
 * Provides:
 * - GET /api/identity/:entityId — get entity identity info
 * - GET /api/identity/resolve/:geid — resolve entity by GEID
 * - POST /api/auth/start/:provider — start OAuth flow
 * - GET /api/auth/callback/:provider — OAuth callback
 * - GET /api/auth/providers — list available OAuth providers
 *
 * Entity CRUD (private-network only, s186):
 * - GET    /api/entities                              — list all entities
 * - POST   /api/entities/guests                       — create guest (#E1+)
 * - PUT    /api/entities/:id/profile                  — update displayName
 * - DELETE /api/entities/:id                          — remove guest (not #E0/$A)
 * - GET    /api/entities/:id/connections              — OAuth connections for entity
 * - DELETE /api/entities/:id/connections/:provider    — remove a connection
 */

import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import { eq, and, inArray } from "drizzle-orm";
import type { IdentityProvider } from "./identity-provider.js";
import type { OAuthHandler } from "./oauth-handler.js";
import { createEntityService } from "./entity-service.js";
import { createComponentLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import type { Db } from "@agi/db-schema/client";
import { connections, entities as entitiesTable, users } from "@agi/db-schema";
import { randomBytes } from "node:crypto";
import { computeIdentityProviderViews, getIdentityProvider } from "./identity-providers.js";
import { encryptToken } from "./crypto-tokens.js";

// ---------------------------------------------------------------------------
// Private-network guard
// ---------------------------------------------------------------------------

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function isPrivate(ip: string): boolean {
  if (isLoopback(ip)) return true;
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const parts = v4.split(".").map(Number);
  if (parts.length === 4) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
  }
  if (ip.startsWith("fe80:")) return true;
  return false;
}

function getClientIp(req: IncomingMessage & { ip?: string }): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

function guardPrivate(req: IncomingMessage & { ip?: string }): string | null {
  const ip = getClientIp(req);
  return isPrivate(ip) ? null : "Only available from private network";
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export interface IdentityApiDeps {
  identityProvider: IdentityProvider;
  oauthHandler: OAuthHandler | null;
  logger?: Logger;
  db?: Db;
  encKey?: Buffer;
  /**
   * Live signal: is the HIVE federation network online? Gates the Civicognita
   * provider on the System ▸ Identity page. Read hot (per-request) so a config
   * toggle takes effect without restart. Defaults to false when omitted.
   */
  federationEnabled?: () => boolean;
}

export interface IdentityProvidersRouteDeps {
  oauthHandler?: OAuthHandler | null;
  db?: Db;
  encKey?: Buffer;
  logger?: Logger;
  /** Live federation-online signal (gates Civicognita). Defaults to false. */
  federationEnabled?: () => boolean;
  /**
   * Persist (or clear, when creds is null) owner OAuth-app credentials to
   * gateway.json `identity.oauth.<provider>`. Read back HOT by oauthHandler so a
   * freshly-pasted app takes effect without a restart. Returns false if the
   * config can't be written (no configPath). Story #212 Slice 2.
   */
  writeOAuthApp?: (provider: string, creds: { clientId: string; clientSecret: string } | null) => boolean;
}

/**
 * Register GET /api/auth/providers — the canonical identity-provider list +
 * live status for the System ▸ Identity page (story #212).
 *
 * Registered UNCONDITIONALLY (not gated on identityProvider) because the list
 * is registry-driven (identity-providers.ts SSOT): it must be available even on
 * bare nodes with no identity brokering configured. Returns each of the 6
 * canonical providers as connected | available | needs-config | federation-gated.
 *
 * Unguarded by design — it exposes provider metadata + connection status (no
 * tokens; token retrieval lives behind the guarded device-flow/token route),
 * and sits behind the dashboard auth gate.
 */
export function registerIdentityProvidersRoute(
  fastify: FastifyInstance,
  deps: IdentityProvidersRouteDeps,
): void {
  const log = createComponentLogger(deps.logger, "identity-providers");

  // GET /api/auth/providers — canonical 6 + live status -----------------------
  fastify.get("/api/auth/providers", async (_request, reply) => {
    // Existing connections (role-agnostic; prefer the owner-role account label).
    // A DB hiccup must not blank the whole list — the providers still render.
    const connectedProviders = new Map<string, string | null>();
    if (deps.db) {
      try {
        const rows = await deps.db
          .select({
            provider: connections.provider,
            accountLabel: connections.accountLabel,
            role: connections.role,
          })
          .from(connections);
        for (const r of rows) {
          if (!connectedProviders.has(r.provider) || r.role === "owner") {
            connectedProviders.set(r.provider, r.accountLabel ?? null);
          }
        }
      } catch {
        /* no connections available — render providers as unconnected */
      }
    }

    // Redirect providers whose owner OAuth-app creds are configured (hot from
    // gateway.json identity.oauth.<provider> via the oauthHandler thunk).
    const appConfigured = new Set(deps.oauthHandler?.getAvailableProviders() ?? []);
    const federationOnline = deps.federationEnabled?.() ?? false;

    const providers = computeIdentityProviderViews({
      connectedProviders,
      appConfigured,
      federationOnline,
    });

    return reply.send({ providers });
  });

  // PUT /api/auth/providers/:id/app — store owner OAuth-app credentials --------
  fastify.put<{ Params: { id: string }; Body: { clientId?: unknown; clientSecret?: unknown } }>(
    "/api/auth/providers/:id/app",
    async (request, reply) => {
      const guard = guardPrivate(request.raw);
      if (guard) return reply.code(403).send({ error: guard });

      const spec = getIdentityProvider(request.params.id);
      if (!spec || spec.authMode !== "redirect") {
        return reply.code(400).send({ error: `Provider does not accept an OAuth app: ${request.params.id}` });
      }
      const clientId = request.body?.clientId;
      const clientSecret = request.body?.clientSecret;
      if (typeof clientId !== "string" || !clientId.trim() || typeof clientSecret !== "string" || !clientSecret.trim()) {
        return reply.code(400).send({ error: "clientId and clientSecret are required" });
      }
      if (!deps.writeOAuthApp) {
        return reply.code(501).send({ error: "Config is not writable on this node" });
      }
      const ok = deps.writeOAuthApp(spec.id, { clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      if (!ok) return reply.code(500).send({ error: "Failed to persist OAuth app credentials" });
      log.info(`OAuth app configured: ${spec.id}`);
      return reply.send({ ok: true });
    },
  );

  // DELETE /api/auth/providers/:id/app — clear stored credentials -------------
  fastify.delete<{ Params: { id: string } }>(
    "/api/auth/providers/:id/app",
    async (request, reply) => {
      const guard = guardPrivate(request.raw);
      if (guard) return reply.code(403).send({ error: guard });
      const spec = getIdentityProvider(request.params.id);
      if (!spec || spec.authMode !== "redirect") {
        return reply.code(400).send({ error: `Unknown redirect provider: ${request.params.id}` });
      }
      if (!deps.writeOAuthApp) return reply.code(501).send({ error: "Config is not writable on this node" });
      deps.writeOAuthApp(spec.id, null);
      log.info(`OAuth app cleared: ${spec.id}`);
      return reply.send({ ok: true });
    },
  );

  // POST /api/auth/start/:provider — begin redirect flow ----------------------
  fastify.post<{ Params: { provider: string } }>(
    "/api/auth/start/:provider",
    async (request, reply) => {
      const guard = guardPrivate(request.raw);
      if (guard) return reply.code(403).send({ error: guard });
      if (!deps.oauthHandler) return reply.code(501).send({ error: "OAuth not configured" });

      const result = deps.oauthHandler.startFlow(request.params.provider);
      if (!result) {
        return reply.code(400).send({
          error: `Provider not connectable — add its OAuth app first: ${request.params.provider}`,
        });
      }
      log.info(`OAuth redirect flow started: ${request.params.provider}`);
      return reply.send({ authUrl: result.authUrl });
    },
  );

  // GET /api/auth/callback/:provider — provider redirects back here -----------
  // Persists a connection token (not a federation entity binding) and bounces
  // the browser back to System ▸ Identity.
  fastify.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/auth/callback/:provider",
    async (request, reply) => {
      const provider = request.params.provider;
      const back = (q: string) => reply.redirect(`/system/identity?${q}`);

      if (request.query.error) return back(`error=${encodeURIComponent(request.query.error)}`);
      if (!deps.oauthHandler) return back("error=oauth_not_configured");
      const { code, state } = request.query;
      if (!code || !state) return back("error=missing_code");

      const result = await deps.oauthHandler.handleCallback(provider, code, state);
      if (!result) return back(`error=${encodeURIComponent(`${provider}_auth_failed`)}`);

      // Persist the connection (encrypted token) — same shape device-flow uses.
      if (deps.db && deps.encKey) {
        try {
          const userId = await resolveOwnerUserId(deps.db);
          const now = new Date();
          const tokenExpiresAt = result.expiresIn ? new Date(Date.now() + result.expiresIn * 1000) : null;
          const accountLabel = result.displayName ?? result.email ?? null;
          const [existing] = await deps.db
            .select({ id: connections.id })
            .from(connections)
            .where(and(eq(connections.userId, userId), eq(connections.provider, provider), eq(connections.role, "owner")))
            .limit(1);
          const values = {
            accountLabel,
            accessToken: encryptToken(deps.encKey, result.accessToken),
            refreshToken: result.refreshToken ? encryptToken(deps.encKey, result.refreshToken) : null,
            tokenExpiresAt,
            scopes: result.scopes,
            updatedAt: now,
          };
          if (existing) {
            await deps.db.update(connections).set(values).where(eq(connections.id, existing.id));
          } else {
            await deps.db.insert(connections).values({
              id: randomBytes(16).toString("hex"),
              userId,
              provider,
              role: "owner",
              createdAt: now,
              ...values,
            });
          }
          log.info(`OAuth connection stored: ${provider} (${accountLabel ?? "no label"})`);
        } catch (err) {
          log.error(`Failed to persist ${provider} connection: ${err instanceof Error ? err.message : String(err)}`);
          return back(`error=${encodeURIComponent(`${provider}_persist_failed`)}`);
        }
      }

      return back(`connected=${encodeURIComponent(provider)}`);
    },
  );
}

/** Resolve the local owner user row (FK target for connections), creating one if absent. */
async function resolveOwnerUserId(db: Db): Promise<string> {
  const [firstUser] = await db.select({ id: users.id }).from(users).limit(1);
  if (firstUser) return firstUser.id;
  const id = randomBytes(16).toString("hex");
  try {
    await db.insert(users).values({
      id,
      authBackend: "virtual",
      principal: "owner",
      username: "owner",
      displayName: "Owner",
      dashboardRole: "admin",
    });
  } catch {
    const [again] = await db.select({ id: users.id }).from(users).limit(1);
    return again?.id ?? id;
  }
  return id;
}

export function registerIdentityRoutes(
  fastify: FastifyInstance,
  deps: IdentityApiDeps,
): void {
  const log = createComponentLogger(deps.logger, "identity-api");
  const { identityProvider } = deps;

  // -----------------------------------------------------------------------
  // GET /api/identity/:entityId — get identity info
  // -----------------------------------------------------------------------

  fastify.get<{ Params: { entityId: string } }>(
    "/api/identity/:entityId",
    async (request, reply) => {
      const err = guardPrivate(request.raw);
      if (err) return reply.code(403).send({ error: err });

      const identity = identityProvider.getIdentity(request.params.entityId);
      if (!identity) {
        return reply.code(404).send({ error: "Entity not found or has no identity" });
      }
      return reply.send(identity);
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/identity/resolve/:geid — resolve by GEID
  // -----------------------------------------------------------------------

  fastify.get<{ Params: { geid: string } }>(
    "/api/identity/resolve/:geid",
    async (request, reply) => {
      const err = guardPrivate(request.raw);
      if (err) return reply.code(403).send({ error: err });

      const identity = identityProvider.resolveByGeid(decodeURIComponent(request.params.geid));
      if (!identity) {
        return reply.code(404).send({ error: "Entity not found for GEID" });
      }
      return reply.send(identity);
    },
  );

  // OAuth redirect flow (POST /api/auth/start, GET /api/auth/callback) and the
  // provider-app credential endpoints are registered UNCONDITIONALLY by
  // registerIdentityProvidersRoutes (below) — connecting Google/Meta/X/Tynn must
  // not depend on federation being enabled. They persist a connection token
  // rather than binding a federation entity.

  // -----------------------------------------------------------------------
  // Entity CRUD — requires db + encKey
  // -----------------------------------------------------------------------

  if (!deps.db || !deps.encKey) return;

  const db = deps.db;
  const encKey = deps.encKey;

  // GET /api/entities — list all entities with GEIDs
  fastify.get("/api/entities", async (request, reply) => {
    const err = guardPrivate(request.raw);
    if (err) return reply.code(403).send({ error: err });

    const entitySvc = createEntityService(db, encKey);
    const all = await entitySvc.listEntities();
    const result = await Promise.all(
      all.map(async (e) => {
        const geidRecord = await entitySvc.getEntityGeid(e.id);
        return {
          id: e.id,
          type: e.type,
          displayName: e.displayName,
          coaAlias: e.coaAlias,
          scope: e.scope,
          geid: geidRecord?.geid ?? null,
          createdAt: e.createdAt,
        };
      }),
    );
    return reply.send(result);
  });

  // POST /api/entities/guests — create guest entity (#E1+)
  fastify.post("/api/entities/guests", async (request, reply) => {
    const err = guardPrivate(request.raw);
    if (err) return reply.code(403).send({ error: err });

    const body = (request.body ?? {}) as { displayName?: string };
    if (!body.displayName?.trim()) {
      return reply.code(400).send({ error: "displayName is required" });
    }

    const entitySvc = createEntityService(db, encKey);
    const result = await entitySvc.createEntity("E", body.displayName.trim(), "registered");
    const geid = result.geid.geid;

    log.info(`Guest entity created: ${result.entity.coaAlias} (${geid})`);
    return reply.code(201).send({
      id: result.entity.id,
      coaAlias: result.entity.coaAlias,
      displayName: result.entity.displayName,
      geid,
    });
  });

  // PUT /api/entities/:id/profile — update displayName
  fastify.put<{ Params: { id: string } }>("/api/entities/:id/profile", async (request, reply) => {
    const err = guardPrivate(request.raw);
    if (err) return reply.code(403).send({ error: err });

    const body = (request.body ?? {}) as { displayName?: string };
    if (!body.displayName?.trim()) {
      return reply.code(400).send({ error: "displayName is required" });
    }

    const entitySvc = createEntityService(db, encKey);
    const entity = await entitySvc.getEntity(request.params.id);
    if (!entity) return reply.code(404).send({ error: "Entity not found" });

    await db.update(entitiesTable)
      .set({ displayName: body.displayName.trim(), updatedAt: new Date() })
      .where(eq(entitiesTable.id, request.params.id));

    log.info(`Entity profile updated: ${entity.coaAlias} displayName=${body.displayName.trim()}`);
    return reply.send({ ok: true });
  });

  // DELETE /api/entities/:id — remove guest (guards: not #E0, not $A)
  fastify.delete<{ Params: { id: string } }>("/api/entities/:id", async (request, reply) => {
    const err = guardPrivate(request.raw);
    if (err) return reply.code(403).send({ error: err });

    const entitySvc = createEntityService(db, encKey);
    const result = await entitySvc.deleteGuestEntity(request.params.id);
    if (!result.ok) {
      return reply.code(400).send({ error: result.error });
    }

    log.info(`Guest entity deleted: ${request.params.id}`);
    return reply.send({ ok: true });
  });

  // GET /api/entities/:id/connections — OAuth connections for entity
  fastify.get<{ Params: { id: string } }>("/api/entities/:id/connections", async (request, reply) => {
    const err = guardPrivate(request.raw);
    if (err) return reply.code(403).send({ error: err });

    const linkedUsers = await db.select({ id: users.id }).from(users)
      .where(eq(users.entityId, request.params.id));

    if (linkedUsers.length === 0) return reply.send([]);

    const userIds = linkedUsers.map((u) => u.id);
    const rows = await db.select({
      provider: connections.provider,
      role: connections.role,
      accountLabel: connections.accountLabel,
      updatedAt: connections.updatedAt,
    }).from(connections).where(
      userIds.length === 1
        ? eq(connections.userId, userIds[0]!)
        : inArray(connections.userId, userIds),
    );

    return reply.send(rows);
  });

  // DELETE /api/entities/:id/connections/:provider — remove a connection
  fastify.delete<{ Params: { id: string; provider: string } }>(
    "/api/entities/:id/connections/:provider",
    async (request, reply) => {
      const err = guardPrivate(request.raw);
      if (err) return reply.code(403).send({ error: err });

      const linkedUsers = await db.select({ id: users.id }).from(users)
        .where(eq(users.entityId, request.params.id));

      if (linkedUsers.length === 0) return reply.code(404).send({ error: "No user linked to entity" });

      const userIds = linkedUsers.map((u) => u.id);
      await db.delete(connections).where(
        and(
          userIds.length === 1
            ? eq(connections.userId, userIds[0]!)
            : inArray(connections.userId, userIds),
          eq(connections.provider, request.params.provider),
        ),
      );

      log.info(`Connection removed: entity=${request.params.id} provider=${request.params.provider}`);
      return reply.send({ ok: true });
    },
  );
}
