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
}

export function registerIdentityRoutes(
  fastify: FastifyInstance,
  deps: IdentityApiDeps,
): void {
  const log = createComponentLogger(deps.logger, "identity-api");
  const { identityProvider, oauthHandler } = deps;

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

  // -----------------------------------------------------------------------
  // GET /api/auth/providers — list available OAuth providers
  // -----------------------------------------------------------------------

  fastify.get("/api/auth/providers", async (_request, reply) => {
    const providers = oauthHandler?.getAvailableProviders() ?? [];
    return reply.send({ providers });
  });

  // -----------------------------------------------------------------------
  // POST /api/auth/start/:provider — start OAuth flow
  // -----------------------------------------------------------------------

  fastify.post<{ Params: { provider: string } }>(
    "/api/auth/start/:provider",
    async (request, reply) => {
      const err = guardPrivate(request.raw);
      if (err) return reply.code(403).send({ error: err });

      if (!oauthHandler) {
        return reply.code(501).send({ error: "OAuth not configured" });
      }

      const result = oauthHandler.startFlow(request.params.provider);
      if (!result) {
        return reply.code(400).send({ error: `Unsupported provider: ${request.params.provider}` });
      }

      log.info(`OAuth flow started for ${request.params.provider}`);
      return reply.send({ authUrl: result.authUrl });
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/auth/callback/:provider — OAuth callback
  // -----------------------------------------------------------------------

  fastify.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string } }>(
    "/api/auth/callback/:provider",
    async (request, reply) => {
      const err = guardPrivate(request.raw);
      if (err) return reply.code(403).send({ error: err });

      if (!oauthHandler) {
        return reply.code(501).send({ error: "OAuth not configured" });
      }

      const { code, state } = request.query;
      if (!code || !state) {
        return reply.code(400).send({ error: "Missing code or state parameter" });
      }

      const userInfo = await oauthHandler.handleCallback(
        request.params.provider,
        code,
        state,
      );

      if (!userInfo) {
        return reply.code(401).send({ error: "OAuth authentication failed" });
      }

      const entity = await identityProvider.createEntityWithIdentity({
        displayName: userInfo.displayName ?? userInfo.email ?? "Unknown",
      });

      await identityProvider.bindOAuthIdentity(
        entity.entityId,
        userInfo.provider,
        userInfo.providerUserId,
      );

      log.info(`OAuth identity bound: ${userInfo.provider}:${userInfo.providerUserId} -> ${entity.entityId}`);

      return reply.send({
        entityId: entity.entityId,
        geid: entity.geid,
        address: entity.address,
        provider: userInfo.provider,
        displayName: userInfo.displayName,
        email: userInfo.email,
      });
    },
  );

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
