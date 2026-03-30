# Command Center iOS App — Technical Specification

**Version:** 1.0 Draft
**Date:** 2026-03-29
**Author:** iOS Lead
**Status:** For Review

---

## 1. App Architecture

### Platform & Requirements

- **iOS 17+**, SwiftUI-first (no UIKit wrappers except where necessary)
- **Zero third-party dependencies** (matches companion app pattern)
- **MVVM architecture** with `@Observable` stores, async/await services, and declarative views
- **Swift concurrency**: actor-based SSE service, structured concurrency for network calls

### Project Structure

```
CommandCenter/
├── CommandCenterApp.swift          # Entry point, environment setup, deep links
├── Config/
│   └── AppConfig.swift             # Server URL, project defaults, constants
├── Models/
│   ├── Project.swift               # ProjectConfig (id, name, port, repo, status)
│   ├── Task.swift                  # Task + TaskState enum + TaskEvent
│   ├── Agent.swift                 # Agent + AgentStatus enum
│   ├── Thread.swift                # CCThread + Participant + ParticipantRole
│   ├── Message.swift               # CCMessage (dual-format Codable)
│   └── KBFile.swift                # KB file listing, section info, search result
├── Services/
│   ├── APIService.swift            # REST client for all gateway endpoints
│   ├── SSEService.swift            # Actor-based Server-Sent Events streaming
│   └── ImageCache.swift            # Async image loading + memory cache (ported)
├── Stores/
│   ├── ProjectStore.swift          # Project registry, selection, persistence
│   ├── TeamStore.swift             # Agent list, agent detail + KB browsing
│   ├── BoardStore.swift            # Task list by state (kanban columns)
│   ├── ThreadStore.swift           # Thread list, active thread, messages
│   ├── OpsStore.swift              # CI builds, open PRs
│   ├── MetricsStore.swift          # Task breakdown stats
│   └── NavigationRouter.swift      # Tab selection, deep links, navigation state
├── Views/
│   ├── MainTabView.swift           # 5-tab navigation (Team, Board, Threads, Ops, Metrics)
│   ├── ProjectSelectorView.swift   # Project picker sheet/menu
│   ├── Team/
│   │   ├── TeamGridView.swift      # Agent cards grid
│   │   └── AgentDetailView.swift   # Agent detail: role, system prompt, KB files
│   ├── Board/
│   │   ├── BoardView.swift         # Kanban columns (horizontal scroll)
│   │   └── TaskCardView.swift      # Task card with priority, assignee, state
│   ├── Threads/
│   │   ├── ThreadListView.swift    # Thread sidebar with NavigationStack
│   │   ├── ChatView.swift          # Thread message display + input
│   │   ├── MessageBubbleView.swift # Message bubble (role-colored)
│   │   └── MarkdownTextView.swift  # Markdown renderer (ported from companion)
│   ├── Ops/
│   │   ├── OpsView.swift           # CI runs + PRs grid
│   │   ├── BuildRowView.swift      # CI run status row
│   │   └── PRRowView.swift         # Pull request row
│   ├── Metrics/
│   │   └── MetricsView.swift       # Task breakdown charts/stats
│   └── Common/
│       ├── StatusBadge.swift        # Colored status indicator
│       ├── PriorityBadge.swift      # Priority label (critical/high/normal/low)
│       └── ConnectionDot.swift      # SSE connection status indicator
└── Assets.xcassets/
```

### Dependency Injection

All stores and services are injected via SwiftUI environment:

```swift
@main
struct CommandCenterApp: App {
    @State private var config = AppConfig()
    @State private var apiService: APIService
    @State private var sseService: SSEService
    @State private var projectStore: ProjectStore
    @State private var router = NavigationRouter()

    var body: some Scene {
        WindowGroup {
            MainTabView()
                .environment(config)
                .environment(projectStore)
                .environment(router)
        }
    }
}
```

---

## 2. Screens & Navigation

### Tab Structure

Adapt the companion's 5-tab TabView to Command Center context:

| Tab | Icon | View | Purpose |
|-----|------|------|---------|
| Team | `person.3` | TeamGridView | Agent cards, drill into detail |
| Board | `rectangle.split.3x1` | BoardView | Kanban task columns |
| Threads | `bubble.left.and.bubble.right` | ThreadListView | Thread list + chat |
| Ops | `gearshape.2` | OpsView | CI builds + open PRs |
| Metrics | `chart.bar` | MetricsView | Task state breakdown |

### Navigation Pattern

```
MainTabView (TabView, 5 tabs)
├── Team Tab
│   └── NavigationStack
│       ├── TeamGridView (grid of agent cards)
│       └── AgentDetailView (push detail: role, identity.md, KB files)
│           └── KBFileView (push: KB file content)
├── Board Tab
│   └── BoardView (horizontal scroll of kanban columns)
│       └── TaskDetailSheet (sheet: full task info, thread link, PR link)
├── Threads Tab
│   └── NavigationSplitView (sidebar + detail)
│       ├── ThreadListView (sidebar: thread list)
│       └── ChatView (detail: messages + input)
├── Ops Tab
│   └── OpsView (VStack of builds + PRs sections)
└── Metrics Tab
    └── MetricsView (stat cards + state breakdown)
```

### Project Selector

Multi-project support via a compact selector in the navigation bar (mirrors web UI header dropdown):

```swift
struct ProjectSelectorView: View {
    @Environment(ProjectStore.self) var projectStore

    var body: some View {
        Menu {
            ForEach(projectStore.projects) { project in
                Button(project.name) {
                    projectStore.select(project.id)
                }
            }
        } label: {
            HStack(spacing: 4) {
                Circle()
                    .fill(projectStore.selected?.status == "active" ? .green : .gray)
                    .frame(width: 8, height: 8)
                Text(projectStore.selected?.name ?? "Select Project")
                    .font(.headline)
                Image(systemName: "chevron.down")
                    .font(.caption)
            }
        }
    }
}
```

Selecting a project:
1. Updates `X-Project-Id` header for all subsequent API calls
2. Tears down and reconnects SSE for new project
3. Refreshes all stores (team, board, threads, ops, metrics)
4. Persists selection to `@AppStorage` for next launch

---

## 3. Chat Features

Port companion chat patterns adapted for Command Center threads:

### Message Model

Dual-format Codable (REST snake_case + SSE camelCase), matching companion's proven approach:

```swift
struct CCMessage: Identifiable, Codable, Hashable {
    let id: Int                    // Server-assigned
    let threadId: String
    let role: String               // "user", "assistant"
    let kind: String               // "message", "system", "thought"
    let content: String
    let sender: String?            // Agent ID or user
    let source: String?            // "cli", "webui", "ios", "gateway"
    let metadata: JSONValue?
    let createdAt: String

    // Dual CodingKeys for REST (snake_case) and SSE (camelCase)
    enum CodingKeys: String, CodingKey { ... }
    enum AltCodingKeys: String, CodingKey { ... }
}
```

### Optimistic UI

Port companion's optimistic send pattern:
1. User types message and taps Send
2. Immediately append local message with `localId = "l_\(UUID())"`, `role = "user"`
3. POST to `/api/message` with `thread_id`, `text`, `sender: "user"`, `source: "ios"`
4. When SSE delivers the persisted message, deduplicate by content hash (`role:normalizedContent`)
5. Replace local message with server-confirmed version

### Deduplication

Match companion's content-hash dedup strategy:
```swift
private func contentHash(_ message: CCMessage) -> String {
    "\(message.role):\(message.content.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())"
}
```

### Markdown Rendering

Port companion's `MarkdownTextView` (323 lines) which supports:
- Inline: **bold**, *italic*, `code`
- Block: code blocks with language labels, blockquotes
- Lists: bullet and ordered
- Headings: H1-H3
- Tables: markdown pipe tables with Grid layout
- Data detection: URLs, phone numbers auto-linked

### Chat Input

Simple text input (no image/file/voice for Phase 1):
```swift
struct ChatInputBar: View {
    @State private var text = ""
    var onSend: (String) -> Void

    var body: some View {
        HStack(spacing: 8) {
            TextField("Type a message...", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .padding(10)
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 20))
            Button { onSend(text); text = "" } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
            }
            .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}
```

### Message Bubble Styling

| Sender | Background | Text Color | Alignment |
|--------|-----------|------------|-----------|
| Current user | `.blue` | `.white` | Right |
| System/gateway | `.clear` + italic | `.secondary` | Center |
| Agent (assistant) | `Color(.systemGray5)` | `.primary` | Left |

Display sender name badge for agent messages showing agent name.

### Auto-scroll

- Scroll to bottom on new messages (with animation)
- Maintain scroll position when loading older messages
- "Jump to bottom" floating button when scrolled up

---

## 4. API Integration

### APIService Design

Single service class managing all gateway communication:

```swift
actor APIService {
    private let session = URLSession.shared
    private var baseURL: URL
    private var projectId: String?

    func setProject(_ id: String) { self.projectId = id }

    private func request(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let projectId { req.setValue(projectId, forHTTPHeaderField: "X-Project-Id") }
        req.httpBody = body
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, 200...299 ~= http.statusCode else {
            throw APIError.badResponse(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        return data
    }
}
```

### Endpoint Map

| Feature | Method | Path | Notes |
|---------|--------|------|-------|
| **Registry** | GET | `/api/registry` | No project header needed |
| **Agents** | GET | `/api/agents` | List team |
| **Agent detail** | GET | `/api/agents/{id}` | Single agent |
| **Tasks** | GET | `/api/tasks` | `?state=X&assignee=Y&limit=N` |
| **Task update** | PATCH | `/api/tasks/{id}` | State transitions |
| **Threads** | GET | `/api/threads` | List with participants |
| **Thread messages** | GET | `/api/threads/{id}/messages` | `?limit=N&before=ISO` |
| **Send message** | POST | `/api/message` | `{ thread_id, text, sender, source }` |
| **Thread create** | POST | `/api/threads` | `{ title, participants[] }` |
| **KB list** | GET | `/api/kb/list` | `?agent={agentId}` |
| **KB read** | GET | `/api/kb/read` | `?file=X&section=Y&agent=Z` |
| **KB search** | GET | `/api/kb/search` | `?q=X&file=Y&agent=Z` |
| **Ops** | GET | `/api/ops` | CI builds + open PRs |
| **Board** | GET | `/api/board` | GitHub project board |
| **Status** | GET | `/api/status` | Gateway health |

### Error Handling

```swift
enum APIError: Error, LocalizedError {
    case invalidURL
    case badResponse(statusCode: Int)
    case unauthorized
    case decodingError(Error)
    case noProject

    var errorDescription: String? { ... }
}
```

Retry strategy: exponential backoff (1s, 2s, 4s) for 5xx errors, no retry for 4xx.

---

## 5. Real-Time Updates via SSE

### SSEService (Actor-Based)

Port companion's actor-based SSEService, adapted for Command Center's project-scoped events:

```swift
actor SSEService {
    private var task: Task<Void, Never>?
    private var continuation: AsyncStream<SSEEvent>.Continuation?

    struct SSEEvent {
        let ts: String
        let type: String              // "thread_message", "task_updated", etc.
        let payload: [String: Any]
    }

    func events(baseURL: URL, projectId: String) -> AsyncStream<SSEEvent> {
        // Connect to /api/events?projectId={projectId}
        // Parse SSE format line-by-line
        // Exponential backoff on disconnect (1s → 30s)
        // Yield SSEEvent to stream
    }

    func stop() { ... }
}
```

### Event Routing

Each store subscribes to relevant SSE events:

| Event Type | Store | Action |
|------------|-------|--------|
| `thread_created` | ThreadStore | Insert thread, refresh list |
| `thread_updated` | ThreadStore | Update thread metadata |
| `thread_message` | ThreadStore | Append message to active thread (with dedup) |
| `agent_created`, `agent_updated`, `agent_archived` | TeamStore | Refresh agent list |
| `task_created`, `task_updated`, `task_completed` | BoardStore | Refresh kanban columns |
| `assistant_text` | ThreadStore | Show typing/streaming indicator |
| `captain_message` | ProjectStore | Update captain status bar |

### Connection Lifecycle

```
App Launch → ProjectStore.select(projectId)
  → SSEService.stop() (previous connection)
  → SSEService.events(baseURL, projectId) (new connection)
  → AsyncStream yields events
  → Stores filter and process relevant events
  → UI reactively updates via @Observable
```

### Reconnection

- Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
- Reset backoff on successful connection
- Show connection status dot in UI (green = connected, yellow = reconnecting, red = disconnected)

---

## 6. Swift Data Models

### Project

```swift
struct Project: Identifiable, Codable, Hashable {
    let id: String
    let name: String
    let port: Int
    let repo: String
    let status: String              // "active", "inactive"
}
```

### Task

```swift
struct CCTask: Identifiable, Codable, Hashable {
    let id: String                  // "T-1", "T-2", etc.
    let title: String
    let description: String
    let githubIssue: Int?
    let githubPR: Int?
    let state: TaskState
    let assignee: String?
    let createdBy: String
    let priority: TaskPriority
    let labels: [String]
    let threadId: String?
    let latestUpdate: String?
    let createdAt: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, title, description, state, assignee, priority, labels
        case githubIssue = "github_issue"      // REST snake_case
        case githubPR = "github_pr"
        case createdBy = "created_by"
        case threadId = "thread_id"
        case latestUpdate = "latest_update"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

enum TaskState: String, Codable, CaseIterable {
    case created, assigned, in_progress, in_review, qa, blocked, done, cancelled

    var displayName: String { ... }
    var color: Color { ... }
    var isTerminal: Bool { self == .done || self == .cancelled }
}

enum TaskPriority: String, Codable, Comparable {
    case critical, high, normal, low

    var color: Color {
        switch self {
        case .critical: .red
        case .high: .orange
        case .normal: .blue
        case .low: .gray
        }
    }
}
```

### Agent

```swift
struct CCAgent: Identifiable, Codable, Hashable {
    let id: String
    let name: String
    let role: String
    let status: String              // "active", "running", "stopped", "archived"
    let createdBy: String
    let createdAt: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, name, role, status
        case createdBy = "created_by"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}
```

### Thread

```swift
struct CCThread: Identifiable, Codable, Hashable {
    let id: String
    let title: String
    let status: String              // "active", "archived"
    let summary: String?
    let createdAt: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, title, status, summary
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    var relativeTime: String { ... }
}

struct ThreadParticipant: Codable, Hashable {
    let threadId: String
    let participantType: String     // "user", "assistant"
    let participantId: String
    let role: String                // "participant", "lead", "assignee", "subscriber"
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case role
        case threadId = "thread_id"
        case participantType = "participant_type"
        case participantId = "participant_id"
        case createdAt = "created_at"
    }
}
```

### Message

```swift
struct CCMessage: Identifiable, Codable, Hashable {
    let id: Int
    let threadId: String
    let role: String                // "user", "assistant"
    let kind: String                // "message", "system", "thought"
    let content: String
    let sender: String?
    let source: String?             // "cli", "webui", "ios", "gateway"
    let metadata: JSONValue?
    let createdAt: String

    // REST format (snake_case)
    enum CodingKeys: String, CodingKey {
        case id, role, kind, content, sender, source, metadata
        case threadId = "thread_id"
        case createdAt = "created_at"
    }

    // SSE format (camelCase)
    enum AltCodingKeys: String, CodingKey {
        case id, role, kind, content, sender, source, metadata
        case threadId, createdAt
    }

    var isUser: Bool { role == "user" }
    var isSystem: Bool { kind == "system" }
    var isAssistant: Bool { role == "assistant" }
    var displaySender: String { sender ?? (isUser ? "You" : "Agent") }
    var displayTime: String { ... }
}
```

### JSONValue (Generic Container)

```swift
enum JSONValue: Codable, Hashable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null
}
```

---

## 7. Multi-Project Support

### Project Lifecycle

1. **App launch**: Fetch `/api/registry` to populate project list
2. **Project selection**: User picks from project menu (persisted to `@AppStorage`)
3. **API scoping**: All subsequent requests include `X-Project-Id: {selectedProjectId}` header
4. **SSE reconnect**: Tear down and reconnect SSE with `?projectId={selectedProjectId}`
5. **Store refresh**: All stores reload data for the new project context

### ProjectStore

```swift
@Observable
class ProjectStore {
    var projects: [Project] = []
    var selectedId: String? { didSet { UserDefaults.standard.set(selectedId, forKey: "selectedProjectId") } }

    var selected: Project? { projects.first { $0.id == selectedId } }

    func load() async throws {
        let data = try await api.fetchRegistry()
        projects = data.projects
        // Auto-select persisted project, or first available
        if selectedId == nil || !projects.contains(where: { $0.id == selectedId }) {
            selectedId = projects.first?.id
        }
    }

    func select(_ id: String) {
        selectedId = id
        api.setProject(id)
        // Trigger SSE reconnect + store refresh via notification
        NotificationCenter.default.post(name: .projectChanged, object: nil)
    }
}
```

### UI Placement

Project selector appears as a compact menu in the navigation bar of the currently active tab, consistent across all tabs. Shows project name + green/gray status dot.

---

## 8. Implementation Phase Plan

### Phase 1: Core Chat & Threads (MVP)

**Goal:** Read and participate in Command Center threads from iOS.

**Deliverables:**
- [ ] Xcode project setup (CommandCenter target, iOS 17+, SwiftUI)
- [ ] `AppConfig` with server URL, project selection persistence
- [ ] `APIService` — registry, threads, messages, send message
- [ ] `SSEService` — actor-based, project-scoped, exponential backoff
- [ ] `ProjectStore` — registry fetch, project selection, persistence
- [ ] `ThreadStore` — thread list, message loading, optimistic send, SSE dedup
- [ ] `NavigationRouter` — tab selection, thread drill-in
- [ ] `MainTabView` — 5 tabs (only Threads active, others show placeholder)
- [ ] `ProjectSelectorView` — compact menu in nav bar
- [ ] `ThreadListView` — thread list with NavigationStack
- [ ] `ChatView` — message display, input bar, auto-scroll
- [ ] `MessageBubbleView` — role-colored bubbles with sender badges
- [ ] `MarkdownTextView` — ported from companion (code blocks, tables, lists)
- [ ] `ConnectionDot` — SSE connection status indicator
- [ ] Swift data models: `Project`, `CCThread`, `CCMessage`, `ThreadParticipant`

**Estimated scope:** ~2,500 lines of Swift across ~20 files.

### Phase 2: Board & Team

**Goal:** Full team visibility and task management.

**Deliverables:**
- [ ] `TeamStore` — agent list, KB browsing
- [ ] `BoardStore` — task list by state, kanban grouping
- [ ] `TeamGridView` — agent cards in grid layout
- [ ] `AgentDetailView` — role, system prompt (identity.md), KB file list + viewer
- [ ] `BoardView` — horizontal-scroll kanban columns
- [ ] `TaskCardView` — priority badge, assignee, state, thread link
- [ ] `TaskDetailSheet` — full task info modal
- [ ] SSE event handling for `agent_*` and `task_*` events
- [ ] Swift data models: `CCAgent`, `CCTask`, `TaskState`, `TaskPriority`
- [ ] API integration: agents, tasks, KB read/list

**Estimated scope:** ~1,500 lines of Swift across ~12 files.

### Phase 3: Ops & Metrics

**Goal:** CI/CD visibility and project health metrics.

**Deliverables:**
- [ ] `OpsStore` — CI builds, open PRs, polling refresh
- [ ] `MetricsStore` — task state breakdown, computed stats
- [ ] `OpsView` — builds list + PRs list
- [ ] `BuildRowView` — CI run with status icon, duration, branch
- [ ] `PRRowView` — PR with author, review status, merge state
- [ ] `MetricsView` — stat cards (total tasks, in-progress, blocked, done rate)
- [ ] State breakdown bar chart or ring chart (SwiftUI Charts)
- [ ] Pull-to-refresh on all tabs
- [ ] Haptic feedback on state changes (companion pattern)

**Estimated scope:** ~800 lines of Swift across ~8 files.

### Future Considerations (Post-Phase 3)

- **Offline support**: Local cache with CoreData/SwiftData, queue outbound messages
- **Push notifications**: APNS for thread messages and task assignments
- **Widget**: Lock screen widget showing active tasks count or captain status
- **Watch app**: Compact task list and thread notifications
- **Voice input**: Port companion's SpeechService for voice messages
- **Deep links**: `commandcenter://thread/{id}`, `commandcenter://task/{id}`

---

## Appendix A: Companion Patterns to Port

| Pattern | Companion Implementation | CC Adaptation |
|---------|-------------------------|---------------|
| SSE streaming | Actor `SSEService` with `AsyncStream<SSEEvent>` | Same, add `projectId` query param |
| Optimistic UI | Local `l_` prefix IDs, replaced on server confirm | Same pattern, POST to `/api/message` |
| Dedup | Content hash `role:normalizedContent` | Same |
| Dual-format decode | Two `CodingKey` enums (snake_case + camelCase) | Same, CC gateway uses snake_case REST |
| Markdown rendering | Custom `MarkdownTextView` (323 lines) | Port directly |
| Image cache | `ImageCache` actor with memory limit | Port for agent avatars if needed |
| Navigation | `NavigationStack` + deep links | Same, 5 CC tabs instead of companion tabs |
| Connection status | Green/yellow/red dot | Same |
| Tab persistence | `@AppStorage("selectedTab")` | Same |
| Haptic feedback | `UIImpactFeedbackGenerator` on key actions | Same |

## Appendix B: API Header Convention

All project-scoped API calls must include:
```
X-Project-Id: {projectId}
```

The iOS app sets this in `APIService` whenever `ProjectStore.select()` is called. Registry endpoints (`/api/registry`) do not require this header.
