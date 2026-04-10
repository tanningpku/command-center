import SwiftUI

/// Last message preview for a thread row.
struct ThreadPreview {
    let sender: String
    let content: String
    let time: String
}

/// A snapshot of Captain's (or any agent's) latest streamed thought.
struct CaptainThought: Equatable {
    let agentName: String
    let text: String
}

/// Manages thread list, active thread messages, SSE event handling, and optimistic sends.
@MainActor
@Observable
class ThreadStore {
    var threads: [CCThread] = []
    var messages: [CCMessage] = []
    var threadPreviews: [String: ThreadPreview] = [:]
    var activeThreadId: String?
    var isLoadingThreads = false
    var isLoadingMessages = false
    var isConnected = false
    var isStale = false
    var error: String?

    /// Latest streamed agent thought for the captain bar.
    var captainThought: CaptainThought?

    /// Callbacks for routing SSE events to other stores
    var onAgentEvent: ((String, [String: Any]) -> Void)?
    var onTaskEvent: ((String, [String: Any]) -> Void)?
    var onHealthEvent: ((String, [String: Any]) -> Void)?
    var onProjectEvent: ((String, [String: Any]) -> Void)?

    /// Called when SSE reconnects so views can reload data
    var onReconnect: (() -> Void)?

    private let api: APIService
    private let sseService: SSEService
    private var sseTask: Task<Void, Never>?
    private var seenContentHashes: Set<String> = []
    private var wasConnected = false

    private static let cacheKey = "threads"

    init(api: APIService, sseService: SSEService) {
        self.api = api
        self.sseService = sseService
    }

    // MARK: - Thread list

    func loadThreads() async {
        isLoadingThreads = true
        do {
            let response = try await api.fetchThreads()
            threads = response.threads.sorted { $0.updatedAt > $1.updatedAt }
            isStale = false
            // Cache for offline
            if let projectId = UserDefaults.standard.string(forKey: AppConfig.selectedProjectKey) {
                CacheManager.save(threads, key: Self.cacheKey, projectId: projectId)
            }
        } catch {
            // Fall back to cache
            if threads.isEmpty, let projectId = UserDefaults.standard.string(forKey: AppConfig.selectedProjectKey),
               let cached = CacheManager.load([CCThread].self, key: Self.cacheKey, projectId: projectId) {
                threads = cached
                isStale = true
            }
            self.error = error.localizedDescription
        }
        isLoadingThreads = false
    }

    /// Load last-message preview for each thread (fire-and-forget, non-blocking).
    func loadPreviews() async {
        await withTaskGroup(of: (String, ThreadPreview?).self) { group in
            for thread in threads {
                group.addTask { [api] in
                    do {
                        let response = try await api.fetchMessages(threadId: thread.id, limit: 1)
                        if let msg = response.messages.first {
                            return (thread.id, ThreadPreview(sender: msg.displaySender, content: msg.content, time: msg.displayTime))
                        }
                    } catch {}
                    return (thread.id, nil)
                }
            }
            for await (threadId, preview) in group {
                if let preview {
                    threadPreviews[threadId] = preview
                }
            }
        }
    }

    func createThread(title: String, participants: [[String: String]] = []) async throws -> CCThread {
        let thread = try await api.createThread(title: title, participants: participants)
        await loadThreads()
        return thread
    }

    func deleteThread(id: String) async throws {
        try await api.deleteThread(id: id)
        threads.removeAll { $0.id == id }
        threadPreviews.removeValue(forKey: id)
    }

    // MARK: - Messages

    func loadMessages(threadId: String) async {
        activeThreadId = threadId
        isLoadingMessages = true
        seenContentHashes.removeAll()
        do {
            let response = try await api.fetchMessages(threadId: threadId)
            messages = response.messages
            // Populate dedup set
            for msg in messages {
                seenContentHashes.insert(msg.contentHash)
            }
        } catch {
            self.error = error.localizedDescription
        }
        isLoadingMessages = false
    }

    /// Send a message with optimistic UI update.
    func sendMessage(text: String, threadId: String, source: String = "ios") async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Optimistic append
        let local = CCMessage(
            threadId: threadId, role: "user", content: trimmed,
            sender: "user", source: source
        )
        messages.append(local)
        seenContentHashes.insert(local.contentHash)

        // Send to gateway
        do {
            _ = try await api.sendMessage(threadId: threadId, text: trimmed, source: source)
        } catch {
            self.error = "Send failed: \(error.localizedDescription)"
        }
    }

    // MARK: - SSE

    func connectSSE(baseURL: URL, projectId: String) {
        disconnectSSE()
        sseTask = Task {
            let stream = await sseService.events(baseURL: baseURL, projectId: projectId)
            await MainActor.run {
                let reconnecting = wasConnected
                isConnected = true
                isStale = false
                wasConnected = true
                if reconnecting {
                    onReconnect?()
                }
            }
            for await event in stream {
                await handleSSEEvent(event)
            }
            await MainActor.run { isConnected = false }
        }
    }

    func disconnectSSE() {
        sseTask?.cancel()
        sseTask = nil
        Task { await sseService.stop() }
        isConnected = false
    }

    private func handleSSEEvent(_ event: SSEEvent) async {
        switch event.type {
        case "thread_message":
            await handleThreadMessage(event.payload)

        case "thread_created":
            // Decode and insert thread
            if let thread = decodeFromPayload(CCThread.self, event.payload) {
                if !threads.contains(where: { $0.id == thread.id }) {
                    threads.insert(thread, at: 0)
                }
            }

        case "thread_updated":
            if let thread = decodeFromPayload(CCThread.self, event.payload) {
                if let idx = threads.firstIndex(where: { $0.id == thread.id }) {
                    threads[idx] = thread
                }
            }

        case "thread_deleted":
            if let id = event.payload["id"] as? String {
                threads.removeAll { $0.id == id }
                threadPreviews.removeValue(forKey: id)
            }

        case "task_created", "task_updated", "task_completed":
            onTaskEvent?(event.type, event.payload)

        case "agent_created", "agent_updated", "agent_archived":
            onAgentEvent?(event.type, event.payload)

        case "health_changed", "bridge_status_changed", "bridge_stopped", "bridge_started",
             "bridge_restarted", "health_alert":
            onHealthEvent?(event.type, event.payload)

        case "assistant_text", "outbound_message":
            handleAgentThought(event.payload)

        case "captain_message":
            if let message = event.payload["message"] as? String {
                captainThought = CaptainThought(agentName: "Captain", text: message)
            }

        case "dashboard_update":
            NotificationCenter.default.post(name: .dashboardUpdated, object: nil)

        case "project_created", "project_deleted", "project_updated":
            onProjectEvent?(event.type, event.payload)

        case "claude_ready", "claude_result":
            break

        default:
            break
        }
    }

    private func handleThreadMessage(_ payload: [String: Any]) {
        guard let threadId = payload["threadId"] as? String else { return }

        // Decode message from SSE payload
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let msg = try? JSONDecoder().decode(CCMessage.self, from: data) else { return }

        // Only append to active thread
        guard threadId == activeThreadId else {
            // Refresh thread list for updated timestamps
            Task { await loadThreads() }
            return
        }

        // Dedup: skip if we already have this content (optimistic send or duplicate)
        if msg.serverId > 0, messages.contains(where: { $0.serverId == msg.serverId }) {
            return
        }
        if seenContentHashes.contains(msg.contentHash) {
            // Replace local optimistic message with server version
            if let idx = messages.firstIndex(where: { $0.localId.hasPrefix("l_") && $0.contentHash == msg.contentHash }) {
                messages[idx] = msg
            }
            return
        }

        messages.append(msg)
        seenContentHashes.insert(msg.contentHash)
    }

    private func handleAgentThought(_ payload: [String: Any]) {
        let text = (payload["text"] as? String)
            ?? (payload["content"] as? String)
            ?? ""
        guard !text.isEmpty else { return }

        let agentName = (payload["agentId"] as? String) ?? "Captain"
        let preview = text.count > 120 ? String(text.prefix(120)) + "..." : text
        captainThought = CaptainThought(agentName: agentName, text: preview)
    }

    /// Decode a Codable type from an SSE payload dictionary.
    private func decodeFromPayload<T: Decodable>(_ type: T.Type, _ payload: [String: Any]) -> T? {
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}
