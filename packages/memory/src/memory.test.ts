/**
 * Tests for @agi/memory — GraphMemoryAdapter (s112 CoALA+TiMem rewrite).
 *
 * Each test suite gets its own temp SQLite file via mkdtempSync so there is
 * zero cross-test state. No mocks — tests run against the real node:sqlite engine.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { GraphMemoryAdapter } from "./graph-adapter.js";
import type { EpisodicRecord } from "./episodic.js";
import type { GraphEventRecord, RelationshipRecord } from "./graph-adapter.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpCount = 0;

function makeTmpDir(): string {
  tmpCount++;
  return mkdtempSync(join(tmpdir(), `agi-mem-test-${String(tmpCount)}-`));
}

function makeAdapter(dir: string): GraphMemoryAdapter {
  return new GraphMemoryAdapter({ dbPath: join(dir, "graph.db") });
}

let episodeCounter = 0;

// EpisodicRecord (rich shape for store() tests)
function makeEpisodic(
  entityId: string,
  overrides: Partial<EpisodicRecord> = {},
): EpisodicRecord {
  episodeCounter++;
  const id = ulid();
  return {
    id,
    timestamp: new Date().toISOString(),
    actor: { entityId, coaAlias: entityId },
    summary: overrides.summary ?? `episode summary ${String(episodeCounter)}`,
    tags: overrides.tags ?? ["test"],
    confidence: overrides.confidence ?? 0.8,
    sourceLinks: overrides.sourceLinks ?? ["session:test"],
    coaFingerprint: overrides.coaFingerprint ?? "test-fp",
    modelVersion: overrides.modelVersion ?? "test-model",
    hash: overrides.hash ?? `hash-${id}`,
    primeAlignment: overrides.primeAlignment,
  };
}

// GraphEventRecord (native shape for storeEpisodicEvent)
function makeGraphEvent(
  entityId: string,
  overrides: Partial<GraphEventRecord> = {},
): GraphEventRecord {
  episodeCounter++;
  const id = ulid();
  return {
    id,
    entityId,
    projectPath: overrides.projectPath ?? null,
    summary: overrides.summary ?? `graph event ${String(episodeCounter)}`,
    tags: overrides.tags ?? ["test"],
    confidence: overrides.confidence ?? 0.8,
    sourceLinks: overrides.sourceLinks ?? [],
    coaFingerprint: overrides.coaFingerprint ?? "fp",
    hash: overrides.hash ?? `hash-${id}`,
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 1. GraphMemoryAdapter — MemoryProvider interface
// ---------------------------------------------------------------------------

describe("GraphMemoryAdapter — MemoryProvider interface", () => {
  let dir: string;
  let adapter: GraphMemoryAdapter;

  beforeEach(() => {
    dir = makeTmpDir();
    adapter = makeAdapter(dir);
    episodeCounter = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores a MemoryEntry (legacy shape) and retrieves it via query()", async () => {
    await adapter.store({
      id: "mem-001",
      entityId: "E1",
      content: "user prefers dark mode",
      category: "preference",
      source: "explicit",
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      accessCount: 0,
    });

    const results = await adapter.query({ entityId: "E1" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toBe("user prefers dark mode");
  });

  it("stores an EpisodicRecord (rich shape) and retrieves it via query()", async () => {
    const ep = makeEpisodic("E2", { summary: "completed scheduler rewrite" });
    await adapter.store(ep);

    const results = await adapter.query({ entityId: "E2" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toContain("completed scheduler rewrite");
  });

  it("only returns entries for the requested entity", async () => {
    await adapter.store({ id: "m1", entityId: "EA", content: "entity A", category: "fact", source: "explicit", createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(), accessCount: 0 });
    await adapter.store({ id: "m2", entityId: "EB", content: "entity B", category: "fact", source: "explicit", createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(), accessCount: 0 });

    const results = await adapter.query({ entityId: "EA" });
    expect(results.every((r) => r.entityId === "EA")).toBe(true);
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 8; i++) {
      await adapter.store({ id: `m-lim-${String(i)}`, entityId: "EL", content: `memory ${String(i)}`, category: "fact", source: "explicit", createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(), accessCount: 0 });
    }

    const results = await adapter.query({ entityId: "EL", limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("isAvailable always returns true (local SQLite)", async () => {
    expect(adapter.isAvailable()).toBe(true);
  });

  it("count returns 0 for unknown entity", async () => {
    expect(await adapter.count("ghost")).toBe(0);
  });

  it("count returns correct number after stores", async () => {
    await adapter.store({ id: "c1", entityId: "EC", content: "a", category: "fact", source: "explicit", createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(), accessCount: 0 });
    await adapter.store({ id: "c2", entityId: "EC", content: "b", category: "fact", source: "explicit", createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(), accessCount: 0 });
    expect(await adapter.count("EC")).toBe(2);
  });

  it("delete removes the entry and decrements count", async () => {
    await adapter.store({ id: "del1", entityId: "ED", content: "to delete", category: "fact", source: "explicit", createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(), accessCount: 0 });
    expect(await adapter.count("ED")).toBe(1);
    await adapter.delete("del1");
    expect(await adapter.count("ED")).toBe(0);
  });

  it("deleteAllForEntity removes all entries for that entity only", async () => {
    await adapter.store({ id: "da1", entityId: "E_A", content: "a1", category: "fact", source: "explicit", createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(), accessCount: 0 });
    await adapter.store({ id: "da2", entityId: "E_A", content: "a2", category: "fact", source: "explicit", createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(), accessCount: 0 });
    await adapter.store({ id: "db1", entityId: "E_B", content: "b1", category: "fact", source: "explicit", createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(), accessCount: 0 });
    await adapter.deleteAllForEntity("E_A");
    expect(await adapter.count("E_A")).toBe(0);
    expect(await adapter.count("E_B")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. GraphMemoryAdapter — EpisodicRecord + graph methods
// ---------------------------------------------------------------------------

describe("GraphMemoryAdapter — episodic + graph methods", () => {
  let dir: string;
  let adapter: GraphMemoryAdapter;

  beforeEach(() => {
    dir = makeTmpDir();
    adapter = makeAdapter(dir);
    episodeCounter = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores and retrieves a GraphEventRecord via storeEpisodicEvent", () => {
    const ev = makeGraphEvent("$A0", { summary: "fixed scheduler deadlock" });
    adapter.storeEpisodicEvent(ev);

    const events = adapter.queryGraphEvents({ entityId: "$A0", limit: 10 });
    expect(events.length).toBe(1);
    expect(events[0]!.summary).toBe("fixed scheduler deadlock");
  });

  it("queryGraphEvents filters by projectPath", () => {
    const global = makeGraphEvent("$A0", { summary: "global event", projectPath: null });
    const proj = makeGraphEvent("$A0", { summary: "project event", projectPath: "/my/project" });
    adapter.storeEpisodicEvent(global);
    adapter.storeEpisodicEvent(proj);

    const globalOnly = adapter.queryGraphEvents({ entityId: "$A0", projectPath: null, limit: 10 });
    expect(globalOnly.every((e) => e.projectPath === null || e.projectPath === undefined)).toBe(true);
    expect(globalOnly.some((e) => e.summary === "global event")).toBe(true);

    const projOnly = adapter.queryGraphEvents({ entityId: "$A0", projectPath: "/my/project", limit: 10 });
    expect(projOnly.some((e) => e.summary === "project event")).toBe(true);
  });

  it("does not store duplicate hashes (idempotent on same hash)", () => {
    const ev = makeGraphEvent("$A0");
    adapter.storeEpisodicEvent(ev);
    adapter.storeEpisodicEvent(ev); // same record, same hash → INSERT OR IGNORE
    const events = adapter.queryGraphEvents({ entityId: "$A0", limit: 10 });
    expect(events.length).toBe(1);
  });

  it("getUnconsolidated returns events without consolidated_at", () => {
    const ev1 = makeGraphEvent("$A0");
    const ev2 = makeGraphEvent("$A0");
    adapter.storeEpisodicEvent(ev1);
    adapter.storeEpisodicEvent(ev2);

    const unconsolidated = adapter.getUnconsolidated("$A0", undefined, 10);
    expect(unconsolidated.length).toBe(2);
  });

  it("markConsolidated sets consolidated_at and removes from getUnconsolidated", () => {
    const ev = makeGraphEvent("$A0");
    adapter.storeEpisodicEvent(ev);
    expect(adapter.getUnconsolidated("$A0", undefined, 10).length).toBe(1);

    adapter.markConsolidated([ev.id]);
    expect(adapter.getUnconsolidated("$A0", undefined, 10).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. GraphMemoryAdapter — relationships
// ---------------------------------------------------------------------------

describe("GraphMemoryAdapter — relationships", () => {
  let dir: string;
  let adapter: GraphMemoryAdapter;
  const now = Date.now();

  beforeEach(() => {
    dir = makeTmpDir();
    adapter = makeAdapter(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeRel(overrides: Partial<RelationshipRecord> = {}): RelationshipRecord {
    return {
      id: ulid(),
      subjectEntityId: overrides.subjectEntityId ?? "$A0",
      predicate: overrides.predicate ?? "worked_on",
      objectEntityId: null,
      objectLiteral: overrides.objectLiteral ?? "some task",
      projectPath: overrides.projectPath ?? null,
      validFrom: overrides.validFrom ?? now,
      validUntil: overrides.validUntil ?? null,
      confidence: overrides.confidence ?? 0.9,
      sourceEventIds: overrides.sourceEventIds ?? [],
      createdAt: overrides.createdAt ?? now,
    };
  }

  it("stores and retrieves a relationship", () => {
    const rel = makeRel({ objectLiteral: "memory system rewrite" });
    adapter.storeRelationship(rel);

    const results = adapter.queryRelationships({ subjectEntityId: "$A0", limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0]!.objectLiteral).toBe("memory system rewrite");
  });

  it("queryRelationships filters by predicate", () => {
    adapter.storeRelationship(makeRel({ predicate: "completed", objectLiteral: "task A" }));
    adapter.storeRelationship(makeRel({ predicate: "learned", objectLiteral: "insight B" }));

    const completed = adapter.queryRelationships({ subjectEntityId: "$A0", predicate: "completed" });
    expect(completed.length).toBe(1);
    expect(completed[0]!.objectLiteral).toBe("task A");
  });

  it("queryRelationships respects validAt — excludes expired relationships", () => {
    const past = now - 1000;
    const expired = makeRel({ validFrom: past, validUntil: past + 100, objectLiteral: "expired" });
    const active = makeRel({ validFrom: past, validUntil: null, objectLiteral: "active" });
    adapter.storeRelationship(expired);
    adapter.storeRelationship(active);

    const results = adapter.queryRelationships({ subjectEntityId: "$A0", validAt: new Date(now) });
    const literals = results.map((r) => r.objectLiteral);
    expect(literals).not.toContain("expired");
    expect(literals).toContain("active");
  });

  it("invalidatePriorRelationship sets validUntil on open relationships", () => {
    const rel = makeRel({ predicate: "worked_on", objectLiteral: "old task" });
    adapter.storeRelationship(rel);

    adapter.invalidatePriorRelationship("$A0", "worked_on", null, now + 5000);

    // After invalidation, no active relationships should remain for that predicate
    const active = adapter.queryRelationships({
      subjectEntityId: "$A0",
      predicate: "worked_on",
      validAt: new Date(now + 6000),
    });
    expect(active.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. GraphMemoryAdapter — doc chunks
// ---------------------------------------------------------------------------

describe("GraphMemoryAdapter — doc chunks", () => {
  let dir: string;
  let adapter: GraphMemoryAdapter;

  beforeEach(() => {
    dir = makeTmpDir();
    adapter = makeAdapter(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores and retrieves a doc chunk", () => {
    adapter.storeDocChunk({
      id: ulid(),
      sourcePath: "/agi/docs/memory.md",
      scope: "global",
      heading: "Memory System",
      content: "The memory system uses SQLite with FTS5.",
      chunkIndex: 0,
      contentHash: "abc123",
      indexedAt: Date.now(),
    });

    const results = adapter.queryDocChunks({ semantic: "memory sqlite", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.sourcePath).toBe("/agi/docs/memory.md");
  });

  it("getDocChunkHash returns null for unknown path", () => {
    expect(adapter.getDocChunkHash("/unknown/path.md")).toBe(null);
  });

  it("getDocChunkHash returns hash after storing", () => {
    adapter.storeDocChunk({
      id: ulid(),
      sourcePath: "/k/notes.md",
      scope: "global",
      heading: null,
      content: "some content",
      chunkIndex: 0,
      contentHash: "myhash456",
      indexedAt: Date.now(),
    });

    expect(adapter.getDocChunkHash("/k/notes.md")).toBe("myhash456");
  });

  it("deleteDocChunksForPath removes all chunks for that path", () => {
    const path = "/agi/docs/test.md";
    adapter.storeDocChunk({ id: ulid(), sourcePath: path, scope: "global", heading: null, content: "chunk 1", chunkIndex: 0, contentHash: "h1", indexedAt: Date.now() });
    adapter.storeDocChunk({ id: ulid(), sourcePath: path, scope: "global", heading: null, content: "chunk 2", chunkIndex: 1, contentHash: "h1", indexedAt: Date.now() });

    adapter.deleteDocChunksForPath(path);

    const results = adapter.queryDocChunks({ scope: "global", limit: 10 });
    expect(results.every((c) => c.sourcePath !== path)).toBe(true);
  });

  it("queryDocChunks filters by scope", () => {
    adapter.storeDocChunk({ id: ulid(), sourcePath: "/global.md", scope: "global", heading: "Global", content: "global knowledge content", chunkIndex: 0, contentHash: "gh", indexedAt: Date.now() });
    adapter.storeDocChunk({ id: ulid(), sourcePath: "/proj.md", scope: "project:/my/proj", heading: "Project", content: "project knowledge content", chunkIndex: 0, contentHash: "ph", indexedAt: Date.now() });

    const global = adapter.queryDocChunks({ scope: "global", semantic: "knowledge", limit: 10 });
    expect(global.every((c) => c.scope === "global")).toBe(true);

    const proj = adapter.queryDocChunks({ scope: "project:/my/proj", semantic: "knowledge", limit: 10 });
    expect(proj.every((c) => c.scope === "project:/my/proj")).toBe(true);
  });
});
