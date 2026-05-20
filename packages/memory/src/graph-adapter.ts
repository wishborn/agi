/**
 * GraphMemoryAdapter — SQLite-backed temporal event graph (s112 CoALA+TiMem).
 *
 * Replaces the Cognee/file dual-backend with a single offline-capable store.
 * Storage: ~/.agi/memory/graph.db (node:sqlite, FTS5, no external deps).
 *
 * Four tables:
 *   events          — Layer B episodic records with temporal provenance
 *   relationships   — consolidated fact graph (valid_from / valid_until)
 *   doc_chunks      — indexed agi/docs/ + k/ folder chunks (DocIndexer)
 *   consolidation_log — audit trail for the consolidation pipeline
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  MemoryProvider,
  MemoryEntry,
  MemoryQueryParams,
  PruneParams,
  MemoryCategory,
  MemorySource,
} from "./types.js";

// node:sqlite is experimental in Node 22.x — the project pins >=22.0.0,
// and FTS5 is confirmed working at 22.22.0.
// biome-ignore lint/suspicious/noExplicitAny: dynamic import of experimental module
type DatabaseSyncType = any;
let _DatabaseSync: new (path: string) => DatabaseSyncType;

function getDb(path: string): DatabaseSyncType {
  if (!_DatabaseSync) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("node:sqlite") as { DatabaseSync: typeof _DatabaseSync };
      _DatabaseSync = mod.DatabaseSync;
    } catch {
      throw new Error(
        "node:sqlite unavailable — GraphMemoryAdapter requires Node >=22.5.0",
      );
    }
  }
  return new _DatabaseSync(path);
}

// ---------------------------------------------------------------------------
// Config & extended types
// ---------------------------------------------------------------------------

export interface GraphMemoryConfig {
  /** Absolute path to SQLite file. Default: ~/.agi/memory/graph.db */
  dbPath?: string;
  /** Legacy FileMemoryProvider directory — scanned for migration on first boot. */
  legacyMemDir?: string;
}

/** Internal event record (maps to the events table). */
export interface GraphEventRecord {
  id: string;
  entityId: string;
  projectPath?: string | null;
  sessionId?: string | null;
  summary: string;
  tags: string[];
  confidence: number;
  primeAlignment?: number | null;
  sourceLinks: string[];
  hash: string;
  coaFingerprint: string;
  modelVersion?: string | null;
  createdAt: number; // Unix ms
  consolidatedAt?: number | null;
  embedding?: Float32Array | null;
}

/** A consolidated semantic relationship between entities. */
export interface RelationshipRecord {
  id: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId?: string | null;
  objectLiteral?: string | null;
  projectPath?: string | null;
  validFrom: number; // Unix ms
  validUntil?: number | null;
  confidence: number;
  sourceEventIds: string[];
  createdAt: number; // Unix ms
}

/** A doc chunk from agi/docs/ or a k/ folder. */
export interface DocChunkRecord {
  id: string;
  sourcePath: string;
  scope: string; // 'global' | 'project:<path>' | 'prime'
  heading?: string | null;
  content: string;
  chunkIndex: number;
  contentHash: string;
  indexedAt: number; // Unix ms
  embedding?: Float32Array | null;
}

/** Graph-aware event query (superset of MemoryQueryParams). */
export interface EventQuery {
  entityId?: string;
  projectPath?: string | null; // null = global only; undefined = entity-wide
  timeRange?: { from: Date; to?: Date };
  semantic?: string;
  tags?: string[];
  minConfidence?: number;
  limit?: number;
}

/** Relationship query with point-in-time traversal. */
export interface RelationshipQuery {
  subjectEntityId?: string;
  projectPath?: string | null;
  predicate?: string;
  validAt?: Date;
  limit?: number;
}

/** Doc chunk keyword / semantic query. */
export interface DocQuery {
  scope?: string;
  semantic?: string;
  limit?: number;
  /** When provided, cosine-reranks FTS5 candidates against this embedding. */
  queryEmbedding?: Float32Array;
}

// ---------------------------------------------------------------------------
// Schema initialization (individual prepare().run() calls — no exec())
// ---------------------------------------------------------------------------

const SCHEMA_STMTS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  `CREATE TABLE IF NOT EXISTS events (
    id               TEXT PRIMARY KEY,
    entity_id        TEXT NOT NULL,
    project_path     TEXT,
    session_id       TEXT,
    summary          TEXT NOT NULL,
    tags             TEXT NOT NULL DEFAULT '[]',
    confidence       REAL NOT NULL DEFAULT 0.5,
    prime_alignment  REAL,
    source_links     TEXT NOT NULL DEFAULT '[]',
    hash             TEXT UNIQUE NOT NULL,
    coa_fingerprint  TEXT NOT NULL DEFAULT 'legacy',
    model_version    TEXT,
    created_at       INTEGER NOT NULL,
    consolidated_at  INTEGER,
    embedding        BLOB
  )`,
  "CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_id)",
  "CREATE INDEX IF NOT EXISTS idx_events_project ON events(entity_id, project_path)",
  "CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC)",
  `CREATE INDEX IF NOT EXISTS idx_events_unconsolidated
    ON events(entity_id, consolidated_at) WHERE consolidated_at IS NULL`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    summary, tags,
    content='events',
    content_rowid='rowid'
  )`,
  `CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events
   BEGIN
     INSERT INTO events_fts(rowid, summary, tags) VALUES (new.rowid, new.summary, new.tags);
   END`,
  `CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events
   BEGIN
     INSERT INTO events_fts(events_fts, rowid, summary, tags)
       VALUES ('delete', old.rowid, old.summary, old.tags);
   END`,
  `CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events
   BEGIN
     INSERT INTO events_fts(events_fts, rowid, summary, tags)
       VALUES ('delete', old.rowid, old.summary, old.tags);
     INSERT INTO events_fts(rowid, summary, tags) VALUES (new.rowid, new.summary, new.tags);
   END`,
  `CREATE TABLE IF NOT EXISTS relationships (
    id                TEXT PRIMARY KEY,
    subject_entity_id TEXT NOT NULL,
    predicate         TEXT NOT NULL,
    object_entity_id  TEXT,
    object_literal    TEXT,
    project_path      TEXT,
    valid_from        INTEGER NOT NULL,
    valid_until       INTEGER,
    confidence        REAL NOT NULL DEFAULT 1.0,
    source_event_ids  TEXT NOT NULL DEFAULT '[]',
    created_at        INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_rel_subject ON relationships(subject_entity_id, valid_until)",
  "CREATE INDEX IF NOT EXISTS idx_rel_project ON relationships(subject_entity_id, project_path, valid_until)",
  `CREATE TABLE IF NOT EXISTS doc_chunks (
    id           TEXT PRIMARY KEY,
    source_path  TEXT NOT NULL,
    scope        TEXT NOT NULL,
    heading      TEXT,
    content      TEXT NOT NULL,
    chunk_index  INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    indexed_at   INTEGER NOT NULL,
    embedding    BLOB
  )`,
  "CREATE INDEX IF NOT EXISTS idx_doc_scope ON doc_chunks(scope)",
  "CREATE INDEX IF NOT EXISTS idx_doc_path  ON doc_chunks(source_path)",
  `CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
    content, heading, source_path,
    content='doc_chunks',
    content_rowid='rowid'
  )`,
  `CREATE TRIGGER IF NOT EXISTS doc_ai AFTER INSERT ON doc_chunks
   BEGIN
     INSERT INTO doc_chunks_fts(rowid, content, heading, source_path)
       VALUES (new.rowid, new.content, new.heading, new.source_path);
   END`,
  `CREATE TRIGGER IF NOT EXISTS doc_ad AFTER DELETE ON doc_chunks
   BEGIN
     INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content, heading, source_path)
       VALUES ('delete', old.rowid, old.content, old.heading, old.source_path);
   END`,
  `CREATE TABLE IF NOT EXISTS consolidation_log (
    id                  TEXT PRIMARY KEY,
    trigger             TEXT NOT NULL,
    entity_id           TEXT,
    project_path        TEXT,
    events_processed    INTEGER,
    relationships_added INTEGER,
    started_at          INTEGER NOT NULL,
    completed_at        INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS _meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  "INSERT OR IGNORE INTO _meta(key, value) VALUES ('schema_version', '1')",
];

function initSchema(db: DatabaseSyncType): void {
  for (const sql of SCHEMA_STMTS) {
    db.prepare(sql).run();
  }
}

// ---------------------------------------------------------------------------
// GraphMemoryAdapter
// ---------------------------------------------------------------------------

export class GraphMemoryAdapter implements MemoryProvider {
  readonly name = "graph-memory";
  readonly requiresNetwork = false;

  private readonly db: DatabaseSyncType;

  constructor(config: GraphMemoryConfig = {}) {
    const dbPath =
      config.dbPath ?? join(homedir(), ".agi", "memory", "graph.db");
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = getDb(dbPath);
    initSchema(this.db);

    if (config.legacyMemDir) {
      this.migrateFromFileAdapter(config.legacyMemDir);
    }
  }

  // ---------------------------------------------------------------------------
  // MemoryProvider interface
  // ---------------------------------------------------------------------------

  async store(entry: MemoryEntry | unknown): Promise<void> {
    // Accept both MemoryEntry (legacy callers) and EpisodicRecord (EpisodeExtractor
    // types its memoryAdapter as { store(e: unknown) }).
    if (isEpisodicRecord(entry)) {
      const ep = entry as EpisodicRecordLike;
      this.insertEvent({
        id: ep.id,
        entityId: ep.actor.entityId,
        projectPath: null,
        sessionId: ep.sourceLinks?.[0] ?? null,
        summary: ep.summary,
        tags: ep.tags ?? [],
        confidence: ep.confidence ?? 0.5,
        primeAlignment: ep.primeAlignment ?? null,
        sourceLinks: ep.sourceLinks ?? [],
        hash: ep.hash,
        coaFingerprint: ep.coaFingerprint,
        modelVersion: ep.modelVersion ?? null,
        createdAt: new Date(ep.timestamp).getTime(),
        consolidatedAt: null,
        embedding: null,
      });
      return;
    }
    const mem = entry as MemoryEntry;
    this.insertEvent({
      id: mem.id,
      entityId: mem.entityId,
      projectPath: null,
      sessionId: null,
      summary: mem.content,
      tags: [mem.category],
      confidence: 0.5,
      primeAlignment: null,
      sourceLinks: [mem.source],
      hash: hashFromParts(mem.content, mem.createdAt),
      coaFingerprint: "legacy",
      modelVersion: null,
      createdAt: new Date(mem.createdAt).getTime(),
      consolidatedAt: null,
      embedding: null,
    });
  }

  async storeBatch(entries: MemoryEntry[]): Promise<void> {
    for (const e of entries) await this.store(e);
  }

  async query(params: MemoryQueryParams): Promise<MemoryEntry[]> {
    const rows = this.selectEvents({
      entityId: params.entityId,
      semantic: params.query,
      tags: params.categories,
      minConfidence: params.minRelevance,
      limit: params.limit ?? 10,
    });
    return rows.map(rowToMemoryEntry);
  }

  async delete(memoryId: string): Promise<void> {
    this.db.prepare("DELETE FROM events WHERE id = ?").run(memoryId);
  }

  async deleteAllForEntity(entityId: string): Promise<void> {
    this.db.prepare("DELETE FROM events WHERE entity_id = ?").run(entityId);
  }

  async prune(params: PruneParams): Promise<number> {
    const clauses: string[] = [];
    const bindings: unknown[] = [];

    if (params.entityId) {
      clauses.push("entity_id = ?");
      bindings.push(params.entityId);
    }
    if (params.olderThan) {
      clauses.push("created_at < ?");
      bindings.push(new Date(params.olderThan).getTime());
    }

    const whereClause =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = this.db
      .prepare(`DELETE FROM events ${whereClause}`)
      .run(...bindings) as { changes: number };

    if (
      params.maxPerEntity !== undefined &&
      params.entityId !== undefined
    ) {
      const overflow = this.db
        .prepare(
          `SELECT id FROM events WHERE entity_id = ?
           ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
        )
        .all(params.entityId, params.maxPerEntity) as { id: string }[];
      for (const row of overflow) {
        this.db.prepare("DELETE FROM events WHERE id = ?").run(row.id);
      }
    }

    return result.changes;
  }

  async count(entityId: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE entity_id = ?")
      .get(entityId) as { n: number };
    return row.n;
  }

  isAvailable(): boolean {
    return true; // SQLite is always local
  }

  // ---------------------------------------------------------------------------
  // Extended graph API (used by EpisodeExtractor, ConsolidationEngine, DocIndexer)
  // ---------------------------------------------------------------------------

  /** Store a typed episodic event with optional projectPath. */
  storeEpisodicEvent(
    record: Omit<GraphEventRecord, "embedding"> & {
      projectPath?: string | null;
    },
  ): void {
    this.insertEvent({ ...record, embedding: null });
  }

  storeRelationship(rel: RelationshipRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO relationships
         (id, subject_entity_id, predicate, object_entity_id, object_literal,
          project_path, valid_from, valid_until, confidence, source_event_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rel.id,
        rel.subjectEntityId,
        rel.predicate,
        rel.objectEntityId ?? null,
        rel.objectLiteral ?? null,
        rel.projectPath ?? null,
        rel.validFrom,
        rel.validUntil ?? null,
        rel.confidence,
        JSON.stringify(rel.sourceEventIds),
        rel.createdAt,
      );
  }

  /** Set valid_until on any open relationship with the same subject+predicate+scope. */
  invalidatePriorRelationship(
    subjectEntityId: string,
    predicate: string,
    projectPath: string | null,
    validUntil: number,
  ): void {
    this.db
      .prepare(
        `UPDATE relationships SET valid_until = ?
         WHERE subject_entity_id = ?
           AND predicate = ?
           AND (project_path = ? OR (project_path IS NULL AND ? IS NULL))
           AND valid_until IS NULL`,
      )
      .run(validUntil, subjectEntityId, predicate, projectPath, projectPath);
  }

  /** Graph-aware event query — returns GraphEventRecord[] (superset of MemoryEntry). */
  queryGraphEvents(params: EventQuery): GraphEventRecord[] {
    const rows = this.selectEvents(params);
    return rows.map(rowToGraphEvent);
  }

  queryRelationships(params: RelationshipQuery): RelationshipRecord[] {
    const clauses: string[] = [];
    const bindings: unknown[] = [];

    if (params.subjectEntityId) {
      clauses.push("subject_entity_id = ?");
      bindings.push(params.subjectEntityId);
    }
    if (params.predicate) {
      clauses.push("predicate = ?");
      bindings.push(params.predicate);
    }
    if ("projectPath" in params) {
      if (params.projectPath === null) {
        clauses.push("project_path IS NULL");
      } else if (params.projectPath !== undefined) {
        clauses.push("project_path = ?");
        bindings.push(params.projectPath);
      }
    }
    if (params.validAt) {
      const ts = params.validAt.getTime();
      clauses.push(
        "valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)",
      );
      bindings.push(ts, ts);
    }

    const where =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM relationships ${where}
         ORDER BY valid_from DESC LIMIT ?`,
      )
      .all(...bindings, params.limit ?? 10) as Record<string, unknown>[];

    return rows.map(rowToRelationship);
  }

  markConsolidated(eventIds: string[]): void {
    if (eventIds.length === 0) return;
    const now = Date.now();
    const placeholders = eventIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `UPDATE events SET consolidated_at = ?
         WHERE id IN (${placeholders})`,
      )
      .run(now, ...eventIds);
  }

  getUnconsolidated(
    entityId: string,
    projectPath: string | null | undefined,
    limit = 20,
  ): GraphEventRecord[] {
    let rows: Record<string, unknown>[];

    if (projectPath === null) {
      rows = this.db
        .prepare(
          `SELECT * FROM events
           WHERE entity_id = ? AND project_path IS NULL AND consolidated_at IS NULL
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all(entityId, limit) as Record<string, unknown>[];
    } else if (projectPath !== undefined) {
      rows = this.db
        .prepare(
          `SELECT * FROM events
           WHERE entity_id = ? AND project_path = ? AND consolidated_at IS NULL
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all(entityId, projectPath, limit) as Record<string, unknown>[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM events
           WHERE entity_id = ? AND consolidated_at IS NULL
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all(entityId, limit) as Record<string, unknown>[];
    }

    return rows.map(rowToGraphEvent);
  }

  storeConsolidationLog(entry: {
    id: string;
    trigger: string;
    entityId?: string | null;
    projectPath?: string | null;
    eventsProcessed: number;
    relationshipsAdded: number;
    startedAt: number;
    completedAt?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO consolidation_log
         (id, trigger, entity_id, project_path, events_processed,
          relationships_added, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.trigger,
        entry.entityId ?? null,
        entry.projectPath ?? null,
        entry.eventsProcessed,
        entry.relationshipsAdded,
        entry.startedAt,
        entry.completedAt ?? null,
      );
  }

  // ---------------------------------------------------------------------------
  // Doc chunk API (used by DocIndexer — Phase 3)
  // ---------------------------------------------------------------------------

  storeDocChunk(chunk: DocChunkRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO doc_chunks
         (id, source_path, scope, heading, content, chunk_index,
          content_hash, indexed_at, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chunk.id,
        chunk.sourcePath,
        chunk.scope,
        chunk.heading ?? null,
        chunk.content,
        chunk.chunkIndex,
        chunk.contentHash,
        chunk.indexedAt,
        chunk.embedding ? Buffer.from(chunk.embedding.buffer) : null,
      );
  }

  deleteDocChunksForPath(sourcePath: string): void {
    this.db
      .prepare("DELETE FROM doc_chunks WHERE source_path = ?")
      .run(sourcePath);
  }

  getDocChunkHash(sourcePath: string): string | null {
    const row = this.db
      .prepare(
        "SELECT content_hash FROM doc_chunks WHERE source_path = ? LIMIT 1",
      )
      .get(sourcePath) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }

  queryDocChunks(params: DocQuery): DocChunkRecord[] {
    const query = params.semantic ?? "";
    const limit = params.limit ?? 5;
    const fetchLimit = params.queryEmbedding ? Math.min(limit * 5, 50) : limit;

    if (query.trim().length > 0) {
      const ftsQuery = sanitizeFtsQuery(query);
      let sql = `
        SELECT d.* FROM doc_chunks d
        JOIN doc_chunks_fts f ON d.rowid = f.rowid
        WHERE doc_chunks_fts MATCH ?`;
      const bindings: unknown[] = [ftsQuery];

      if (params.scope) {
        sql += " AND d.scope = ?";
        bindings.push(params.scope);
      }
      sql += " ORDER BY rank LIMIT ?";
      bindings.push(fetchLimit);

      const candidates = (
        this.db.prepare(sql).all(...bindings) as Record<string, unknown>[]
      ).map((r) => rowToDocChunkWithEmbedding(r));

      if (params.queryEmbedding) {
        return cosineRerankDocs(candidates, params.queryEmbedding, limit);
      }
      return candidates.map(stripEmbedding).slice(0, limit);
    }

    let sql = "SELECT * FROM doc_chunks";
    const bindings: unknown[] = [];
    if (params.scope) {
      sql += " WHERE scope = ?";
      bindings.push(params.scope);
    }
    sql += " ORDER BY indexed_at DESC LIMIT ?";
    bindings.push(limit);

    return (
      this.db.prepare(sql).all(...bindings) as Record<string, unknown>[]
    ).map(rowToDocChunk);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private insertEvent(r: GraphEventRecord): void {
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO events
           (id, entity_id, project_path, session_id, summary, tags, confidence,
            prime_alignment, source_links, hash, coa_fingerprint,
            model_version, created_at, consolidated_at, embedding)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.id,
          r.entityId,
          r.projectPath ?? null,
          r.sessionId ?? null,
          r.summary,
          JSON.stringify(r.tags),
          r.confidence,
          r.primeAlignment ?? null,
          JSON.stringify(r.sourceLinks),
          r.hash,
          r.coaFingerprint,
          r.modelVersion ?? null,
          r.createdAt,
          r.consolidatedAt ?? null,
          r.embedding ? Buffer.from(r.embedding.buffer) : null,
        );
    } catch {
      // Hash collision (duplicate event) — silently ignore
    }
  }

  private selectEvents(params: EventQuery): Record<string, unknown>[] {
    const {
      entityId,
      semantic,
      tags,
      minConfidence = 0,
      limit = 10,
    } = params;

    if (semantic && semantic.trim().length > 0) {
      const ftsQuery = sanitizeFtsQuery(semantic);
      let sql = `
        SELECT e.* FROM events e
        JOIN events_fts f ON e.rowid = f.rowid
        WHERE events_fts MATCH ? AND e.confidence >= ?`;
      const bindings: unknown[] = [ftsQuery, minConfidence];

      if (entityId) {
        sql += " AND e.entity_id = ?";
        bindings.push(entityId);
      }
      if ("projectPath" in params) {
        if (params.projectPath === null) {
          sql += " AND e.project_path IS NULL";
        } else if (params.projectPath !== undefined) {
          sql += " AND e.project_path = ?";
          bindings.push(params.projectPath);
        }
      }
      // Fetch extra for future cosine re-rank (Phase 2 embedding engine)
      sql += " ORDER BY rank LIMIT ?";
      bindings.push(Math.min((limit ?? 10) * 3, 50));

      return this.db.prepare(sql).all(...bindings) as Record<
        string,
        unknown
      >[];
    }

    // No semantic query — recency order
    const clauses: string[] = ["e.confidence >= ?"];
    const bindings: unknown[] = [minConfidence];

    if (entityId) {
      clauses.push("e.entity_id = ?");
      bindings.push(entityId);
    }
    if ("projectPath" in params) {
      if (params.projectPath === null) {
        clauses.push("e.project_path IS NULL");
      } else if (params.projectPath !== undefined) {
        clauses.push("e.project_path = ?");
        bindings.push(params.projectPath);
      }
    }
    if (tags && tags.length > 0) {
      const tagChecks = tags.map(() => "e.tags LIKE ?").join(" OR ");
      clauses.push(`(${tagChecks})`);
      for (const t of tags) bindings.push(`%"${t}"%`);
    }
    if (params.timeRange) {
      clauses.push("e.created_at >= ?");
      bindings.push(params.timeRange.from.getTime());
      if (params.timeRange.to) {
        clauses.push("e.created_at <= ?");
        bindings.push(params.timeRange.to.getTime());
      }
    }

    const where = `WHERE ${clauses.join(" AND ")}`;
    return this.db
      .prepare(
        `SELECT e.* FROM events e ${where}
         ORDER BY e.created_at DESC LIMIT ?`,
      )
      .all(...bindings, limit) as Record<string, unknown>[];
  }

  /** One-shot idempotent migration from old FileMemoryProvider JSON files. */
  private migrateFromFileAdapter(legacyMemDir: string): void {
    const dir = legacyMemDir.startsWith("/")
      ? legacyMemDir
      : join(process.cwd(), legacyMemDir);

    if (!existsSync(dir)) return;

    const alreadyRan = this.db
      .prepare("SELECT value FROM _meta WHERE key = 'file_migration_done'")
      .get() as { value: string } | undefined;
    if (alreadyRan) return;

    let count = 0;
    try {
      for (const entity of readdirSync(dir)) {
        const entityPath = join(dir, entity);
        try {
          for (const file of readdirSync(entityPath)) {
            if (!file.endsWith(".json")) continue;
            try {
              const raw = JSON.parse(
                readFileSync(join(entityPath, file), "utf-8"),
              ) as Record<string, unknown>;
              const content =
                typeof raw.content === "string" ? raw.content : "";
              const createdAt =
                typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();
              this.insertEvent({
                id: typeof raw.id === "string" ? raw.id : `migrated-${file}`,
                entityId: typeof raw.entityId === "string" ? raw.entityId : entity,
                projectPath: null,
                sessionId: null,
                summary: content,
                tags: [typeof raw.category === "string" ? raw.category : "fact"],
                confidence: 0.5,
                primeAlignment: null,
                sourceLinks: [typeof raw.source === "string" ? raw.source : "migrated"],
                hash: hashFromParts(content, createdAt),
                coaFingerprint: "migrated",
                modelVersion: null,
                createdAt: new Date(createdAt).getTime(),
                consolidatedAt: null,
                embedding: null,
              });
              count++;
            } catch {
              // Skip malformed file
            }
          }
        } catch {
          // Skip unreadable entity dir
        }
      }
    } catch {
      // Legacy dir unreadable — skip
    }

    this.db
      .prepare("INSERT OR REPLACE INTO _meta(key, value) VALUES (?, ?)")
      .run("file_migration_done", String(Date.now()));

    if (count > 0) {
      process.stderr.write(
        `[memory] Migrated ${String(count)} entries from file adapter to graph.db\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Row converters
// ---------------------------------------------------------------------------

function rowToMemoryEntry(row: Record<string, unknown>): MemoryEntry {
  const tags = parseJson<string[]>(row.tags as string, []);
  const links = parseJson<string[]>(row.source_links as string, []);
  const createdAt = new Date(row.created_at as number).toISOString();
  return {
    id: row.id as string,
    entityId: row.entity_id as string,
    content: row.summary as string,
    category: (tags[0] ?? "fact") as MemoryCategory,
    source: (links[0] ?? "system") as MemorySource,
    createdAt,
    lastAccessedAt: createdAt,
    accessCount: 0,
    relevanceScore: row.confidence as number,
  };
}

function rowToGraphEvent(row: Record<string, unknown>): GraphEventRecord {
  return {
    id: row.id as string,
    entityId: row.entity_id as string,
    projectPath: (row.project_path as string | null) ?? null,
    sessionId: (row.session_id as string | null) ?? null,
    summary: row.summary as string,
    tags: parseJson<string[]>(row.tags as string, []),
    confidence: row.confidence as number,
    primeAlignment: (row.prime_alignment as number | null) ?? null,
    sourceLinks: parseJson<string[]>(row.source_links as string, []),
    hash: row.hash as string,
    coaFingerprint: row.coa_fingerprint as string,
    modelVersion: (row.model_version as string | null) ?? null,
    createdAt: row.created_at as number,
    consolidatedAt: (row.consolidated_at as number | null) ?? null,
    embedding: null,
  };
}

function rowToRelationship(row: Record<string, unknown>): RelationshipRecord {
  return {
    id: row.id as string,
    subjectEntityId: row.subject_entity_id as string,
    predicate: row.predicate as string,
    objectEntityId: (row.object_entity_id as string | null) ?? null,
    objectLiteral: (row.object_literal as string | null) ?? null,
    projectPath: (row.project_path as string | null) ?? null,
    validFrom: row.valid_from as number,
    validUntil: (row.valid_until as number | null) ?? null,
    confidence: row.confidence as number,
    sourceEventIds: parseJson<string[]>(row.source_event_ids as string, []),
    createdAt: row.created_at as number,
  };
}

function rowToDocChunk(row: Record<string, unknown>): DocChunkRecord {
  return {
    id: row.id as string,
    sourcePath: row.source_path as string,
    scope: row.scope as string,
    heading: (row.heading as string | null) ?? null,
    content: row.content as string,
    chunkIndex: row.chunk_index as number,
    contentHash: row.content_hash as string,
    indexedAt: row.indexed_at as number,
    embedding: null,
  };
}

function rowToDocChunkWithEmbedding(row: Record<string, unknown>): DocChunkRecord {
  const embBlob = row.embedding as Buffer | null;
  const embedding = embBlob && embBlob.length > 0
    ? new Float32Array(embBlob.buffer, embBlob.byteOffset, embBlob.byteLength / 4)
    : null;
  return { ...rowToDocChunk(row), embedding };
}

function stripEmbedding(r: DocChunkRecord): DocChunkRecord {
  return { ...r, embedding: null };
}

function cosineRerankDocs(
  candidates: DocChunkRecord[],
  queryEmb: Float32Array,
  limit: number,
): DocChunkRecord[] {
  const scored = candidates.map((c) => {
    const score = c.embedding ? cosineSim(queryEmb, c.embedding) : -1;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => stripEmbedding(s.c));
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function sanitizeFtsQuery(q: string): string {
  // Quote each token individually to prevent FTS5 operator injection while
  // using AND matching (implicit in FTS5) rather than phrase matching.
  // Phrase matching (`"a b"`) fails when terms are non-adjacent.
  const terms = q.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

function hashFromParts(content: string, createdAt: string): string {
  return (
    "sha256:" +
    createHash("sha256")
      .update(content + createdAt)
      .digest("hex")
  );
}

interface EpisodicRecordLike {
  id: string;
  timestamp: string;
  actor: { entityId: string; coaAlias: string };
  summary: string;
  tags: string[];
  confidence: number;
  primeAlignment?: number | null;
  sourceLinks: string[];
  hash: string;
  coaFingerprint: string;
  modelVersion?: string | null;
}

function isEpisodicRecord(entry: unknown): entry is EpisodicRecordLike {
  const r = entry as Record<string, unknown>;
  return (
    typeof r?.summary === "string" &&
    typeof r?.coaFingerprint === "string" &&
    typeof r?.actor === "object" &&
    r.actor !== null
  );
}
