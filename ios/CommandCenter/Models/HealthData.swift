import SwiftUI

/// Overall system health status from GET /api/health
struct HealthData: Codable {
    let status: SystemStatus
    let uptimeSeconds: Int
    let startedAt: String
    let memory: MemoryInfo
    var projects: [String: ProjectHealth]
    let sse: SSEInfo
    let errorsLastHour: Int

    enum CodingKeys: String, CodingKey {
        case status
        case uptimeSeconds = "uptime_seconds"
        case startedAt = "started_at"
        case memory, projects, sse
        case errorsLastHour = "errors_last_hour"
    }

    // Also handle camelCase from SSE payloads
    enum AltCodingKeys: String, CodingKey {
        case status, uptimeSeconds, startedAt, memory, projects, sse, errorsLastHour
    }

    init(from decoder: Decoder) throws {
        if let c = try? decoder.container(keyedBy: CodingKeys.self), c.contains(.uptimeSeconds) {
            status = (try? c.decode(SystemStatus.self, forKey: .status)) ?? .unhealthy
            uptimeSeconds = (try? c.decode(Int.self, forKey: .uptimeSeconds)) ?? 0
            startedAt = (try? c.decode(String.self, forKey: .startedAt)) ?? ""
            memory = (try? c.decode(MemoryInfo.self, forKey: .memory)) ?? MemoryInfo.empty
            projects = (try? c.decode([String: ProjectHealth].self, forKey: .projects)) ?? [:]
            sse = (try? c.decode(SSEInfo.self, forKey: .sse)) ?? SSEInfo.empty
            errorsLastHour = (try? c.decode(Int.self, forKey: .errorsLastHour)) ?? 0
        } else {
            let c = try decoder.container(keyedBy: AltCodingKeys.self)
            status = (try? c.decode(SystemStatus.self, forKey: .status)) ?? .unhealthy
            uptimeSeconds = (try? c.decode(Int.self, forKey: .uptimeSeconds)) ?? 0
            startedAt = (try? c.decode(String.self, forKey: .startedAt)) ?? ""
            memory = (try? c.decode(MemoryInfo.self, forKey: .memory)) ?? MemoryInfo.empty
            projects = (try? c.decode([String: ProjectHealth].self, forKey: .projects)) ?? [:]
            sse = (try? c.decode(SSEInfo.self, forKey: .sse)) ?? SSEInfo.empty
            errorsLastHour = (try? c.decode(Int.self, forKey: .errorsLastHour)) ?? 0
        }
    }
}

enum SystemStatus: String, Codable {
    case healthy, degraded, unhealthy

    var color: Color {
        switch self {
        case .healthy: .green
        case .degraded: .orange
        case .unhealthy: .red
        }
    }

    var icon: String {
        switch self {
        case .healthy: "checkmark.circle.fill"
        case .degraded: "exclamationmark.triangle.fill"
        case .unhealthy: "xmark.circle.fill"
        }
    }

    var displayName: String {
        rawValue.capitalized
    }
}

struct MemoryInfo: Codable {
    let rssMb: Double
    let heapUsedMb: Double
    let heapTotalMb: Double

    enum CodingKeys: String, CodingKey {
        case rssMb = "rss_mb"
        case heapUsedMb = "heap_used_mb"
        case heapTotalMb = "heap_total_mb"
    }

    enum AltCodingKeys: String, CodingKey {
        case rssMb, heapUsedMb, heapTotalMb
    }

    init(rssMb: Double, heapUsedMb: Double, heapTotalMb: Double) {
        self.rssMb = rssMb
        self.heapUsedMb = heapUsedMb
        self.heapTotalMb = heapTotalMb
    }

    init(from decoder: Decoder) throws {
        if let c = try? decoder.container(keyedBy: CodingKeys.self), c.contains(.rssMb) {
            rssMb = (try? c.decode(Double.self, forKey: .rssMb)) ?? 0
            heapUsedMb = (try? c.decode(Double.self, forKey: .heapUsedMb)) ?? 0
            heapTotalMb = (try? c.decode(Double.self, forKey: .heapTotalMb)) ?? 0
        } else {
            let c = try decoder.container(keyedBy: AltCodingKeys.self)
            rssMb = (try? c.decode(Double.self, forKey: .rssMb)) ?? 0
            heapUsedMb = (try? c.decode(Double.self, forKey: .heapUsedMb)) ?? 0
            heapTotalMb = (try? c.decode(Double.self, forKey: .heapTotalMb)) ?? 0
        }
    }

    static let empty = MemoryInfo(rssMb: 0, heapUsedMb: 0, heapTotalMb: 0)
}

struct ProjectHealth: Codable {
    let status: String
    var bridges: [String: BridgeHealth]
    let stores: [String: StoreHealth]
}

struct BridgeHealth: Identifiable, Codable, Hashable {
    var id: String { agentId }
    let agentId: String
    let status: BridgeStatus
    let ready: Bool
    let uptimeSeconds: Int
    let startedAt: String
    let lastActivityAt: String?
    let restartCount: Int
    let lastRestartReason: String?
    let wsPort: Int?
    let pid: Int?

    enum CodingKeys: String, CodingKey {
        case status, ready, pid
        case agentId = "agent_id"
        case uptimeSeconds = "uptime_seconds"
        case startedAt = "started_at"
        case lastActivityAt = "last_activity_at"
        case restartCount = "restart_count"
        case lastRestartReason = "last_restart_reason"
        case wsPort = "ws_port"
    }

    enum AltCodingKeys: String, CodingKey {
        case agentId, status, ready, uptimeSeconds, startedAt
        case lastActivityAt, restartCount, lastRestartReason, wsPort, pid
    }

    init(from decoder: Decoder) throws {
        if let c = try? decoder.container(keyedBy: CodingKeys.self), c.contains(.uptimeSeconds) {
            // The bridge map key is the agent ID; try to decode from field, fallback handled by HealthData parsing
            agentId = (try? c.decode(String.self, forKey: .agentId)) ?? ""
            status = (try? c.decode(BridgeStatus.self, forKey: .status)) ?? .disconnected
            ready = (try? c.decode(Bool.self, forKey: .ready)) ?? false
            uptimeSeconds = (try? c.decode(Int.self, forKey: .uptimeSeconds)) ?? 0
            startedAt = (try? c.decode(String.self, forKey: .startedAt)) ?? ""
            lastActivityAt = try? c.decode(String.self, forKey: .lastActivityAt)
            restartCount = (try? c.decode(Int.self, forKey: .restartCount)) ?? 0
            lastRestartReason = try? c.decode(String.self, forKey: .lastRestartReason)
            wsPort = try? c.decode(Int.self, forKey: .wsPort)
            pid = try? c.decode(Int.self, forKey: .pid)
        } else {
            let c = try decoder.container(keyedBy: AltCodingKeys.self)
            agentId = (try? c.decode(String.self, forKey: .agentId)) ?? ""
            status = (try? c.decode(BridgeStatus.self, forKey: .status)) ?? .disconnected
            ready = (try? c.decode(Bool.self, forKey: .ready)) ?? false
            uptimeSeconds = (try? c.decode(Int.self, forKey: .uptimeSeconds)) ?? 0
            startedAt = (try? c.decode(String.self, forKey: .startedAt)) ?? ""
            lastActivityAt = try? c.decode(String.self, forKey: .lastActivityAt)
            restartCount = (try? c.decode(Int.self, forKey: .restartCount)) ?? 0
            lastRestartReason = try? c.decode(String.self, forKey: .lastRestartReason)
            wsPort = try? c.decode(Int.self, forKey: .wsPort)
            pid = try? c.decode(Int.self, forKey: .pid)
        }
    }
}

enum BridgeStatus: String, Codable {
    case ready, connecting, disconnected, stuck, restarting, stopped

    var color: Color {
        switch self {
        case .ready: .green
        case .connecting, .restarting: .orange
        case .disconnected, .stopped: .red
        case .stuck: .purple
        }
    }

    var icon: String {
        switch self {
        case .ready: "checkmark.circle.fill"
        case .connecting: "arrow.clockwise.circle"
        case .disconnected: "xmark.circle.fill"
        case .stuck: "exclamationmark.circle.fill"
        case .restarting: "arrow.clockwise"
        case .stopped: "stop.circle.fill"
        }
    }

    var displayName: String {
        switch self {
        case .ready: "Ready"
        case .connecting: "Connecting"
        case .disconnected: "Disconnected"
        case .stuck: "Stuck"
        case .restarting: "Restarting"
        case .stopped: "Stopped"
        }
    }
}

struct StoreHealth: Identifiable, Codable, Hashable {
    var id: String { name }
    let name: String
    let ok: Bool
    let path: String
    let sizeKb: Int?

    enum CodingKeys: String, CodingKey {
        case ok, path
        case sizeKb = "size_kb"
    }

    enum AltCodingKeys: String, CodingKey {
        case ok, path, sizeKb
    }

    // name is set from the dictionary key, not from JSON
    init(name: String, ok: Bool, path: String, sizeKb: Int?) {
        self.name = name
        self.ok = ok
        self.path = path
        self.sizeKb = sizeKb
    }

    init(from decoder: Decoder) throws {
        // name will be set by the parent decoder
        self.name = ""
        if let c = try? decoder.container(keyedBy: CodingKeys.self) {
            ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
            path = (try? c.decode(String.self, forKey: .path)) ?? ""
            sizeKb = try? c.decode(Int.self, forKey: .sizeKb)
        } else {
            let c = try decoder.container(keyedBy: AltCodingKeys.self)
            ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
            path = (try? c.decode(String.self, forKey: .path)) ?? ""
            sizeKb = try? c.decode(Int.self, forKey: .sizeKb)
        }
    }
}

struct SSEInfo: Codable {
    let connectedClients: Int
    let bufferSize: Int
    let bufferCapacity: Int?

    enum CodingKeys: String, CodingKey {
        case connectedClients = "connected_clients"
        case bufferSize = "buffer_size"
        case bufferCapacity = "buffer_capacity"
    }

    enum AltCodingKeys: String, CodingKey {
        case connectedClients, bufferSize, bufferCapacity
    }

    init(connectedClients: Int, bufferSize: Int, bufferCapacity: Int?) {
        self.connectedClients = connectedClients
        self.bufferSize = bufferSize
        self.bufferCapacity = bufferCapacity
    }

    init(from decoder: Decoder) throws {
        if let c = try? decoder.container(keyedBy: CodingKeys.self), c.contains(.connectedClients) {
            connectedClients = (try? c.decode(Int.self, forKey: .connectedClients)) ?? 0
            bufferSize = (try? c.decode(Int.self, forKey: .bufferSize)) ?? 0
            bufferCapacity = try? c.decode(Int.self, forKey: .bufferCapacity)
        } else {
            let c = try decoder.container(keyedBy: AltCodingKeys.self)
            connectedClients = (try? c.decode(Int.self, forKey: .connectedClients)) ?? 0
            bufferSize = (try? c.decode(Int.self, forKey: .bufferSize)) ?? 0
            bufferCapacity = try? c.decode(Int.self, forKey: .bufferCapacity)
        }
    }

    /// Formatted buffer display: "142/200" if capacity known, otherwise just "142"
    var formattedBuffer: String {
        if let cap = bufferCapacity {
            return "\(bufferSize)/\(cap)"
        }
        return "\(bufferSize)"
    }

    static let empty = SSEInfo(connectedClients: 0, bufferSize: 0, bufferCapacity: nil)
}

/// Response from recovery action endpoints
struct RecoveryActionResponse: Codable {
    let ok: Bool
    let agentId: String?
    let action: String?
    let killed: Int?

    enum CodingKeys: String, CodingKey {
        case ok, action, killed
        case agentId = "agent_id"
    }

    enum AltCodingKeys: String, CodingKey {
        case ok, agentId, action, killed
    }

    init(from decoder: Decoder) throws {
        if let c = try? decoder.container(keyedBy: CodingKeys.self) {
            ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
            agentId = try? c.decode(String.self, forKey: .agentId)
            action = try? c.decode(String.self, forKey: .action)
            killed = try? c.decode(Int.self, forKey: .killed)
        } else {
            let c = try decoder.container(keyedBy: AltCodingKeys.self)
            ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
            agentId = try? c.decode(String.self, forKey: .agentId)
            action = try? c.decode(String.self, forKey: .action)
            killed = try? c.decode(Int.self, forKey: .killed)
        }
    }
}

// MARK: - Helpers

extension HealthData {
    /// Extract bridges for a specific project as an array with agent IDs populated
    func bridges(forProject projectId: String) -> [BridgeHealth] {
        guard let project = projects[projectId] else { return [] }
        return project.bridges.map { key, value in
            // The bridge's agentId may be empty since it comes from the dict key
            if value.agentId.isEmpty {
                // Re-create with the key as the ID
                return BridgeHealth(agentId: key, bridge: value)
            }
            return value
        }.sorted { $0.agentId < $1.agentId }
    }

    /// Extract stores for a specific project as an array with names populated
    func stores(forProject projectId: String) -> [StoreHealth] {
        guard let project = projects[projectId] else { return [] }
        return project.stores.map { key, value in
            StoreHealth(name: key, ok: value.ok, path: value.path, sizeKb: value.sizeKb)
        }.sorted { $0.name < $1.name }
    }

    /// Formatted uptime string
    var formattedUptime: String {
        formatDuration(uptimeSeconds)
    }
}

extension BridgeHealth {
    /// Create a copy with the given agentId
    init(agentId: String, bridge: BridgeHealth) {
        self.agentId = agentId
        self.status = bridge.status
        self.ready = bridge.ready
        self.uptimeSeconds = bridge.uptimeSeconds
        self.startedAt = bridge.startedAt
        self.lastActivityAt = bridge.lastActivityAt
        self.restartCount = bridge.restartCount
        self.lastRestartReason = bridge.lastRestartReason
        self.wsPort = bridge.wsPort
        self.pid = bridge.pid
    }

    /// Create a copy with an overridden status (for optimistic SSE updates)
    init(agentId: String, status: BridgeStatus, ready: Bool, bridge: BridgeHealth) {
        self.agentId = agentId
        self.status = status
        self.ready = ready
        self.uptimeSeconds = bridge.uptimeSeconds
        self.startedAt = bridge.startedAt
        self.lastActivityAt = bridge.lastActivityAt
        self.restartCount = bridge.restartCount
        self.lastRestartReason = bridge.lastRestartReason
        self.wsPort = bridge.wsPort
        self.pid = bridge.pid
    }

    var formattedUptime: String {
        formatDuration(uptimeSeconds)
    }

    var lastActivityAgo: String? {
        guard let lastActivityAt else { return nil }
        return formatRelativeTime(lastActivityAt)
    }
}

/// Format seconds into a human-readable duration
private func formatDuration(_ seconds: Int) -> String {
    if seconds < 60 { return "\(seconds)s" }
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m \(seconds % 60)s" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h \(minutes % 60)m" }
    let days = hours / 24
    return "\(days)d \(hours % 24)h"
}

/// Format an ISO timestamp into a relative "ago" string
private func formatRelativeTime(_ isoString: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: isoString) ?? ISO8601DateFormatter().date(from: isoString) else {
        return isoString
    }
    let elapsed = Int(-date.timeIntervalSinceNow)
    if elapsed < 0 { return "just now" }
    if elapsed < 5 { return "just now" }
    if elapsed < 60 { return "\(elapsed)s ago" }
    let minutes = elapsed / 60
    if minutes < 60 { return "\(minutes)m ago" }
    let hours = minutes / 60
    return "\(hours)h ago"
}
