# Philosophy: where Projektor fits

Agentic dev tooling stacks in three layers of *concern*. The trap is treating
those layers as products. They aren't — **the layers are concerns; the product
boundary is the API.** With MCP as the narrow waist, one clean tool can cut a
*vertical slice* across several layers and stay coherent, because the API stays
coherent. That is what Projektor is: not a layer, a slice.

This page is the *why*. For the *how* — the actual multi-agent loop these layers
combine into — see [Agentic workflows](./agent-workflows.md).

## The three layers (concerns, not products)

1. **Implementation — the runtime.** Spawning, worktrees, job objects;
   *routing* (which model: opus plans, sonnet builds, haiku looks up) and
   *conditioning* (prompt and context optimisation, token terseness); and
   verification *transitions* — running the tests, the human review. (The
   operational guide calls the spawn-and-reap slice of this layer the
   *lifecycle* layer; here we take the wider runtime view.)
2. **Coordination — communication.** A message bus, agent presence,
   context-fetch and skills. For a fleet this layer is largely *subsumed* by the
   one above it: the issue graph **is** shared memory, and status changes **are**
   events.
3. **Project management — the source of truth.** The durable state: the
   issue / epic / sprint graph, machine-readable prioritisation, and the
   state-machine *nodes* that record what verification decided.

Projektor is a single MCP surface spanning coordination and project management;
through file claims it even reaches into a runtime concern — who may write which
file. It owns the **nodes** of the
work state machine; the implementation layer owns the **transitions**. Projektor
never runs a test or judges a diff — it records the outcome.

```mermaid
flowchart TB
    human(["Human / lead agent — intent, priorities, final review"])

    subgraph L3["Project management — source of truth"]
        graph3["Issue / epic / sprint graph = shared memory"]
        prio["Prioritise & decompose (machine-readable)"]
        state["State-machine NODES — records verification outcome"]
    end

    subgraph L2["Coordination — communication"]
        prim["Agent-native primitives: file claims · registry · heartbeat"]
        evt["Comments · status · messages = event log / bus"]
        ctx["Context fetch · skills · repo memory"]
    end

    subgraph L1["Implementation — runtime"]
        spawn["Spawn · worktrees · job objects"]
        route["Routing: opus plans · sonnet builds · haiku looks up"]
        cond["Conditioning: prompt / context optimisation"]
        verify{{"Transitions: tests + human review"}}
    end

    projektor["Projektor — one MCP surface, vertical slice"]
    projektor -.-> graph3
    projektor -.-> prim
    projektor -.-> state

    human --> prio --> graph3 --> prim
    prim <--> evt
    evt --> ctx --> spawn
    spawn --> route --> cond --> verify
    verify -->|pass / fail| state
    state -->|feedback / replan| human
```

## The empty middle

Projektor sits between two kinds of tool that already exist:

- **Jira / Notion** are mature and scalable, but *human-first*: agent
  interaction is bolted on, the API is not the primary surface, and you can't
  cheaply self-host a slice of them.
- **beads** is genuinely agent-native, but it's a *git-file* tracker — issues as
  JSONL versioned in the repo. That gives offline resilience and issues that
  version alongside the code, but it is structurally per-repo and merge-bound.

Projektor claims the gap between them: **agent-native like beads, deployed and
cross-project like Jira, and cheap enough to run on serverless for a small
project.** When you outgrow it, you swap the database — not the system. Workers
scale compute for free; D1 is the one bottleneck, and it's a swap, not a rewrite.

| | beads (git-file) | Projektor (deployed) | Jira / Notion |
|---|---|---|---|
| Primary surface | agent-native | agent-native (MCP) | human-first |
| Scope | per-repo | cross-project | cross-project |
| Concurrency | git merge on JSONL | claims · heartbeats | human process |
| Presence / bus | none native | registry + messages | none native |
| Self-host cost | free (no server) | cheap (serverless) | heavy / SaaS |

## Honest tradeoffs

These are deliberate bets, not oversights:

1. **A central coordinator on the write path.** Becoming a deployed tracker puts
   Projektor's availability on every worker's critical line — the price of
   cross-project claims and presence that beads, being offline and git-backed,
   never pays. The bet: fleet-scale coordination is worth more than git's offline
   resilience and the issue-versioned-with-code property.
2. **Task↔code links by convention.** Agents cite `PROJ-123` in commits, exactly
   like humans. That link is grep-able, not queryable — a field to buy back later
   if it earns its place, not a rewrite.
3. **Coordination, not judgment.** Design, test types, and what "done" means stay
   with the engineer. Projektor records the decision; it never makes it.

## Where to go next

- **The operational loop:** [Agentic workflows](./agent-workflows.md) — how the
  three layers combine into a real multi-agent dev cycle.
- **The system underneath:** [Architecture](./architecture.md).
- **Connect an agent:** [Connect an AI agent](./mcp.md).
