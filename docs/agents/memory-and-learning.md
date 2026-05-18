# Memory & Learning Framework

> **Authoritative doc for s112.** Workers, plugins, and future agents building against the memory system should read this before touching any memory-related code.

## Overview

Aion's memory + learning system separates two distinct concerns:

- **Memory** is for recall — facts, preferences, prior decisions, project state. Things the agent needs to retrieve and use at inference time.
- **Fine-tuning** is for behavior — how to reason under the doctrine, how to weigh tradeoffs, how to structure responses. Things that belong in the model's weights, not a lookup table.

Mixing these — trying to put every conversation into training data, or storing behavior policies in memory — is how self-improvement turns into self-sabotage. The layered architecture enforces the separation.

The system is built on a four-layer model. Each layer has a distinct storage medium, a distinct retrieval path, and a distinct v0.4.0 status. Higher-numbered layers are progressively longer-lived and more expensive to update.

Source spec: `_discovery/aion-blockchain-memory-draft-a.md`. PRIME memory protocol: `aionima-prime/core/0MEMORY.md`.

---

## The 4-Layer Memory Model

| Layer | Name | Storage | Lifetime | v0.4.0 Status |
|-------|------|---------|---------|---------------|
| A | Working memory | In-process on `AgentSession` | Current task only | Wired — type contract only; not persisted |
| B | Episodic memory | `~/.agi/memory/` + `agi_data` Postgres | Session-durable, GC'd by retention policy | Wired — schema + hash helper shipped (t381) |
| C | Doctrine (PRIME corpus) | `aionima-prime/` git repo + drift checker | Versioned like source code; humans own changes | Interface only — PRIME reader blocked (t382) |
| D | Blockchain anchor | `~/.agi/anchors/pending.jsonl` (noop); Ethereum/L2 in v0.6.0 | Permanent, cryptographically verifiable | Noop stub shipped (t383); live chain in v0.6.0 (s113) |

### Why four layers?

- **A (working)** — fast ephemeral context for the current turn. Can't be anchored; too volatile.
- **B (episodic)** — summarized events with hash + confidence + COA fingerprint. Retrieved at session open to prime the agent's context. Scored by G4 to build training candidates.
- **C (doctrine)** — the frozen constitution. PRIME owns the semantics. The agent reads doctrine; it does not write it. Doctrine regression tests run against C before promoting any adapter.
- **D (anchor)** — hash ledger only. Content lives in B/C; only the hash + provenance + governance signal touches the chain. Verifiable across time and across machines without paying chain costs for content.

---

## Memory Record Schemas

### Layer A — WorkingMemory

```ts
// packages/memory/src/episodic.ts
export interface WorkingMemory {
  currentGoals: string[];        // What the agent is trying to accomplish
  activeDocuments: string[];     // Files/docs loaded into context this turn
  operationChain: string[];      // Operations executed so far this turn
  temporaryAssumptions: string[];
  capturedAt: string;            // ISO 8601 snapshot timestamp
}
```

Not persisted. Lives on the `AgentSession` during a turn. Used for introspection and cross-module handoff (e.g. prompt-inspector, "what am I doing right now" surface).

---

### Layer B — EpisodicRecord

```ts
// packages/memory/src/episodic.ts
export interface EpisodicRecord {
  id: string;            // ULID — caller responsibility
  timestamp: string;     // ISO 8601 UTC of the event being summarized
  actor: {
    entityId: string;
    coaAlias: string;    // e.g. "#E0", "$A0"
  };
  summary: string;       // Human-readable one-paragraph digest
  tags: string[];        // Categorical retrieval: ["preference", "tool-use", ...]
  embedding?: number[];  // Similarity vector — null in v0.4.0; populated by s116 embedder
  confidence: number;    // Scorer signal: 0..1 — usefulness + alignment + correctness
  primeAlignment?: number; // PRIME-alignment score: 0..1 — null in v0.4.0 (G2 blocked)
  sourceLinks: string[]; // Chat session IDs, doc paths, tool call IDs sourced for this episode
  hash: string;          // Canonical content hash — computed by canonicalEpisodicHash()
  coaFingerprint: string; // Ties this record to the COA<>COI chain
  modelVersion?: string; // Which model produced the source content
}
```

**Computing the hash:**

```ts
import { canonicalEpisodicHash } from "@agi/memory";

// hash excludes: embedding, primeAlignment, confidence
// so re-scoring doesn't change a record's identity
const hash = canonicalEpisodicHash(record);
```

The hash over `(actor, coaFingerprint, id, modelVersion, sourceLinks, summary, tags, timestamp)` — keys in insertion order, with array fields sorted — gives a stable identity for the *event*, not the scorer's opinion of the event.

---

### Layer D — AnchorRecord / BlockchainAnchor

```ts
// packages/aion-sdk/src/anchor.ts
export interface AnchorRecord {
  hash: string;           // sha256 of the content artifact (episodic record, dataset, adapter)
  owner: string;          // Entity that produced/owns the artifact ("$A0", "#E0")
  timestamp: string;      // ISO 8601 UTC
  provenance: {
    source: string;       // "episodic-memory", "training-dataset", "adapter-promotion", ...
    modelVersion?: string;
  };
  evalScore?: number;      // Eval score snapshot — used for adapter promotion anchors
  governanceApproval?: {   // Optional DAO/human approval for major promotions
    approver: string;
    signedAt: string;
  };
}

export interface BlockchainAnchor {
  anchor(record: AnchorRecord): Promise<AnchorResult>;
  verify(hash: string): Promise<{ exists: boolean; record?: AnchorRecord }>;
  listByOwner(owner: string, limit?: number): Promise<AnchorRecord[]>;
}
```

**v0.4.0 implementation — `NoopAnchor`:**

```ts
import { NoopAnchor } from "@agi/memory";

const anchor = new NoopAnchor(); // writes to ~/.agi/anchors/pending.jsonl
const result = await anchor.anchor(record);
// result.txHash: "noop:<sha256-of-record-json>" — stable, deterministic
```

**Bridging Layer B → Layer D:**

```ts
import { episodicToAnchor } from "@agi/memory";

// Keeps content out of anchor (content lives in B storage; only hash + provenance anchored)
const anchorRecord = episodicToAnchor(episodicRecord);
const { txHash } = await anchor.anchor(anchorRecord);
```

---

### Layer C — DoctrineEntry (PRIME corpus)

Not yet defined as a TypeScript schema — G2 is blocked on PRIME schema realignment. When it lands (t382), it will expose:

- Axioms + value hierarchy
- Economic ontology + definitions
- Anti-patterns + case-law precedents

The PRIME corpus lives in `aionima-prime/` and is read-only at runtime. The agent reads doctrine; doctrine changes go through the PRIME repo + human review. This is intentional: the layer that constrains the model must not be writable by the model.

---

## The Training Loop

Self-improvement in this architecture means: **propose → judge → train → verify → adopt**. Not: append every conversation to weights.

```
User interaction
  → Memory extraction       (s112 G4 scorer — episode scoring pipeline)
  → Episode scoring         (confidence, primeAlignment — when G4 ships)
  → Candidate dataset       (s112 G5 accumulator — gates: coherence, novelty, doctrine alignment)
  → SFT or DPO batch job    (HF Transformers + PEFT + TRL — s112 G6 scaffold)
  → New LoRA adapter
  → Eval suite              (4 gates below)
  → Governance decision     (threshold improvement + no critical regressions)
  → Promote or reject
  → Anchor hash/provenance  (NoopAnchor in v0.4.0; live chain in v0.6.0)
```

### v0.4.0 status of each loop step

| Step | Status |
|------|--------|
| Memory extraction | Manual — no auto-extraction yet |
| Episode scoring (G4) | Blocked (t384) |
| Candidate dataset (G5) | Blocked (t385) |
| Training pipeline (G6) | Blocked (t386) |
| LoRA adapter | Not yet |
| Eval suite (4 gates) | Scaffold only — gate contracts defined, not wired |
| Governance decision | Not yet — manual human review |
| Anchor hash/provenance | NoopAnchor ships (t383) ✓ |

---

## The 4 Eval Gates

Every candidate adapter passes four gates before promotion. Failing any gate → reject the adapter.

### Gate 1 — Data quality gate

Filters training examples before they join the candidate set:

- Coherence check (is the episode internally consistent?)
- Factuality check (where verifiable)
- Doctrine alignment check (does it reinforce or contradict PRIME?)
- Novelty check (not a near-duplicate of existing training data)
- Duplicate detection (via `canonicalEpisodicHash` dedup)

**v0.4.0 status:** interface contract only — no automated gate, manual curation.

### Gate 2 — Reward / evaluation gate

Every adapter is tested against held-out evals before promotion:

- Held-out eval set
- Adversarial set
- Regression set
- Philosophy consistency set (against PRIME doctrine)
- Safety set

**v0.4.0 status:** infrastructure stub — fixture paths defined, not populated.

### Gate 3 — Governance gate

Guards against promoting an adapter that scored slightly higher on average while regressing on something critical:

- Threshold improvement required (not just +0.01%)
- No critical regressions on any eval category
- Optional human review (required for major upgrades)
- Optional blockchain-recorded approval event (v0.6.0)

**v0.4.0 status:** not wired — all promotions are manual.

### Gate 4 — Rollback gate

Every promoted adapter must carry:

- Version id
- Parent version
- Training data snapshot hash
- Reproducible training config
- Instant rollback path

Without rollback, self-improvement becomes self-sabotage. **v0.4.0 status:** NoopAnchor provides the hash ledger for this; rollback tooling is not yet built.

---

## Identity Drift Prevention

The hardest part of self-improvement is not the chain or the fine-tuning. It is **identity drift**: the model slowly stops being your impact-economics agent and becomes an average of recent interactions.

Preventive controls, in order of importance:

1. **Fixed constitution** — Layer C (PRIME doctrine) is read-only for the agent. Doctrine changes require human commits to `aionima-prime/`.
2. **Frozen gold evals** — the eval suite's regression set is never overwritten by training data. New examples get added; old ones stay.
3. **Doctrine regression tests** — Gate 2's philosophy-consistency set runs the adapter against PRIME-derived test cases before any promotion.
4. **Weighted sampling** — when building training batches, canonical doctrine data is over-weighted relative to recent interaction data. Recent noise cannot drown out foundational alignment.
5. **Human/governance veto** — Gate 3 makes major upgrades require explicit review. The AnchorRecord's `governanceApproval` field carries the audit trail.

---

## What ships in v0.5.0+

These are explicitly deferred from v0.4.0:

| Feature | Tynn story |
|---------|-----------|
| Live self-improvement loop (auto-trigger LoRA training) | s114 |
| Live blockchain anchoring (Ethereum/L2 + IPFS encrypted blobs) | s113 |
| Embedding plugin + vector retrieval (populates `EpisodicRecord.embedding`) | s116 |
| Decentralized memory network (replicate artifacts across nodes) | s117 (phase 5) |
| PRIME corpus reader + drift detector (Layer C wired) | t382 |
| Episode scoring pipeline (G4) | t384 |
| Candidate dataset accumulator + 4-gate eval scaffolding (G5) | t385 |
| LoRA training pipeline scaffold (G6) | t386 |

---

## Cross-References

- `_discovery/aion-blockchain-memory-draft-a.md` — source architecture spec; the design rationale behind every layer and gate
- `aionima-prime/core/0MEMORY.md` — PRIME's memory protocol (0M/0K/0L pointer system; PRIME owns the doctrine semantics; agi owns the memory + training implementation)
- `aionima-prime/WIP/knowledge/impactonomics-whitepaper.md` — TRUE COST framing that episodic memory + training decisions are measured against
- `packages/memory/src/episodic.ts` — Layer A + B type definitions + `canonicalEpisodicHash` + `episodicToAnchor`
- `packages/memory/src/anchors/noop.ts` — Layer D NoopAnchor (v0.4.0)
- `packages/aion-sdk/src/anchor.ts` — `AnchorRecord` / `BlockchainAnchor` interface contracts
- `docs/agents/system-prompt-assembly.md` — how episodic memories get injected into the system prompt at session open
