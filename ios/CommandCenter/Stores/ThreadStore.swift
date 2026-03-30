import SwiftUI

/// Manages thread list, active thread messages, SSE event handling, and optimistic sends.
@MainActor
@Observable
class ThreadStore {
    var threads: [CCThread] = []
    var messages: [CCMessage] = []
    var activeThreadId: String?
    var isLoadingThreads = false
    var isLoadingMessages = false
    var isConnected = false
    var error: String?

    private let api: APIService
    private let sseService: SSEService
    private var sseTask: Task<Void, Never>?
    private var seenContentHashes: Set<String> = []

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
        } catch {
            self.error = error.localizedDescription
        }
        isLoadingThreads = false
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
    func sendMessage(text: String, threadId: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Optimistic append
        let local = CCMessage(
            threadId: threadId, role: "user", content: trimmed,
            sender: "user", source: "ios"
        )
        messages.append(local)
        seenContentHashes.insert(local.contentHash)

        // Send to gateway
        do {
            _ = try await api.sendMessage(threadId: threadId, text: trimmed)
        } catch {
            self.error = "Send failed: \(error.localizedDescription)"
        }
    }

    // MARK: - SSE

    func connectSSE(baseURL: URL, projectId: String) {
        disconnectSSE()
        sseTask = Task {
            let stream = await sseService.events(baseURL: baseURL, projectId: projectId)
            await MainActor.run { isConnected = true }
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

        case "task_created", "task_updated", "task_completed":
            // Board/metrics stores would handle these in Phase 2
            break

        case "agent_created", "agent_updated", "agent_archived":
            // Team store would handle these in Phase 2
            break

        case "assistant_text":
            // Could show typing indicator — future enhancement
            break

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

    /// Decode a Codable type from an SSE payload dictionary.
    private func decodeFromPayload<T: Decodable>(_ type: T.Type, _ payload: [String: Any]) -> T? {
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}
