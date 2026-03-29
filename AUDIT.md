# Command Center Codebase Audit

**Date:** 2026-03-29
**Scope:** Full codebase audit comparing design specs against implementation

---

## Executive Summary

The codebase implements the **Phase 0-1 shell and basic infrastructure** (gateway, UI scaffold, task/agent stores, GitHub polling) but is missing the **core intelligence and orchestration layer** that the specs describe. The system currently functions as a read-only dashboard of GitHub data with scaffolded-but-inert agent/task subsystems.

**Implementation completeness by phase:**
- Phase 0 (Bootstrap): ~70%
- Phase 1 (Board + Team): ~40%
- Phase 2 (Captain + Ops): ~15%
- Phase 3 (Threads): ~20%
- Phase 4 (Metrics): ~10%
- Phase 5 (Feedback): 0%
- Phase 6 (Proactive Captain): ~5%

---

## 1. Major Feature Gaps (Spec vs Implementation)

### 1.1 Event Routing & Subscription System - NOT IMPLEMENTED

**Spec reference:** Harness spec sections 3-4

The spec describes a full event pipeline:
```
GitHub Webhook -> GitHubPlugin.webhookHandler
  -> MessageEnvelope (kind: "ambient")
  -> SubscriptionRouter (fan-out to matching agents)
  -> bus.publishMessage()
  -> DeliveryWorker -> LLM
```

**What's missing:**
- `SubscriptionRouter` class for routing events to agents
- Agent subscription patterns (e.g., `"labels:backend"`)
- Webhook ingestion endpoint (`POST /webhooks/github`)
- Event bus integration
- Ambient message delivery to agents

**Impact:** Agents never learn about GitHub events. The entire reactive intelligence layer is absent.

---

### 1.2 Captain Proactive Behaviors - MINIMAL

**Spec reference:** Phases 2, 6

Captain exists as a bootstrapped agent but has no proactive capabilities:

| Behavior | Status |
|----------|--------|
| Morning digest generation | Missing |
| Stale PR/issue detection | Missing |
| Standup prep from commits + threads | Missing |
| Incident triage (alert -> context -> issue -> thread) | Missing |
| Thread participation ("This PR has been open 4 days") | Missing |
| KB self-updating (team roster, conventions) | Missing |
| On-demand agent creation | Missing |
| Reminder scheduling & firing | Missing |

---

### 1.3 Dynamic Agent Lifecycle - INCOMPLETE

**Spec reference:** Harness spec section 2

| Capability | Status |
|------------|--------|
| Agent CRUD via API | Implemented |
| KB directory scaffolding | Implemented |
| Agent runtime start/stop/destroy | Missing |
| AssistantRuntimeManager integration | Missing |
| Agent-specific context delivery | Missing |
| Status transition validation (active -> running -> stopped) | Missing |
| Agent subprocess spawning | Missing |

---

### 1.4 Task Orchestrator Plugin - NOT IMPLEMENTED

**Spec reference:** Harness spec section 6, 9

`TaskStore` handles persistence, but the orchestration layer is absent:

- No state transition validation (can jump from `blocked` to `done`)
- No workflow automation hooks
- No `contextProvider` surfacing active/blocked tasks to Captain
- No `actionHandler` for task CLI commands from agents
- No escalation timeout tracking
- No automatic task-to-thread linking
- No event emission on task changes

---

### 1.5 CI/CD Plugin - NOT IMPLEMENTED

**Spec reference:** Harness spec section 9

- No `CIPlugin` class
- Only GitHub Actions data via `GitHubPlugin` polling
- No webhook handling for build status changes
- No real-time CI failure notifications to Captain
- No deploy tracking or rollback information

---

### 1.6 Feedback Channel - NOT IMPLEMENTED (Phase 5)

An entire phase with zero implementation:

- No `FeedbackPlugin`
- No feedback endpoints (`/api/feedback/message`, `/api/feedback/messages`, `/api/feedback/events`)
- No embeddable feedback widget (`feedback-widget.js`)
- No Captain feedback triage logic
- No feedback thread creation

---

### 1.7 SSE / Real-Time Updates - NOT IMPLEMENTED

**Spec reference:** Phase 1

- UI connects to `/api/events` but no server-side SSE endpoint exists
- No event publishing when tasks, agents, or GitHub state changes
- No client reconnection with backoff
- No event filtering or schema

---

### 1.8 Missing API Endpoints

| Endpoint | Spec Phase | Status |
|----------|-----------|--------|
| `GET /api/team` | Phase 1 | Missing |
| `GET /api/digest` | Phase 2 | Missing |
| `GET /api/events` (SSE) | Phase 1 | Missing |
| `POST /api/feedback/message` | Phase 5 | Missing |
| `GET /api/feedback/messages` | Phase 5 | Missing |
| `GET /api/feedback/events` | Phase 5 | Missing |
| `POST /webhooks/github` | Phase 1 | Missing |

---

## 2. Partially Implemented Features

### 2.1 Board Tab (Phase 2) - ~60%

**Working:** Kanban columns render, issue cards display with age/assignee/labels.

**Missing:**
- Captain annotations (`stale`, `blocked`, `at_risk`) never populated
- No filtering/sorting by priority, assignee, or label
- No drag-drop to move issues
- Thread linking field exists but is never populated
- Board doesn't refresh on GitHub webhooks (poll-only)

### 2.2 Team Tab (Phase 1) - ~40%

**Working:** Tab renders with fallback data.

**Missing:**
- No `/api/team` endpoint; uses hardcoded fallback data
- No way to define human team members in config
- No presence/online-offline tracking
- No per-person active thread or assigned issue counts
- No recent activity (last commit, last message)

### 2.3 Threads Tab (Phase 3) - ~20%

**Working:** Thread list and chat UI render.

**Missing:**
- `createNewThread()` exists in UI but doesn't call the API
- No auto-thread creation when tasks are created
- Captain not auto-joined to workstream threads
- No message editing/deletion
- No thread archival

### 2.4 Metrics Tab (Phase 4) - ~10%

**Working:** Tab renders, basic task state breakdown displayed.

**Missing:**
- No time-series data collection or storage
- No historical trend tracking (issues/PRs per week)
- No agent activity metrics (message counts, actions)
- No cost tracking (API usage per agent)
- No charts or visualization

### 2.5 Ops Tab (Phase 2) - ~50%

**Working:** GitHub Actions runs displayed, open PRs listed.

**Missing:**
- No deploy tracking (what shipped, when, by whom)
- No incident tracking
- No health checks / service uptime monitoring
- No deployment vs CI status distinction

### 2.6 GitHubPlugin Interface Compliance

The spec requires plugins to implement: `contextProvider`, `sourceAdapter`, `webhookHandler`, `actionHandler`, `apiRoutes`, `surfaceProvider`.

| Interface | Status |
|-----------|--------|
| `init()` | Implemented |
| Data getters (`getIssues`, `getPulls`, `getActions`, `getBoard`) | Implemented |
| `contextProvider` (inject context into agent prompts) | Missing |
| `sourceAdapter` (emit events to bus) | Missing |
| `webhookHandler` (receive GitHub webhooks) | Missing |
| `actionHandler` (execute GitHub commands from agents) | Missing |
| `apiRoutes` (register custom endpoints) | Missing |
| `surfaceProvider` (curate dashboard content) | Missing |

---

## 3. Code Quality & Robustness Issues

### 3.1 Security

| Issue | Location | Severity |
|-------|----------|----------|
| `readBody()` has no size limit; unbounded POST can exhaust memory | `gateway.ts` | Critical |
| No input validation on task title/labels before SQL insert | `task-store.ts` | High |
| Agent ID used in filesystem paths without sanitization (directory traversal risk) | `agent-store.ts` | High |
| No webhook signature validation (if webhooks were added) | `github-plugin.ts` | Medium |
| CLI builds JSON via string concatenation (injection risk) | `bin/cc` | Medium |

### 3.2 Reliability

| Issue | Location | Severity |
|-------|----------|----------|
| SSE reconnect loop without backoff can DOS the server | `ui/app.js` | Critical |
| Task state transitions not validated against state machine | `task-store.ts` | High |
| Child process exit not awaited in `stop()` | `gateway.ts` | High |
| No restart mechanism when child process crashes | `gateway.ts` | High |
| Proxy error handler doesn't close `proxyReq` (resource leak) | `gateway.ts` | High |
| Cache refresh timers never cleared on re-init (memory leak) | `github-plugin.ts` | Medium |
| No retry logic for GitHub CLI failures | `github-plugin.ts` | Medium |
| `Promise.allSettled` results accessed without checking status | `ui/app.js` | Medium |

### 3.3 Data Integrity

| Issue | Location | Severity |
|-------|----------|----------|
| No unique constraint on `github_issue` in tasks table | `task-store.ts` | High |
| No indexes on frequently queried columns (`state`, `assignee`) | `task-store.ts` | Medium |
| Agent ID collision possible (two similar names -> same kebab-case) | `agent-store.ts` | Medium |
| `task_events` audit trail written but never queried or displayed | `task-store.ts` | Low |
| No database connection cleanup on shutdown | `task-store.ts` | Low |

### 3.4 UI/UX

| Issue | Location | Severity |
|-------|----------|----------|
| Loading state not cleared on API error (stuck "Loading...") | `ui/app.js` | High |
| No duplicate-send prevention on chat messages | `ui/app.js` | Medium |
| Selected project not persisted across page reload | `ui/app.js` | Medium |
| No fetch timeouts; unresponsive server hangs UI indefinitely | `ui/app.js` | Medium |
| Retry polling at fixed 5s interval (no backoff) | `ui/app.js` | Medium |
| Modal missing `role="dialog"` and `aria-labelledby` | `ui/index.html` | Medium |
| Tab buttons missing `role="tab"` and `aria-selected` | `ui/index.html` | Medium |
| No ARIA live regions for dynamic content updates | `ui/index.html` | Low |

### 3.5 CLI (`bin/cc`)

| Issue | Location | Severity |
|-------|----------|----------|
| `curl` calls missing `-f` flag; HTTP errors not propagated | All commands | High |
| No validation that required arguments are non-empty | Multiple commands | Medium |
| Label parsing with `sed` breaks on labels containing commas | `task create` | Medium |
| `agent update` produces malformed JSON if both args empty | `agent update` | Medium |
| Python dependency for formatting not guaranteed available | Display commands | Low |

---

## 4. Configuration & Infrastructure Gaps

### 4.1 YAML Config

- `parseSimpleYaml()` only handles flat key:value pairs, not nested structures
- No config schema validation
- Plugin config, reminder config, and agent config blocks in YAML are ignored
- No config hot-reload
- No port uniqueness validation across project configs

### 4.2 Tests

- **Zero tests exist.** No test directory, no test framework configured, no CI.

### 4.3 CI/CD Pipeline

- No GitHub Actions workflows
- No linting configuration
- No build verification
- No automated deployment

### 4.4 Settings UI

- Settings button exists in header but has no implementation
- No project configuration UI
- No integration setup (GitHub token, CI provider)

---

## 5. Prioritized Recommendations

### Tier 1: Fix before production use
1. **Add `readBody()` size limit** in `gateway.ts` (security)
2. **Add SSE reconnect backoff** in `ui/app.js` (reliability)
3. **Add task state transition validation** in `task-store.ts` (data integrity)
4. **Sanitize agent IDs** for filesystem use in `agent-store.ts` (security)
5. **Add database indexes** on `state`, `assignee`, `github_issue` (performance)
6. **Add `-f` flag** to all `curl` calls in `bin/cc` (correctness)

### Tier 2: Core intelligence layer
7. **Implement `/api/events` SSE endpoint** (enables real-time UI)
8. **Implement `/api/team` endpoint** (Team tab functional)
9. **Implement event routing** (SubscriptionRouter + webhook ingestion)
10. **Implement Captain proactive behaviors** (morning digest, stale detection)
11. **Implement agent runtime lifecycle** (start/stop agents as subprocesses)

### Tier 3: Feature completeness
12. **Implement Metrics data collection** and time-series storage
13. **Implement Feedback Channel** (plugin, endpoints, widget)
14. **Implement CI/CD Plugin** beyond GitHub Actions polling
15. **Add test suite** and CI pipeline
16. **Implement Settings UI**

---

## Appendix: File Inventory

| File | Lines | Purpose | Completeness |
|------|-------|---------|-------------|
| `index.ts` | 70 | Gateway entry point | 90% |
| `gateway.ts` | 812 | HTTP server, routing, proxying | 70% |
| `github-plugin.ts` | 337 | GitHub API cache + board | 50% |
| `task-store.ts` | 153 | SQLite task persistence | 60% |
| `agent-store.ts` | 266 | SQLite agent registry + KB scaffold | 50% |
| `harness-entry.ts` | 115 | Project harness bootstrap | 80% |
| `ui/index.html` | 150 | HTML shell | 70% |
| `ui/app.js` | 1,151 | Vanilla JS frontend | 55% |
| `ui/styles.css` | 1,353 | Desktop-first styling | 80% |
| `bin/cc` | 211 | CLI tool | 60% |
