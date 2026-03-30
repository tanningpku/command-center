import Foundation

/// Server-Sent Events for a Command Center project.
/// Ported from companion's actor-based SSEService pattern.
struct SSEEvent {
    let ts: String
    let type: String
    let payload: [String: Any]
}

actor SSEService {
    private var task: Task<Void, Never>?
    private var continuation: AsyncStream<SSEEvent>.Continuation?

    func events(baseURL: URL, projectId: String) -> AsyncStream<SSEEvent> {
        // Stop any existing connection
        stop()

        return AsyncStream { continuation in
            self.continuation = continuation
            self.task = Task { [weak self] in
                guard let self else { return }
                await self.connectLoop(baseURL: baseURL, projectId: projectId, continuation: continuation)
            }
            continuation.onTermination = { @Sendable _ in
                Task { [weak self] in
                    await self?.stop()
                }
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        continuation?.finish()
        continuation = nil
    }

    private func connectLoop(baseURL: URL, projectId: String, continuation: AsyncStream<SSEEvent>.Continuation) async {
        var backoff: UInt64 = 1_000_000_000 // 1 second

        while !Task.isCancelled {
            do {
                try await connect(baseURL: baseURL, projectId: projectId, continuation: continuation)
                backoff = 1_000_000_000 // reset on successful connection
            } catch {
                if Task.isCancelled { break }
                try? await Task.sleep(nanoseconds: backoff)
                backoff = min(backoff * 2, 30_000_000_000) // max 30s
            }
        }
    }

    private func connect(baseURL: URL, projectId: String, continuation: AsyncStream<SSEEvent>.Continuation) async throws {
        guard var components = URLComponents(url: baseURL.appendingPathComponent("api/events"), resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL
        }
        components.queryItems = [URLQueryItem(name: "projectId", value: projectId)]
        guard let url = components.url else { throw APIError.invalidURL }

        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = .infinity

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = .infinity
        config.timeoutIntervalForResource = .infinity
        let session = URLSession(configuration: config)

        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.badResponse(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0)
        }

        var eventLines: [String] = []

        for try await line in bytes.lines {
            if Task.isCancelled { break }

            if line.isEmpty {
                if !eventLines.isEmpty {
                    if let event = parseSSEEvent(eventLines.joined(separator: "\n")) {
                        continuation.yield(event)
                    }
                    eventLines.removeAll()
                }
            } else {
                eventLines.append(line)
            }
        }
    }

    private func parseSSEEvent(_ text: String) -> SSEEvent? {
        var dataLines: [String] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("data: ") {
                dataLines.append(String(line.dropFirst(6)))
            }
        }

        guard !dataLines.isEmpty else { return nil }
        let jsonString = dataLines.joined(separator: "\n")

        guard let data = jsonString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }

        return SSEEvent(
            ts: json["ts"] as? String ?? "",
            type: json["type"] as? String ?? "",
            payload: json["payload"] as? [String: Any] ?? json
        )
    }
}
