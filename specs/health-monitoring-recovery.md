# Health Monitoring, Reliability, and Recovery System

**Status**: Spec (T-64)  
**Author**: backend-lead  
**Date**: 2026-03-30  
**Sprint**: Health & Reliability

## Overview

Cross-team spec for a comprehensive health monitoring, recovery, and alerting system. Covers backend endpoints, CLI tools, web UI, and iOS surfaces.

### Current State

- **GET /api/status** returns `{ ready: bool }` for captain bridge only
- **GET /api/registry/:id/health** returns `{ healthy: bool }` per project
- **ClaudeBridge** has a watchdog (5min stuck timeout), auto-restart with exponential backoff, and orphan cleanup
- **SSE events**: `claude_ready`, `bridge_watchdog_kill`, `agent_restarted` already broadcast
- **CLI**: `cc status` (summary), `cc restart` (build + kill + restart gateway)
- **Gaps**: No per-agent health, no metrics history, no bridge diagnostics, no recovery actions beyond full restart

---

## 1. Deep Health Endpoint

### GET /api/health

Returns comprehensive system health. No project scope required.

```json
{
  "status": "healthy | degraded | unhealthy",
  "uptime_seconds": 3842,
  "started_at": "2026-03-30T21:00:00Z",
  "memory": {
    "rss_mb": 128,
    "heap_used_mb": 64,
    "heap_total_mb": 96
  },
  "projects": {
    "command-center": {
      "status": "active",
      "bridges": {
        "captain": {
          "status": "ready | connecting | disconnected | stuck | restarting",
          "ready": true,
          "uptime_seconds": 3800,
          "started_at": "2026-03-30T21:00:42Z",
          "last_activity_at": "2026-03-30T21:55:00Z",
          "restart_count": 2,
          "last_restart_reason": "watchdog_stuck",
          "ws_port": 13200,
          "active_thread_id": "abc-123",
          "pid": 12345
        },
        "backend-lead": {
          "status": "ready",
          "ready": true,
          "uptime_seconds": 1200,
          "started_at": "2026-03-30T21:20:00Z",
          "last_activity_at": "2026-03-30T21:54:30Z",
          "restart_count": 0,
          "last_restart_reason": null,
          "ws_port": 13300,
          "active_thread_id": null,
          "pid": 12400
        }
      },
      "stores": {
        "tasks": { "ok": true, "path": "data/command-center-tasks.db", "size_kb": 256 },
        "agents": { "ok": true, "path": "data/command-center-agents.db", "size_kb": 48 },
        "threads": { "ok": true, "path": "data/command-center-threads.db", "size_kb": 512 }
      }
    }
  },
  "sse": {
    "connected_clients": 3,
    "buffer_size": 142,
    "buffer_capacity": 200
  },
  "errors_last_hour": 5
}
```

**Overall status logic**:
- `healthy` — all bridges ready, all DBs ok
- `degraded` — at least one bridge not ready or restarting
- `unhealthy` — all bridges down or a DB is inaccessible

### GET /api/health/bridges (project-scoped)

Returns bridge details for a specific project. Uses `X-Project-Id` header.

```json
{
  "bridges": [
    {
      "agent_id": "captain",
      "status": "ready",
      "ready": true,
      "uptime_seconds": 3800,
      "last_activity_at": "2026-03-30T21:55:00Z",
      "restart_count": 2,
      "last_restart_reason": "watchdog_stuck",
      "pid": 12345
    }
  ]
}
```

### Implementation Notes (Backend)

- Track `startedAt`, `restartCount`, `lastRestartReason` on each ClaudeBridge instance
- Add `getHealthInfo()` method to ClaudeBridge returning its diagnostics
- Check DB health via a simple `SELECT 1` on each SQLite store
- Use `process.memoryUsage()` for memory stats
- Track `gatewayStartedAt` timestamp in Gateway constructor
- Track `errorsLastHour` with a simple rolling counter

---

## 2. Recovery Actions API

All recovery endpoints require authentication (behind existing auth gate). All are POST.

### POST /api/health/bridges/:agentId/restart (project-scoped)

Restart a specific agent's bridge. Stops the current bridge and starts a new one.

```json
// Request: empty body or { "reason": "manual restart" }
// Response:
{ "ok": true, "agent_id": "captain", "action": "restarting" }
```

### POST /api/health/bridges/:agentId/stop (project-scoped)

Stop a specific bridge without restarting.

```json
{ "ok": true, "agent_id": "captain", "action": "stopped" }
```

### POST /api/health/bridges/:agentId/start (project-scoped)

Start a bridge that was stopped.

```json
{ "ok": true, "agent_id": "captain", "action": "starting" }
```

### POST /api/restart (already implemented - T-63)

Restart the entire gateway. Responds 200 then exits after 500ms. run.sh auto-restarts.

### POST /api/health/cleanup

Kill stale/orphaned claude processes. Calls existing `killStaleClaude()`.

```json
{ "ok": true, "killed": 2 }
```

### Implementation Notes (Backend)

- Bridge restart: call `bridge.stop()`, remove from map, call `startAgentBridge()` again
- Bridge stop: call `bridge.stop()`, remove from map, do not restart
- Bridge start: call `startAgentBridge()` if bridge not already running
- Cleanup: make `killStaleClaude()` return a count of killed processes
- Broadcast SSE events for all recovery actions: `bridge_restarted`, `bridge_stopped`, `bridge_started`, `cleanup_completed`

---

## 3. Monitoring Data Model

### In-Memory Metrics (no persistence needed for v1)

Track these on each ClaudeBridge instance:

| Metric | Type | Description |
|--------|------|-------------|
| `startedAt` | timestamp | When bridge was last started |
| `restartCount` | counter | Times this bridge restarted since gateway boot |
| `lastRestartReason` | string | "watchdog_stuck", "socket_closed", "subprocess_exit", "manual" |
| `lastActivityAt` | timestamp | Last SDK/stdout/stderr activity |
| `lastUserMessageAt` | timestamp | Last user message sent to bridge |
| `messagesReceived` | counter | Total messages received from bridge |
| `messagesSent` | counter | Total messages sent to bridge |
| `errors` | counter | Total errors from bridge |

Track these on Gateway:

| Metric | Type | Description |
|--------|------|-------------|
| `gatewayStartedAt` | timestamp | When gateway process started |
| `requestCount` | counter | Total HTTP requests handled |
| `errorsLastHour` | rolling counter | Errors in the last 60 minutes |

### SSE Events (new)

Add these events to the existing SSE system:

| Event | Trigger | Payload |
|-------|---------|---------|
| `health_changed` | Overall status changes (healthy/degraded/unhealthy) | `{ status, previousStatus, reason }` |
| `bridge_status_changed` | Bridge state transition | `{ agentId, status, previousStatus }` |
| `bridge_stopped` | Bridge manually stopped | `{ agentId, reason }` |
| `bridge_started` | Bridge manually started | `{ agentId }` |

### Future (v2): Persistent Metrics

For v2, consider a `data/{projectId}-metrics.db` SQLite database with a time-series table for historical trending. Out of scope for v1.

---

## 4. Cross-Team Surfaces

### 4a. Backend (backend-lead)

Owner of all API endpoints and data model.

**Deliverables**:
- `GET /api/health` endpoint (global)
- `GET /api/health/bridges` endpoint (project-scoped)
- `POST /api/health/bridges/:agentId/restart` endpoint
- `POST /api/health/bridges/:agentId/stop` endpoint
- `POST /api/health/bridges/:agentId/start` endpoint
- `POST /api/health/cleanup` endpoint
- Add metrics tracking to ClaudeBridge and Gateway
- New SSE events: `health_changed`, `bridge_status_changed`, `bridge_stopped`, `bridge_started`

### 4b. Web UI (frontend-lead)

New **Health** tab in the SPA (alongside Team, Board, Threads, etc).

**Layout**:
```
+----------------------------------------------------+
| HEALTH                                    [Refresh] |
+----------------------------------------------------+
| System Status: HEALTHY          Uptime: 1h 4m 2s   |
| Memory: 128MB RSS / 64MB Heap   Requests: 4,521    |
+----------------------------------------------------+
| BRIDGES                                             |
| +------------------------------------------------+ |
| | captain     READY   uptime 1h 3m  restarts: 2  | |
| |   last activity: 3s ago                         | |
| |   [Restart] [Stop]                              | |
| +------------------------------------------------+ |
| | backend-lead READY  uptime 20m    restarts: 0   | |
| |   last activity: 30s ago                        | |
| |   [Restart] [Stop]                              | |
| +------------------------------------------------+ |
| | ios-lead  DISCONNECTED  restarts: 5             | |
| |   last activity: 5m ago                         | |
| |   [Start] [Restart]                             | |
| +------------------------------------------------+ |
+----------------------------------------------------+
| STORES                                              |
| tasks.db: OK (256KB)  agents.db: OK (48KB)         |
| threads.db: OK (512KB)                              |
+----------------------------------------------------+
| SSE: 3 clients connected  Buffer: 142/200          |
+----------------------------------------------------+
| [Clean Up Stale Processes]  [Restart Gateway]       |
+----------------------------------------------------+
```

**Behavior**:
- Auto-refresh via polling `GET /api/health` every 10 seconds
- SSE events (`health_changed`, `bridge_status_changed`) update UI incrementally
- Restart/Stop/Start buttons call the corresponding POST endpoints
- "Restart Gateway" button calls `POST /api/restart` with a confirmation dialog
- "Clean Up Stale Processes" calls `POST /api/health/cleanup`
- Color-code bridge status: green=ready, yellow=connecting/restarting, red=disconnected/stuck
- Show relative timestamps ("3s ago", "5m ago") for last activity

### 4c. iOS App (ios-lead)

New **Health** tab in the iOS app tab bar (or a section in an existing view).

**Views**:
- **HealthView**: Overall system status card (status badge, uptime, memory)
- **BridgeListView**: List of bridges with status indicators, tap for detail
- **BridgeDetailView**: Full bridge info with restart/stop/start action buttons
- **StoreStatusView**: DB health cards

**Behavior**:
- Poll `GET /api/health` on appear and every 15 seconds
- Wire SSE events for real-time status badge updates
- Confirmation alerts before restart/stop actions
- Pull-to-refresh support

### 4d. DevTools / CLI (devtools-lead)

New CLI commands:

```bash
# View health summary
cc health
# Output: System: HEALTHY | Uptime: 1h 4m | Memory: 128MB
#         captain: READY (1h 3m, 2 restarts)
#         backend-lead: READY (20m, 0 restarts)
#         ios-lead: DISCONNECTED (5 restarts)
#         Stores: all OK | SSE: 3 clients

# Detailed health (JSON)
cc health --json

# Bridge-specific commands
cc bridge list                    # List all bridges with status
cc bridge restart --agent captain # Restart specific bridge
cc bridge stop --agent captain    # Stop specific bridge
cc bridge start --agent captain   # Start specific bridge

# Cleanup
cc health cleanup                 # Kill stale processes
```

**Implementation**: Each command maps directly to the corresponding API endpoint.

---

## 5. Auto-Recovery and Alerting

### Auto-Recovery (Backend)

The existing watchdog and auto-restart in ClaudeBridge already handles most recovery. Enhancements:

1. **Idle bridge detection**: If a bridge has been idle (no activity) for 10 minutes AND is not `ready`, auto-restart it. Current watchdog only triggers if a user message was sent.

2. **Restart escalation**: If a bridge restarts more than 5 times in 10 minutes, stop auto-restarting and alert. Current backoff can loop indefinitely.

3. **DB health check on startup**: Verify all SQLite stores are readable. If a store fails, log an error and mark the project as degraded.

### Alerting (Backend)

Post messages to the project's "main" thread on health events:

| Event | Alert Message |
|-------|---------------|
| Bridge stuck (watchdog) | `[health] Bridge {agentId} detected as stuck, auto-restarting...` |
| Bridge restart failed 5+ times | `[health] Bridge {agentId} failing to restart — manual intervention needed` |
| Bridge recovered | `[health] Bridge {agentId} recovered and ready` |
| Overall status changed to degraded/unhealthy | `[health] System status changed to {status}: {reason}` |
| Stale processes cleaned | `[health] Cleaned up {n} stale processes on startup` |

### SSE Alerts

All health alerts are also broadcast as SSE events so web UI and iOS can show toast/banner notifications:
```json
{ "type": "health_alert", "data": { "severity": "warning|critical|info", "message": "...", "agentId": "captain" } }
```

---

## Task Breakdown

Suggested implementation order and task assignments:

| # | Task | Owner | Dependencies |
|---|------|-------|--------------|
| 1 | Backend: health endpoints + bridge metrics | backend-lead | none |
| 2 | Backend: recovery action endpoints | backend-lead | #1 |
| 3 | Backend: auto-recovery enhancements + alerting | backend-lead | #1 |
| 4 | DevTools: cc health + cc bridge CLI commands | devtools-lead | #1, #2 |
| 5 | Frontend: Health tab in web UI | frontend-lead | #1, #2 |
| 6 | iOS: Health view in iOS app | ios-lead | #1, #2 |

Tasks #4, #5, #6 can run in parallel once #1 and #2 are merged.
