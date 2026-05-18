# Federation & Identity System

Technical guide for federated identity, the third-party API gateway pattern, and the node identity layer.

---

## Decision first: how third-party APIs integrate

Before reading further, every new third-party API integration starts with one question:

> **Does the API require a server-held `client_secret`, or a publicly-resolvable HTTPS callback URL?**

| Answer | Class | OAuth/flow runs at | Tokens live at | API calls go through |
|--------|-------|--------------------|----------------|----------------------|
| **No** (public-client OAuth, e.g. RFC 8628 Device Grant) | Local-ID class | Local-ID (`id.ai.on`) | Local-ID `connections.accessToken` | agi → API directly (Bearer `access_token`) |
| **Yes** | Proxied class | Hive-ID (cloud, public HTTPS) | Hive-ID `connections` (never leave) | agi → Local-ID `/api/proxy/<provider>/<endpoint>` → Hive-ID → API |

**Why this split:**
- `id.ai.on` is LAN-only DNS — it physically cannot satisfy public HTTPS callback requirements (OAuth redirect URIs, webhooks). (`feedback_oauth_with_secret_routes_through_hive_id`)
- agi source is public; never hardcode per-deployment secrets there. (`feedback_localid_private_be_careful_what_ships_in_agi`)
- GitHub is the only current Local-ID class provider; all others are proxied.

---

## Third-party API gateway — proxied class (s149 unified pattern)

### The DToken model

Aionima nodes hold **DTokens** (32-byte random bearers) instead of raw provider access_tokens. Hive-ID stores `sha256(dtoken)` in its `dtokens` table, mapping to a `connections` row. DTokens are:
- Scoped (per provider + per item/account)
- Revocable independently of the upstream provider
- Never re-retrievable from Hive-ID after issuance (returned plaintext once, stored encrypted node-side)

Every proxied API call from agi passes the DToken to Local-ID, which forwards it to Hive-ID's proxy gateway. Hive-ID resolves the token → connection → upstream credentials, calls the API, and returns the mapped response.

```
agi (no secrets)
  └─► Local-ID /api/proxy/<provider>/<endpoint>  Authorization: Bearer dtok_…
        └─► Hive-ID /api/proxy/<provider>/<endpoint>  DToken lookup → connection
              └─► Third-party API  (client_id + client_secret + access_token)
```

### agi-side caller pattern (applies to ALL proxied providers)

```typescript
async function callLocalIdProxy<T>(endpoint: string, body: object, opts: { role: string }): Promise<T> {
  const base = process.env.LOCAL_ID_BASE_URL ?? "https://id.ai.on";
  const url = `${base}/api/proxy/${PROVIDER}/${endpoint}?role=${encodeURIComponent(opts.role)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`proxy error ${res.status}: re-link at id.ai.on/dashboard`);
  return (await res.json()) as T;
}
```

agi never holds: `client_secret`, `client_id` (for proxied providers), raw access_tokens, or Hive-ID's URL.

### Role-encoding for multi-account support

The `connections` table uses a `(user_id, provider, role)` unique index. Encode provider-specific account IDs into `role` to support multiple accounts per provider per user:

| Provider | Role encoding | Example |
|----------|--------------|---------|
| Plaid | `plaid-item:<itemId>` | `plaid-item:YhXb3k...` |
| Gmail / Calendar | `google-user:<sub>` | `google-user:11704...` |
| Discord | `discord-user:<userId>` | `discord-user:147621...` |

**No schema migration needed** — the existing unique index already handles this. Both Local-ID and Hive-ID use the same role convention.

---

## Plaid integration (s147 + s149)

Plaid is system-level for Aion: registered globally on the agent's tool palette so Aion can read bank accounts directly. MApps are secondary consumers via mini-agent auto-discovery.

### Connection flow

```
Owner browser (id.ai.on/dashboard)
  │  "Connect Bank Account"
  │  POST /api/auth/plaid-link/create-link-token → Local-ID → Hive-ID
  │  → receives link_token
  │
  ▼  [Plaid Link widget runs in browser]
  │
  │  POST /api/auth/plaid-link/exchange-public-token
  │       { public_token, metadata }
  │  → Local-ID → Hive-ID /api/oauth/plaid-link/exchange-public-token
  │  → Hive-ID: stores access_token, mints DToken, returns plaintext dtok_…
  │  → Local-ID: encrypts DToken, stores on connections.dtoken
  └─ Done. Owner's bank is linked.
```

### Local-ID routes (`agi-local-id/src/routes/`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/plaid-link/create-link-token` | Forward to Hive-ID; returns `link_token` for browser widget |
| POST | `/api/auth/plaid-link/exchange-public-token` | Forward to Hive-ID; receive + store encrypted DToken |
| POST | `/api/auth/plaid-link/items/:itemId/remove` | Forward proxy `item-remove` + drop local connection row |
| GET | `/api/auth/plaid-link/items` | List locally-mirrored connections (no Hive-ID round-trip) |
| POST | `/api/proxy/<provider>/<endpoint>` | Generic per-provider DToken forwarding to Hive-ID |

### Hive-ID routes (`agi-hive-id/src/routes/oauth/plaid-link.ts`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/oauth/plaid-link/create-link-token` | Issue Plaid `link_token` |
| POST | `/api/oauth/plaid-link/exchange-public-token` | Exchange `public_token` → access_token + mint DToken |
| POST | `/api/proxy/plaid/<endpoint>` | Gateway proxy; endpoints: `accounts-get`, `transactions-get`, `balance-get`, `identity-get`, `item-remove` |
| POST | `/webhook/plaid` | Webhook receiver (JWS signature verification pending) |

Proxy gateway: `agi-hive-id/src/services/proxy-gateway.ts` + `agi-hive-id/src/providers/proxy/plaid.ts`.

### agi plugin (`plugin-plaid-api/src/index.ts`)

Four tools, system-level. No provider credentials in plugin code. Uses `callLocalIdProxy()` pattern above with `role: plaid-item:<itemId>`.

### Plaid-specific behaviors

- **`/item/remove` on disconnect** — Plaid requires server-side notification. Local-ID forwards via proxy + drops local row (best-effort; local row drops even if Hive-ID fails).
- **Webhooks** — Hive-ID hosts at `/webhook/plaid`. Disable in Plaid dashboard until JWS signature verification ships (`agi-hive-id/src/routes/oauth/plaid-link.ts`).
- **`ITEM_LOGIN_REQUIRED` reauth** — future scope; dashboard should surface a reauth prompt when Plaid pushes this webhook event.

---

## Google + Discord — proxied class (t625, pending)

Google and Discord use the same proxied-class pattern as Plaid. Hive-ID already handles their OAuth dance via authorization-code flow (`/oauth/google/{start,callback}` + `/oauth/discord/{start,callback}`). The pending work (t625) replaces the `501 not_implemented` stubs in Local-ID's `device-flow.ts:223-227` with the standard proxy-forwarding shape.

Per-provider proxy definitions at `agi-hive-id/src/providers/proxy/{google,discord}.ts` (t625).

**Google endpoints**: `gmail.users.messages.send`, `gmail.users.messages.list`, `calendar.events.list`, `calendar.events.insert`, `drive.files.list`, `drive.files.get`, `oauth2.userinfo.get`

**Discord endpoints**: `users/@me`, `users/@me/guilds`, `channels/<id>/messages`

Both use Bearer `access_token` upstream (unlike Plaid's per-call `client_id+secret+access_token` body). The `ProxyProviderDef` `buildRequest` transformer handles either shape.

---

## Public-client class — GitHub (Local-ID only)

GitHub uses RFC 8628 Device Authorization Grant — no `client_secret` at any step. Flow runs entirely within Local-ID:

1. Owner clicks Connect at `id.ai.on/dashboard`
2. Local-ID hits GitHub `/login/device/code` with `GITHUB_CLIENT_ID` (public value, baked into source)
3. Owner completes authorization at github.com using the `user_code`
4. Local-ID polls `/login/oauth/access_token` until token arrives
5. `access_token` stored encrypted at `connections.accessToken`
6. agi broker call: `GET id.ai.on/api/auth/device-flow/token?provider=github&role=owner`
7. agi attaches Bearer `access_token`, calls `api.github.com` directly

Authoritative list: `LOCAL_PROVIDERS = new Set(["github"])` in `device-flow.ts`.

---

## When to add a new third-party API

1. **Public-client OAuth (no `client_secret`, no public HTTPS redirect)?** → add to `LOCAL_PROVIDERS` in `device-flow.ts`. GitHub is the only current example.
2. **Otherwise (proxied):**
   - Add `agi-hive-id/src/providers/proxy/<provider>.ts` (ProxyProviderDef)
   - Add `agi-hive-id/src/routes/oauth/<provider>.ts` (auth-code flow → use `provider-factory.ts`; widget flow → custom like `plaid-link.ts`)
   - Add webhook receiver at `agi-hive-id/src/routes/webhooks/<provider>.ts` if applicable
   - Add Local-ID forwarding route at `agi-local-id/src/routes/proxy-forward.ts`
   - agi plugin calls Local-ID's `/api/proxy/<provider>/<endpoint>` — no provider credentials
3. **Always cite memory rules inline in code comments** — future agents need the WHY for the GitHub exception.

---

## Node identity layer — GEID + EntityMap

This section describes how each Aionima node identifies itself within the federation. It is internal infrastructure; most integrations don't need to touch it.

### GEID (Global Entity ID)

Every entity automatically gets an Ed25519 keypair on creation. The GEID is derived from the public key:

```
geid:<base58-encoded-public-key>
```

- Generated in `EntityStore.createEntity()` via `generateEntityKeypair()`
- Stored in `geid_mappings` table (private key only for locally-owned entities)
- Source: `packages/entity-model/src/geid.ts`

### COA Address Format

```
<entity_alias>[.<agent_alias>]@<node_alias>
```

Examples: `#E0@#O0` (owner entity at node 0), `#E0.$A0@#O0` (Aion agent), `#E3@#O7` (visitor).

Functions: `formatAddress()`, `parseAddress()` in `geid.ts`.

### EntityMap (Portable Profile)

A dual-signed document that travels with an entity across nodes. Contains GEID, COA address, display name, entity type, impact scores, home node info, and expiry (24h TTL). Dual-signed: entity's Ed25519 signature + home node counter-signature.

Source: `packages/entity-model/src/entity-map.ts` — `generateEntityMap()`, `verifyEntityMap()`, `isEntityMapExpired()`.

### Database schema

New tables (in `packages/entity-model/src/schema.sql.ts`):

| Table | Purpose |
|-------|---------|
| `geid_mappings` | GEID keypair storage per entity |
| `federation_peers` | Persistent peer storage |
| `entity_map_cache` | Cached EntityMaps from remote nodes |
| `access_grants` | Access control for sub-users/visitors |

Federation columns on `entities`: `geid`, `public_key_pem`, `home_node_id`, `federation_consent`.

### Federation API endpoints

Registered when `federation.enabled = true` in `gateway.json`:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/.well-known/mycelium-node.json` | Node manifest (no auth) |
| POST | `/mycelium/handshake` | Peer handshake |
| POST | `/mycelium/ring/announce` | Ring announce (trust ≥ 1) |
| GET | `/mycelium/identity/map/:geid` | Fetch EntityMap (trust ≥ 1) |
| GET | `/api/identity/:entityId` | Entity identity info |
| GET | `/api/identity/resolve/:geid` | Resolve entity by GEID |
| GET | `/api/auth/providers` | List OAuth providers |
| POST | `/api/auth/start/:provider` | Start OAuth flow |
| GET | `/api/auth/callback/:provider` | OAuth callback |
| POST | `/api/sub-users` | Create sub-user |
| GET | `/api/sub-users` | List sub-users |
| POST | `/api/visitor/challenge` | Issue GEID challenge |
| POST | `/api/visitor/verify` | Verify challenge response |
| GET | `/api/visitor/session` | Verify visitor session |

### Enabling federation

```json
{
  "federation": {
    "enabled": true,
    "publicUrl": "https://your-node.example.com",
    "seedPeers": [],
    "autoGeid": true,
    "allowVisitors": true
  }
}
```

Config schemas: `FederationConfigSchema`, `IdentityConfigSchema` in `config/src/schema.ts`.

### Server wiring

Federation is initialized in `server.ts` when `federation.enabled` is true:

1. `generateNodeKeypair()` — Ed25519 keypair for the node
2. `FederationPeerStore(db)` — SQLite-backed peer persistence
3. `FederationNode(config)` — node identity + manifest
4. `FederationRouter(node)` — handles `/mycelium/*` routes
5. `IdentityProvider(entityStore, federationNode)` — local ID management
6. `VisitorAuthManager({ sessionSecret })` — challenge-response auth
7. `OAuthHandler(config, baseUrl)` — GitHub/Google OAuth flows

Routes registered in `server-runtime-state.ts` via `registerIdentityRoutes()`, `registerSubUserRoutes()`, and direct Fastify registrations for `/.well-known` and `/mycelium/*`.

---

## Files reference

### Entity model (`packages/entity-model/src/`)

| File | Purpose |
|------|---------|
| `geid.ts` | GEID generation, COA address format/parse |
| `entity-map.ts` | EntityMap generation, dual-signing, verification |
| `schema.sql.ts` | DDL for new tables + `FEDERATION_MIGRATIONS` |
| `db.ts` | Migration runner (comment-stripping, idempotent ALTER TABLE) |
| `store.ts` | `getByGeid()`, `getGeidMapping()`, `updateFederation()`, `getByAddress()` |

### Gateway core (`packages/gateway-core/src/`)

| File | Purpose |
|------|---------|
| `federation-node.ts` | Node identity, manifest, peer management |
| `federation-router.ts` | Request routing, ring/announce, EntityMap endpoints |
| `federation-peer-store.ts` | SQLite-backed persistent peer storage |
| `federation-types.ts` | Ring protocol types, visitor auth types |
| `federation-handshake.ts` | Peer handshake protocol |
| `identity-provider.ts` | Local ID issuance, GEID binding, OAuth binding |
| `oauth-handler.ts` | GitHub/Google OAuth2 flows |
| `identity-api.ts` | Fastify routes for identity operations |
| `visitor-auth.ts` | GEID challenge-response authentication |
| `sub-user-api.ts` | Sub-user management routes |

### Config (`config/src/`)

| File | Purpose |
|------|---------|
| `schema.ts` | `FederationConfigSchema`, `OAuthProviderSchema`, `IdentityConfigSchema` |

---

## Dev + testing

Use `agi test-vm` for all VM operations. See `agi test-vm --help` and `agi/docs/human/testing.md`.

```bash
agi test-vm services-status      # Check VM services
agi test-vm services-start       # Start all services in VM
agi test --e2e federation        # Run federation e2e suite (if it exists)
```

For federation endpoint testing from the host after services are up:

```bash
# From host — VM at https://test.ai.on
curl -sk https://test.ai.on/health
curl -sk https://test.ai.on/.well-known/mycelium-node.json
curl -sk https://test.ai.on/api/auth/providers
```

For deep VM inspection:

```bash
agi bash 'multipass exec agi-test -- bash -c "cat ~/.agi/gateway.json | head -30"'
```

Do not use `multipass exec` directly — route through `agi bash` so all exec calls are logged. See `CLAUDE.md § 3` for the full blocker protocol.
