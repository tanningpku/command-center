# Engineering Command Center — Design Spec (v2)

## Overview

A desktop-first web UI for engineering teams to manage projects with AI agents. Built on the same `@companion/core` framework as the personal Companion, but running as a **completely separate instance** — separate process, database, port, and agent set.

**Core metaphor:** Charlie : Companion :: Captain : Command Center

## Architecture: Multi-Instance Backend, Unified Frontend

### Backend: Separate instances per project

```
@companion/core                    ← shared framework (extracted from current src/)
  threads, bus, agents, plugins, surfaces, CLI, SQLite, SSE, reminders, todos

companion/                         ← personal instance (port 3100)
  agents: Charlie, Dash
  plugins: Tesla, Nest, Hue, GWS, Health, Location, Contacts, Weather
  database: data/companion.db
  entry: companion/index.ts

command-center/<project>/          ← one work instance per project (port 3200+)
  agents: Captain (project-specific)
  plugins: GitHub, CI/CD, Monitoring (project-specific)
  database: command-center/<project>/data/project.db
  entry: command-center/index.ts --config <project>.yaml
```

### Frontend: Single unified web UI

The web UI is a single app that aggregates across all running project instances. Like how one Slack app connects to multiple workspaces, or how a k8s dashboard switches between clusters.

```
┌─────────────────────────────────────────────────────┐
│ Command Center                   [Settings] [User]   │
├──────────┬──────────────────────────────────────────┤
│          │                                           │
│ Projects │   Main Content Area                       │
│ ┌──────┐ │                                           │
│ │Compan│ │   (shows selected project's tabs)         │
│ │ ion  │ │                                           │
│ ├──────┤ │   Team / Board / Ops / Threads / Metrics  │
│ │Quant │ │                                           │
│ │Platf.│ │                                           │
│ └──────┘ │                                           │
│          │                                           │
├──────────┴──────────────────────────────────────────┤
│ Captain: "2 PRs blocked, deploy pending review"      │
└─────────────────────────────────────────────────────┘
```

**How it works:**
- A lightweight **gateway** (or the Companion instance itself) serves the unified UI and maintains a **project registry** — a list of running instances with their names and ports
- When the user selects a project, the UI routes all API calls to that instance's port
- SSE streams connect to the selected instance for real-time updates
- Cross-project views (e.g. "all my open items") aggregate from multiple instances

**Project registry** lives in a simple config or the gateway's DB:
```json
[
  { "id": "companion", "name": "Companion", "port": 3200, "status": "running" },
  { "id": "quant", "name": "Quant Platform", "port": 3201, "status": "running" }
]
```

### Why separate backend instances?

1. **Blast radius** — a crash in Project A doesn't affect Project B or personal Companion
2. **Context isolation** — each Captain only knows about its project, no data leakage
3. **Independent lifecycle** — spin up/down projects as needed, upgrade independently
4. **Resource control** — heavy projects don't starve personal assistant or other projects
5. **Clean separation** — personal life data (family, health, Tesla) never mixes with work data

### Shared Services Layer

Some services run independently of any instance and are consumed by all of them:

```
┌─────────────────────────────────────────────┐
│ Shared Services (always running, systemd)    │
│  - Whisper STT          (port 8787)         │
│  - Kokoro/Fish TTS      (port 8788)         │
│  - Cloudflared tunnel   (companion.domain)   │
│  - GWS gateway          (Google Workspace)   │
│  - Future: embedding, image gen, etc.        │
└─────────────────────────────────────────────┘
         ↑              ↑              ↑
    Companion    Command Center    Future App
    (port 3100)  (port 3300)      (port 3400)
```

**Per-instance (isolated):** harness process, DB, agents, plugins, threads
**Shared (one instance, all consumers):** Whisper, TTS, cloudflared, GWS

**Service discovery:** Each instance configures service URLs via `InstanceConfig.services`:

```typescript
services: {
  whisper: process.env.WHISPER_URL ?? 'http://127.0.0.1:8787',
  tts: process.env.TTS_URL ?? 'http://127.0.0.1:8788',
  gws: process.env.GWS_COMMAND ?? 'gws',
}
```

**Health awareness:** `createInstance()` checks service availability at startup — warns if a service is unreachable but doesn't crash (graceful degradation).

**Lifecycle:** Shared services run under systemd, not tied to any harness instance. They start on boot and stay up regardless of which instances are running.

### Future: Cross-instance event bridge (not in scope)

Eventually Charlie might want to know if a deploy broke something, or Captain might need to know Ning's calendar is busy. A lightweight opt-in event bridge between instances is worth keeping in mind for future phases. However, the **feedback channel** (Phase 5) covers the primary cross-instance communication need without requiring a bridge.

### What `@companion/core` provides (the `createInstance` API)

```typescript
import { createInstance } from '@companion/core';

const instance = await createInstance({
  port: 3200,
  dbPath: './data/project.db',
  agents: [
    { id: 'captain', type: 'captain', kb: './kb/captain/', data: './data/captain/' },
  ],
  plugins: [
    new GitHubPlugin({ repo: 'tanningpku/companion' }),
  ],
  ui: {
    routes: { '/': 'command-center.html' },  // custom UI entry point
  },
});

await instance.start();
```

This is the key deliverable: making `@companion/core` a clean, configurable framework. Each instance gets the full power of the platform (threads, bus, agents, surfaces, CLI, SSE) with zero coupling to other instances.

## Scope Hierarchy

```
Engineer (the user — can have multiple projects)
 └── Project (a repo/product — each gets its own Command Center instance)
      └── Workstream (a thread within that instance — "iOS Polish", "Auth Rewrite")
           └── Task (a GitHub Issue — referenced, not duplicated)
```

### Mapping to Primitives

| Concept     | System Primitive              | Notes                                                  |
|-------------|-------------------------------|--------------------------------------------------------|
| Engineer    | User across instances         | Same user ID, different instance DBs                   |
| Project     | A Command Center instance     | Separate process, DB, port, agents, plugins            |
| Captain     | Assistant in instance registry| One per project instance                               |
| Workstream  | Thread within instance        | Groups conversations around a focus area               |
| Task        | GitHub Issue                  | Source of truth stays in GitHub                         |

## Project Configuration

Each project instance is defined by a YAML config file:

```yaml
# command-center/projects/companion.yaml
name: "Companion"
port: 3200
repo: "tanningpku/companion"
dbPath: "./data/companion-project.db"

agents:
  captain:
    id: "captain"
    name: "Captain"
    kb: "./kb/captain/"
    data: "./data/captain/"
    backend: "claude"

plugins:
  github:
    repo: "tanningpku/companion"
    cache_ttl_issues: 300     # 5 min
    cache_ttl_actions: 120    # 2 min
  # Future: ci, monitoring, slack, etc.
```

Multiple projects = multiple config files, each spawning its own instance:

```bash
# Start personal companion
cd companion && npm run dev        # port 3100

# Start Command Center for each project
companion-cc start companion       # port 3200
companion-cc start quant-platform  # port 3201
```

## Captain Agent

### Identity

Each Captain lives within its project instance:

```
command-center/projects/companion/
├── kb/
│   ├── identity.md        -- Role: project captain for companion repo
│   ├── team.md            -- Team members, roles, strengths
│   ├── project.md         -- Repo context, architecture, conventions
│   └── tools.md           -- Available tools (companion CLI, gh CLI, etc.)
└── data/
```

### Captain Responsibilities

1. **Catch-up digest** — When user opens Command Center after being away, Captain provides structured catch-up: new PRs, merged PRs, new/closed issues, thread activity — grouped by impact, not chronology.
2. **Morning digest** — Scan GitHub activity, CI status, open threads. Push "here's what needs your attention today" to surfaces.
3. **Stale work detection** — Flag PRs with no review for 3+ days, issues stuck in progress, blocked items.
4. **Incident triage** — When an alert fires, pull context, identify likely owner, create a thread.
5. **Standup prep** — Auto-draft standup from git commits + issue activity + thread conversations.
6. **Surface curation** — Push structured content to Command Center tabs.
7. **Thread participation** — Actively participate in workstream threads: "This PR has been open 4 days — @dash can you take a look?"

### Captain Scheduling

Uses the instance's built-in reminder system:

```bash
companion reminder create --description "Captain: morning digest" \
  --fire-at "2026-03-27T14:00:00Z" --recur-cron "every 1d"
companion reminder create --description "Captain: scan for stale PRs" \
  --fire-at "2026-03-27T18:00:00Z" --recur-cron "every 12h"
```

## Command Center UI

### Architecture

- Served by the gateway (or Companion instance) — single entry point for all projects
- Vanilla JS SPA (same tech as Companion WebUI — no framework)
- Desktop-optimized: project list sidebar + tabs main content area
- Routes API calls to the selected project's backend instance
- SSE connects to the selected project's event stream for real-time updates
- Project switcher in the left sidebar

### Layout

```
┌─────────────────────────────────────────────────────┐
│ Companion                        [Settings] [Chat]   │
├──────────┬──────────────────────────────────────────┤
│          │                                           │
│  Team    │   Main Content Area                       │
│          │   (renders active tab)                    │
│  Board   │                                           │
│          │                                           │
│  Ops     │                                           │
│          │                                           │
│  Threads │                                           │
│          │                                           │
│  Metrics │                                           │
│          │                                           │
├──────────┴──────────────────────────────────────────┤
│ Captain: "2 PRs blocked, deploy pending review"      │
└─────────────────────────────────────────────────────┘
```

### Tabs

#### 1. Team & Agents

Shows all participants (humans + agents) on this project.

Each card:
- Name, role, avatar
- Current status (online/offline/working)
- Active threads they're in
- Recent activity (last message, last commit)
- Assigned issues count

#### 2. Project Board

Kanban view of GitHub Issues, enriched by Captain's analysis.

Columns: Backlog → In Progress → In Review → Done

Each card:
- Issue title, number, assignee
- Priority label, age
- Captain's annotation (e.g. "blocked by #38", "stale — no activity 5 days")
- Link to associated thread if one exists

#### 3. Ops (Reliability)

Operational health dashboard — "is anything broken right now?"

Sections:
- **Build status** — latest CI/CD runs (pass/fail/running)
- **Recent deploys** — what shipped, when, by whom
- **Open incidents** — active issues tagged as incidents
- **Health checks** — service uptime, error rates

#### 4. Threads

Chat interface for this project's threads.

- Thread list sidebar
- Full chat view with multi-agent support
- Quick-create thread

Reuses core thread/chat infrastructure from `@companion/core`.

#### 5. Metrics

Activity analytics over time.

- Issues opened/closed per week
- PRs merged per week
- Agent activity (messages, actions taken)
- Thread activity by workstream
- Cost tracking (API usage per agent)

### Error & Loading States

- **GitHub unreachable:** Board tab shows cached data with "Last updated X minutes ago" banner
- **Captain hasn't pushed yet:** Tabs show "Captain is preparing your dashboard..." placeholder
- **No workstreams:** Threads tab shows empty state with "Create your first workstream" CTA

## GitHub Plugin

Implements `ContextProvider` with a caching layer. Does NOT make raw `gh` calls per request.

```typescript
interface GitHubPluginCache {
  issues: { data: Issue[]; fetchedAt: string; };     // TTL: 5 minutes
  pulls: { data: PR[]; fetchedAt: string; };          // TTL: 5 minutes
  actions: { data: WorkflowRun[]; fetchedAt: string; }; // TTL: 2 minutes
}
```

- Cache warmed on init, refreshed on TTL expiry
- `getSnapshot()` returns cached data (never blocks on API calls)
- Respects GitHub API rate limits (5000 req/hr authenticated)

### Board Response Schema

```typescript
interface BoardResponse {
  columns: Array<{
    id: string;            // "backlog" | "in_progress" | "in_review" | "done"
    label: string;
    issues: Array<{
      number: number;
      title: string;
      state: "open" | "closed";
      assignees: string[];
      labels: string[];
      updatedAt: string;
      age: string;          // "3 days", "2 weeks"
      threadId?: string;    // linked workstream thread
      annotations: Array<{  // Captain's annotations
        type: "stale" | "blocked" | "at_risk" | "info";
        text: string;
      }>;
    }>;
  }>;
  lastUpdated: string;
  source: "github" | "cache";
}
```

## API Endpoints (per instance)

Each Command Center instance exposes these on its own port:

```
GET    /api/board                  — Get project board (issues + captain annotations)
GET    /api/team                   — Get team members + agents
GET    /api/digest                 — Get Captain's latest digest
GET    /api/threads                — List project threads
GET    /api/events                 — SSE stream for real-time updates

# Plus all standard @companion/core endpoints:
# /api/threads, /api/assistants, /api/harness/message/send, etc.
```

## CLI

```bash
# Instance management
companion-cc list                              # List all configured projects
companion-cc start <project>                   # Start a project instance
companion-cc stop <project>                    # Stop a project instance
companion-cc status                            # Show running instances

# Project setup
companion-cc init <project> --repo <url>       # Create new project config
companion-cc config <project>                  # Edit project config

# Interact with a running instance
companion-cc board <project>                   # Show board summary
companion-cc digest <project>                  # Show Captain's latest digest
```

## Implementation Phases

### Phase 0: Extract `@companion/core` (prerequisite)

Make the current Companion codebase cleanly importable as a framework.

Key deliverable: `createInstance(config)` entry point that boots a full harness from config.

This doesn't require a monorepo restructure upfront — start with a `src/core/create-instance.ts` that takes config and returns a running server. The personal Companion's `src/index.ts` becomes a thin wrapper around `createInstance()` with personal-specific config.

Files to create:
- `src/core/create-instance.ts` — the framework entry point
- `src/core/instance-config.ts` — config schema and validation

Files to modify:
- `src/index.ts` — refactor to use `createInstance()` with personal config

### Phase 1: Shell + Team Tab

Get the Command Center running as a separate instance with basic UI.

Files to create:
- `command-center/index.ts` — entry point using `createInstance()`
- `command-center/projects/companion.yaml` — project config
- `command-center/ui/command-center.html`
- `command-center/ui/command-center.js`
- `command-center/ui/command-center.css`

### Phase 2: Captain Agent + Board Tab + Ops Tab

Bring Captain online, wire up GitHub plugin, build Kanban board and Ops view.

Files to create:
- `command-center/projects/companion/kb/identity.md`
- `command-center/projects/companion/kb/tools.md`
- `src/integrations/github-plugin.ts`

### Phase 3: Threads Tab + Thread Participation

Embed chat in Command Center, Captain actively participates in threads.

### Phase 4: Metrics Tab + Polish

Analytics, charts, UX refinement.

### Phase 5: In-Product Feedback Channel

Every product built on the platform ships with a lightweight feedback channel that connects directly to its Command Center Captain.

#### Concept

Instead of agents spanning multiple instances, the product itself has a built-in chat widget (like Intercom, but internal) that connects to the project's Captain. Users report bugs, request features, or ask questions without leaving the product — Captain triages, creates issues, and routes work.

```
Product (e.g. Companion iOS app)
  └── [Feedback button] → opens mini-chat panel
       └── Connected to Command Center instance for that project
       └── User: "Widget stopped working"
       └── Captain: checks recent changes, creates GitHub issue, assigns to workstream
```

#### Architecture

```
Product side:                         Command Center side:
┌─────────────────┐                  ┌──────────────────────────┐
│ Feedback Widget  │ ──── HTTP ────> │ /api/feedback/message    │
│ (embedded chat)  │ <─── SSE ───── │ (Captain's feedback      │
│                  │                 │  thread, scoped per user) │
└─────────────────┘                  └──────────────────────────┘
```

- The feedback widget is a small JS snippet that any product can embed
- It connects to the Command Center instance's API (not the product's own harness)
- Each user gets a feedback thread in the Command Center
- Captain is auto-joined to all feedback threads
- Captain has full project context (board, issues, recent changes) to triage intelligently

#### Product-Side UI (pluggable)

The harness provides the API contract. Each product chooses its own UI:

- **iOS/native apps:** Shared Swift package (`CompanionFeedback`) with a `FeedbackChatView`, or reuse the existing `ChatView` pointed at the Command Center's URL. Triggered by a "Report Issue" button, shake gesture, or settings entry.
- **Web apps:** Embeddable JS widget (`<script>` tag, <5KB) that renders a floating chat button.
- **Desktop apps:** System tray chat, keyboard shortcut, or embedded panel.
- **API-only:** Products can skip UI and call the feedback endpoints directly.

```html
<!-- Example: web widget embed -->
<script src="https://command-center-host/feedback-widget.js"
        data-project="companion"
        data-user="ning">
</script>
```

The key constraint: the harness endpoint is the contract, the UI is pluggable per platform.

#### API Endpoints (on Command Center instance)

```
POST /api/feedback/message          — send a feedback message
  { userId, text, metadata? }       — metadata: page, screenshot, device info
GET  /api/feedback/messages          — get feedback thread history for user
GET  /api/feedback/events            — SSE stream for Captain's replies
```

#### Captain's Feedback Handling

When a feedback message arrives, Captain:
1. Checks if it's a known issue (searches existing GitHub Issues)
2. If new: creates a GitHub Issue with context (user, device, page, recent changes)
3. If existing: links to the issue and provides status update
4. Responds in the feedback thread with what action was taken
5. Optionally routes to a workstream thread for deeper discussion

#### What This Replaces

- No cross-instance event bridge needed
- No agents spanning multiple instances
- No need for users to switch between Companion and Command Center
- Users stay in the product they're using — feedback flows to the right place automatically

#### Implementation Plan

1. Add feedback endpoints to the Command Center gateway
2. Build the embeddable widget (vanilla JS, <5KB)
3. Wire Captain to auto-respond to feedback threads
4. Add feedback thread list to the Command Center Threads tab
5. Embed the widget in the Companion iOS app (WebView or native Swift)

### Phase 6: Captain Agent (Full Implementation)

Bring Captain online as a real Claude-powered agent in the Command Center instance:
- Uses `createInstance()` with Captain as the primary agent
- KB with project context, team info, conventions
- Proactive behaviors: morning digest, stale work detection, standup prep
- Thread participation in workstreams
- Feedback channel triage

## Design Principles

1. **Separate instances, shared core.** Each project is an independent runtime. The intelligence comes from `@companion/core`, the specificity from config and plugins.
2. **Captain curates, UI renders.** Same pattern as Charlie + Your Day.
3. **GitHub is the source of truth for tasks.** Read from GitHub, annotate in Captain, never duplicate.
4. **Threads are the universal conversation primitive.** Workstreams, incidents, discussions — all threads.
5. **Same stack, no new dependencies.** Vanilla JS, SQLite, SSE. No React, no Postgres.
6. **Captain is a teammate, not a dashboard.** Opinionated summaries and proactive thread participation.

## Review History

- **v1 Round 1 (Dash):** Initial spec — Command Center embedded in Companion harness
- **v1 Round 2 (Charlie):** Catch-up digest, Ops in Phase 2, Captain thread participation, project_type
- **v1 Round 2 (Codex):** owner_user_id, indexes, SSE filtering, GitHub caching, board schema, error states
- **v2 (Dash):** Major revision — separated into independent backend instances per project, extracted `@companion/core` as prerequisite, added YAML config, CLI for instance management
- **v2 Review (Charlie):** LGTM. Phase 0 risk is low (pure extract). Suggested cross-instance event bridge as future consideration. Clean up v1 artifacts from Companion harness.
- **v2 Update (Dash):** Added unified frontend architecture — single UI with project switcher that routes to separate backend instances. Added project registry, gateway concept, cross-instance event bridge as future item.
- **v3 (Dash):** Added Phase 5 (In-Product Feedback Channel) and Phase 6 (Captain full implementation). Feedback channel replaces cross-instance event bridge — products embed a chat widget connecting directly to their Captain. No agents span instances. Added Shared Services Layer (Whisper, TTS, cloudflared, GWS) with service discovery via InstanceConfig. Made feedback UI pluggable per platform (native, web, API-only).
