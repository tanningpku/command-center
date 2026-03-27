# Command Center Harness Design Spec

## 1. Architecture Overview

### How a Command Center Instance Boots

A Command Center instance is a standard `createInstance()` call from `@companion/core`, identical in structure to the personal Companion — the difference is entirely in the config passed in. Each project gets its own OS process, SQLite database, agent set, plugin set, and HTTP port.

Boot sequence:

```
companion-cc start <project>
  1. Parse projects/<project>.yaml
  2. Resolve agents from YAML → AgentDefinition[]
  3. Construct plugins from YAML → IntegrationPlugin[]
  4. Call createInstance({ name, agents, plugins, ... })
     ├─ DB init + migrations
     ├─ AssistantRegistry populated (Captain + Coders + Reviewer + QA)
     ├─ buildSystemPrompt() for primary agent (Captain)
     ├─ PluginRegistry.initAll() → GitHub, CI, TaskOrchestrator plugins start
     ├─ EventLoop starts polling SourceAdapters
     ├─ DeliveryWorker starts consuming the bus
     ├─ ReminderScheduler starts (morning digest, stale PR scans)
     └─ UiServer starts on configured port
  5. Register with project registry (gateway)
```

### Component Map

```
command-center/<project>/
├── config.yaml                    ← project definition
├── data/
│   ├── chat.db                    ← SQLite (bus, threads, chats, agents)
│   ├── todos.db                   ← task tracking
│   └── plugins/
│       ├── github/                ← GitHub plugin state cache
│       ├── ci/                    ← CI plugin state
│       └── orchestrator/          ← task orchestrator state
├── kb/
│   ├── captain/
│   │   ├── identity.md
│   │   ├── team.md
│   │   ├── routing-guide.md
│   │   ├── project.md
│   │   └── tools.md
│   ├── coder/
│   │   ├── identity.md
│   │   ├── conventions.md
│   │   └── tools.md
│   ├── reviewer/
│   │   ├── identity.md
│   │   ├── standards.md
│   │   └── tools.md
│   └── qa/
│       ├── identity.md
│       └── tools.md
```

### Relationship to `createInstance()`

The existing `createInstance()` in `src/core/instance.ts` already handles everything a Command Center instance needs. No changes to `createInstance()` itself are required. All Command Center behavior is expressed through config, plugins, and KB content.

---

## 2. Agent Model

### No Fixed Agent Types

Agents are not predefined categories (Coder, Reviewer, QA). Instead, an agent is defined by **metadata** — a flexible set of attributes that describe what it does and what it's good at:

```typescript
interface AgentMetadata {
  id: string;
  name: string;
  role: string;                    // free-text description of responsibilities
  strengths?: string[];            // e.g. ["TypeScript", "iOS", "testing"]
  tools?: string[];                // e.g. ["claude-code", "gh", "companion-cli"]
  kbPath?: string;                 // path to agent's KB directory
}
```

Captain creates agents at runtime based on what the project needs:

```bash
# Captain decides it needs someone to fix an auth bug
bin/companion agent create \
  --name "Auth Fix Agent" \
  --role "Fix the auth token refresh bug described in issue #42" \
  --strengths "TypeScript,auth,backend"

# Captain decides it needs a code reviewer
bin/companion agent create \
  --name "PR Reviewer" \
  --role "Review PRs for code quality, correctness, and test coverage"
```

The agent's identity prompt is constructed from its metadata — no pre-written KB templates needed for every role. Captain composes agents like a manager staffing a project.

### Captain (Primary Agent)

The only pre-configured agent. Runs on the host LLM process (`isPrimary: true`). Creates and manages all other agents.

**Responsibilities:**
- Receives all events (subscribed to `*`)
- Creates agents as needed, assigns work, tracks completion
- Produces digests (morning, catch-up, standup)
- Detects stale work, blocked PRs, failing CI
- Handles feedback channel triage
- Manages subscriptions for agents it creates

### Dynamic Agent Lifecycle

Agents are created on demand by Captain and started by `AssistantRuntimeManager`. They run as separate Claude Code subprocesses. Captain can stop/destroy agents when their work is done.

```bash
bin/companion agent create --name "Bug Fix Agent" --role "..."    # registers in DB
bin/companion agent start bug-fix-agent                           # starts runtime
bin/companion agent stop bug-fix-agent                            # stops runtime
bin/companion agent destroy bug-fix-agent                         # removes from DB
```

---

## 3. Event Flow

### How a GitHub Webhook Becomes a System Message

```
GitHub → POST /webhooks/github → GitHubPlugin.webhookHandler.handle()
  │
  ├─ Parse webhook payload (push, PR opened, issue created, review, CI)
  ├─ Construct MessageEnvelope:
  │     kind: "ambient"
  │     source: "github"
  │     tags: ["github", "pr", "opened", "label:frontend"]
  │     text: "[GitHub] PR #42 opened: 'Fix auth flow' by @alice"
  │     metadata: { paths: ["src/auth/"], labels: ["frontend"], eventType: "pull_request.opened" }
  │
  └─ ingress.ingest(envelope)
       │
       ├─ SubscriptionRouter fans out to matching agents:
       │     Captain: matches * → gets it
       │     Coder-backend: matches labels:["backend"] → skipped
       │     Coder-ios: matches labels:["frontend"] → gets it
       │
       └─ bus.publishMessage(envelope) for each matched agent
            │
            └─ DeliveryWorker → AssistantRouterTransport → LLM
```

### Event Sources

1. **SourceAdapter.poll()** — polled sources (GitHub sync, CI status). Uses existing `EventLoop`.
2. **WebhookHandler.handle()** — push sources (GitHub webhooks, CI callbacks). Uses existing plugin interface.

---

## 4. Routing: Threads as the Universal Primitive

### No Subscription System — Thread Participation IS Routing

Instead of a separate subscription router, agents receive updates based on which threads they participate in. This reuses the existing bus delivery infrastructure with zero new routing code.

**How it works:**
- Captain is a participant in ALL threads (auto-joined)
- When Captain assigns work, it creates a task thread and adds the agent as participant
- The agent receives all messages in threads it's part of
- When work moves to review, Captain adds the reviewer to the thread

**No SubscriptionRouter needed.** The existing `DeliveryWorker` → `AssistantRouterTransport` pipeline already delivers messages to all thread participants.

**For ambient events** (GitHub webhooks, CI failures), Captain receives them (as the always-on primary agent) and decides which agents need to know — by posting in the relevant task threads or creating new ones.

---

## 5. System Prompt Construction

### Architecture: Static Prompt + Live System Messages

System prompts are built once at startup by `buildSystemPrompt()`. Everything dynamic arrives as system messages via the bus.

**Static prompt contains:**
- Identity + role
- Team roster + routing guide
- Tools available
- KB files
- Recent todos/events/chat history

**Live system messages deliver:**
- `[GitHub] PR #42 opened: 'Fix auth flow' by @alice`
- `[CI] Build failed on main — test_auth.py assertion error`
- `[Task] T-15 assigned to you: Implement password reset`
- `[Feedback] User ning: 'Widget stopped working'`

**Agents update their own KB** when they learn durable information. No per-turn prompt rebuilding.

---

## 6. Task Orchestration

### Tasks + Threads Model

A **task** is a structured work item with status (what the Board shows). A **thread** is the conversation where that work gets discussed. They're linked but serve different purposes.

### Task States

```
CREATED → ASSIGNED → IN_PROGRESS → IN_REVIEW → QA → DONE
                          ↓
                       BLOCKED → (back to ASSIGNED after unblock)
```

### Task Schema

```typescript
interface Task {
  id: string;                    // "T-1", auto-incrementing
  title: string;
  description: string;
  githubIssue?: number;
  githubPR?: number;
  state: TaskState;
  assignee?: string;
  createdBy: string;
  priority: "critical" | "high" | "normal" | "low";
  labels: string[];
  threadId?: string;             // linked discussion thread
  latestUpdate?: string;         // structured status note
}
```

### Agent Tools

```bash
# Structured status updates (visible on Board)
bin/companion task create --title "Fix auth flow" --github-issue 42 --priority high
bin/companion task update T-15 --state in_progress --note "Found root cause"
bin/companion task update T-15 --state in_review --pr 47 --note "PR ready"
bin/companion task complete T-15 --note "Merged and deployed"

# Discussion happens in the task's linked thread
bin/companion msg send --thread <task-thread-id> --text "The refresh token returns 401..."
```

### Flow

1. Captain creates task → auto-creates linked thread
2. Captain assigns → adds assignee as thread participant
3. Agent discusses in thread, updates task status via tools
4. Captain monitors Board (task statuses) and Threads (discussions)
5. Captain adds reviewer to thread when work moves to review

### Persistence

Tasks in SQLite (`tasks` + `task_events` tables). Threads use existing infrastructure.

---

## 7. Agent-to-Agent Communication

All inter-agent communication flows through **threads**. Agents never talk directly to each other — they post in shared threads, and the bus delivers to all participants.

**Captain assigns work:**
1. Captain creates task + thread, adds coder as participant
2. Captain posts assignment context in the thread
3. Bus delivers to coder (as a thread participant)

**Coder reports back:**
1. Coder posts updates in the thread (discussion)
2. Coder calls `task update T-15 --state in_review` (structured status)
3. Captain sees both — thread messages and task state changes

**Adding participants as work progresses:**
- Captain adds reviewer to the thread when code is ready
- Captain adds QA agent when review passes
- Each added participant gets the thread history for context

---

## 8. Feedback Channel

### Endpoints (registered by FeedbackPlugin)

```
POST /api/feedback/message      — { userId, text, metadata? } → creates/appends to feedback thread
GET  /api/feedback/messages      — returns feedback thread history for user
GET  /api/feedback/events        — SSE stream for Captain's replies
```

### Flow

1. User sends feedback from the product
2. FeedbackPlugin creates/retrieves `feedback:<userId>` thread, auto-joins Captain
3. Message enters normal bus pipeline
4. Captain receives, searches existing issues, triages:
   - New: creates GitHub Issue + optionally a Task
   - Existing: links and provides status
5. Captain replies in feedback thread (streamed to user via SSE)

---

## 9. Plugin Requirements

| Plugin | Capabilities | New? |
|--------|-------------|------|
| GitHubPlugin | contextProvider, sourceAdapter, webhookHandler, actionHandler, apiRoutes, surfaceProvider | New |
| CIPlugin | sourceAdapter, webhookHandler, contextProvider, apiRoutes, actionHandler | New |
| TaskOrchestratorPlugin | contextProvider, actionHandler, apiRoutes, eventEmitter | New |
| FeedbackPlugin | apiRoutes | New |

All plugin capabilities use existing interfaces from `integration-plugin.ts`. No new interface types needed.

---

## 10. Full YAML Config Example

```yaml
name: "Companion"
port: 3200
repo: "tanningpku/companion"
projectRoot: "/home/ning/code/companion"

# Only Captain is pre-configured. All other agents are created
# dynamically by Captain at runtime via tools.
agents:
  - id: "captain"
    isPrimary: true
    dir: "./kb/captain"
    # Captain auto-gets wildcard subscription (match: "*")

plugins:
  github:
    repo: "tanningpku/companion"
    cache_ttl: { issues: 300, pulls: 300, actions: 120 }
    poll_interval: 60000

  ci:
    provider: "github-actions"
    poll_interval: 120000

  orchestrator:
    escalation_timeout: 3600000

  feedback:
    enabled: true

services:
  whisper: "http://127.0.0.1:8787"
  tts: "http://127.0.0.1:8788"

reminders:
  - description: "Captain: morning digest"
    recur_cron: "every 1d"
  - description: "Captain: stale PR scan"
    recur_cron: "every 12h"
```

---

## 11. Differences from Companion Harness

| Aspect | Companion | Command Center |
|--------|-----------|----------------|
| Primary agent | Charlie (personal) | Captain (project lead) |
| Agent count | 2 (fixed) | 3-6 (configurable) |
| Event sources | Gmail, Calendar, Tesla, Nest | GitHub webhooks, CI, feedback |
| Route resolution | Always Charlie | Subscription-based fan-out |
| Task model | Simple todo list | Task orchestrator with states + handoff |
| KB content | Personal life | Project context + conventions |

### Reused unchanged
- `createInstance()`, `PluginRegistry`, plugin interfaces
- `AssistantRuntimeManager`, `DeliveryWorker`, `AssistantRouterTransport`
- `BusDb`, `ThreadRegistry`, `ChatRepository`
- `buildSystemPrompt()`, `ReminderScheduler`, `HealthMonitor`
- `ObservabilityStore`, `CostTracker`, companion CLI

### New components
- `SubscriptionRouter` — event fan-out per agent subscriptions
- `TaskOrchestratorPlugin` — multi-step task workflow engine
- `GitHubPlugin` — GitHub integration
- `CIPlugin` — CI/CD integration
- `FeedbackPlugin` — in-product feedback channel
- YAML config parser, `companion-cc` CLI

### Minor extensions
- `AssistantIngress` — accept optional `SubscriptionRouter`
- `RouteResolver` — configurable default agent (not hardcoded "charlie")
- `HarnessApi` — register plugin-provided routes

---

## Implementation Phases

1. **Config + Bootstrap** — YAML parser, `companion-cc` CLI, boot Captain-only instance
2. **GitHub Plugin + Subscription Router** — event ingestion, filtered fan-out, Board/Ops UI
3. **Task Orchestrator + Multi-Agent** — task lifecycle, coder/reviewer/QA agents, thread-per-task
4. **Feedback Channel** — endpoints, Captain triage, embeddable widget
5. **CI Plugin + Polish** — build/deploy status, metrics, end-to-end workflow

## Review History

- **v1 (Dash):** Initial harness design spec based on discussion with Ning and Charlie
- **v1 Review (Charlie):** LGTM. SubscriptionRouter integration point is clean, on-demand agent lifecycle is right.
- **v2 (Dash):** No fixed agent types — agents are metadata-driven, created dynamically by Captain. Subscriptions were dynamic DB-backed runtime state.
- **v3 (Dash):** Simplified per Ning's feedback: removed SubscriptionRouter entirely. Threads are the universal routing primitive — agents get updates by being thread participants. Tasks are a structured status layer on top of threads (Board shows task status, Threads show discussion). Much simpler model with zero new routing code.
