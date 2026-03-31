import Foundation

enum APIError: Error, LocalizedError {
    case invalidURL
    case badResponse(statusCode: Int)
    case decodingError(Error)
    case noProject

    var errorDescription: String? {
        switch self {
        case .invalidURL: "Invalid URL"
        case .badResponse(let code): "HTTP \(code)"
        case .decodingError(let err): "Decode error: \(err.localizedDescription)"
        case .noProject: "No project selected"
        }
    }
}

/// REST client for all Command Center gateway endpoints.
/// All project-scoped calls include X-Project-Id header.
actor APIService {
    private let session = URLSession.shared
    private var baseURL: URL
    private var projectId: String?

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    func setBaseURL(_ url: URL) { self.baseURL = url }
    func setProject(_ id: String?) { self.projectId = id }

    // MARK: - Request building

    private func request(_ path: String, method: String = "GET", body: Data? = nil) -> URLRequest {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let projectId { req.setValue(projectId, forHTTPHeaderField: "X-Project-Id") }
        req.httpBody = body
        return req
    }

    private func fetch<T: Decodable>(_ path: String, query: [(String, String)] = []) async throws -> T {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.0, value: $0.1) }
        }
        var req = URLRequest(url: components.url!)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let projectId { req.setValue(projectId, forHTTPHeaderField: "X-Project-Id") }

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, 200...299 ~= http.statusCode else {
            throw APIError.badResponse(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    private func post<T: Decodable>(_ path: String, body: some Encodable) async throws -> T {
        let data = try JSONEncoder().encode(body)
        let req = request(path, method: "POST", body: data)
        let (responseData, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, 200...299 ~= http.statusCode else {
            throw APIError.badResponse(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        return try JSONDecoder().decode(T.self, from: responseData)
    }

    // MARK: - Registry

    func fetchRegistry() async throws -> RegistryResponse {
        // Registry doesn't need project header
        let saved = projectId
        projectId = nil
        defer { projectId = saved }
        return try await fetch("api/registry")
    }

    func createProject(name: String) async throws -> Project {
        struct Body: Encodable { let name: String }
        struct Response: Decodable { let project: Project }
        // Create project is global — no project header needed
        let saved = projectId
        projectId = nil
        defer { projectId = saved }
        let resp: Response = try await post("api/projects", body: Body(name: name))
        return resp.project
    }

    // MARK: - Threads

    func fetchThreads() async throws -> ThreadListResponse {
        try await fetch("api/threads")
    }

    func fetchMessages(threadId: String, limit: Int = 50, before: String? = nil) async throws -> ThreadMessagesResponse {
        var query: [(String, String)] = [("limit", String(limit))]
        if let before { query.append(("before", before)) }
        return try await fetch("api/threads/\(threadId)/messages", query: query)
    }

    func sendMessage(threadId: String, text: String, sender: String = "user", source: String = "ios") async throws -> SendMessageResponse {
        struct Body: Encodable {
            let thread_id: String
            let text: String
            let sender: String
            let source: String
        }
        return try await post("api/message", body: Body(thread_id: threadId, text: text, sender: sender, source: source))
    }

    func createThread(title: String, participants: [[String: String]] = []) async throws -> CCThread {
        struct Body: Encodable { let title: String; let participants: [[String: String]] }
        struct Response: Codable { let thread: CCThread }
        let resp: Response = try await post("api/threads", body: Body(title: title, participants: participants))
        return resp.thread
    }

    func deleteThread(id: String) async throws {
        let req = request("api/threads/\(id)", method: "DELETE")
        let (_, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, 200...299 ~= http.statusCode else {
            throw APIError.badResponse(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0)
        }
    }

    // MARK: - Agents

    func fetchAgents() async throws -> AgentListResponse {
        try await fetch("api/agents")
    }

    // MARK: - Tasks

    func fetchTasks(state: String? = nil, assignee: String? = nil) async throws -> TaskListResponse {
        var query: [(String, String)] = []
        if let state { query.append(("state", state)) }
        if let assignee { query.append(("assignee", assignee)) }
        return try await fetch("api/tasks", query: query)
    }

    // MARK: - Knowledge Base

    func fetchKBList(agentId: String) async throws -> KBListResponse {
        try await fetch("api/kb/list", query: [("agent", agentId)])
    }

    func fetchKBRead(agentId: String, fileName: String, section: String? = nil) async throws -> KBReadResponse {
        var query: [(String, String)] = [("agent", agentId), ("file", fileName)]
        if let section { query.append(("section", section)) }
        return try await fetch("api/kb/read", query: query)
    }

    // MARK: - Voice transcription

    func transcribeAudio(fileURL: URL) async throws -> TranscriptionResponse {
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: baseURL.appendingPathComponent("api/harness/voice/transcribe"))
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let projectId { req.setValue(projectId, forHTTPHeaderField: "X-Project-Id") }
        req.timeoutInterval = 60

        let audioData = try Data(contentsOf: fileURL)
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"audio\"; filename=\"recording.m4a\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: audio/m4a\r\n\r\n".data(using: .utf8)!)
        body.append(audioData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, 200...299 ~= http.statusCode else {
            throw APIError.badResponse(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        return try JSONDecoder().decode(TranscriptionResponse.self, from: data)
    }

    // MARK: - Image upload

    func uploadImage(imageData: Data, fileName: String, caption: String?, threadId: String, sender: String = "user") async throws -> SendMessageResponse {
        let boundary = "Boundary-\(UUID().uuidString)"
        // Backend reads threadId from query params
        var components = URLComponents(url: baseURL.appendingPathComponent("api/message/image"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "threadId", value: threadId)]
        var req = URLRequest(url: components.url!)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let projectId { req.setValue(projectId, forHTTPHeaderField: "X-Project-Id") }
        req.timeoutInterval = 60

        var body = Data()
        // Text fields
        for (key, value) in [("sender", sender), ("source", "ios"), ("threadId", threadId)] {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(key)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }
        if let caption, !caption.isEmpty {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"caption\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(caption)\r\n".data(using: .utf8)!)
        }
        // Image file
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"image\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(imageData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, 200...299 ~= http.statusCode else {
            throw APIError.badResponse(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        return try JSONDecoder().decode(SendMessageResponse.self, from: data)
    }

    // MARK: - Dashboard

    func fetchDashboard() async throws -> DashboardResponse {
        try await fetch("api/dashboard")
    }

    // MARK: - Status

    func checkStatus() async throws -> StatusResponse {
        try await fetch("api/status")
    }

    // MARK: - Health

    func fetchHealth() async throws -> HealthData {
        // Health endpoint is global (no project scope) — build request directly
        // to avoid mutating projectId which could race with other actor calls.
        var req = URLRequest(url: baseURL.appendingPathComponent("api/health"))
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, 200...299 ~= http.statusCode else {
            throw APIError.badResponse(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        do {
            return try JSONDecoder().decode(HealthData.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    func restartBridge(agentId: String, reason: String? = nil) async throws -> RecoveryActionResponse {
        struct Body: Encodable { let reason: String? }
        return try await post("api/health/bridges/\(agentId)/restart", body: Body(reason: reason ?? "manual restart"))
    }

    func stopBridge(agentId: String) async throws -> RecoveryActionResponse {
        struct Body: Encodable { let reason: String? }
        return try await post("api/health/bridges/\(agentId)/stop", body: Body(reason: "manual stop"))
    }

    func startBridge(agentId: String) async throws -> RecoveryActionResponse {
        struct Body: Encodable { let reason: String? }
        return try await post("api/health/bridges/\(agentId)/start", body: Body(reason: nil))
    }

    func cleanupStaleProcesses() async throws -> RecoveryActionResponse {
        struct Empty: Encodable {}
        return try await post("api/health/cleanup", body: Empty())
    }

    func restartGateway() async throws -> RecoveryActionResponse {
        struct Empty: Encodable {}
        return try await post("api/restart", body: Empty())
    }
}

// MARK: - Response types

struct DashboardResponse: Codable {
    let blocks: [DashboardBlock]?
    let updatedAt: String?
    let updatedBy: String?
}

struct StatusResponse: Codable {
    let ready: Bool?
}

struct KBListResponse: Codable {
    let files: [String]
}

struct KBReadResponse: Codable {
    let file: String
    let content: String
    let section: String?
}

struct TranscriptionResponse: Codable {
    let text: String
    let language: String?
}
