import SwiftUI

struct CCAgent: Identifiable, Codable, Hashable {
    let id: String
    let name: String
    let role: String
    let status: String // "active", "running", "stopped", "archived"
    let createdBy: String
    let createdAt: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, name, role, status
        case createdBy = "created_by"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    // SSE payloads use camelCase
    enum AltCodingKeys: String, CodingKey {
        case id, name, role, status
        case createdBy, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        if let c = try? decoder.container(keyedBy: CodingKeys.self), c.contains(.createdAt) {
            id = try c.decode(String.self, forKey: .id)
            name = try c.decode(String.self, forKey: .name)
            role = (try? c.decode(String.self, forKey: .role)) ?? ""
            status = (try? c.decode(String.self, forKey: .status)) ?? "active"
            createdBy = (try? c.decode(String.self, forKey: .createdBy)) ?? ""
            createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
            updatedAt = (try? c.decode(String.self, forKey: .updatedAt)) ?? ""
        } else {
            let c = try decoder.container(keyedBy: AltCodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = try c.decode(String.self, forKey: .name)
            role = (try? c.decode(String.self, forKey: .role)) ?? ""
            status = (try? c.decode(String.self, forKey: .status)) ?? "active"
            createdBy = (try? c.decode(String.self, forKey: .createdBy)) ?? ""
            createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
            updatedAt = (try? c.decode(String.self, forKey: .updatedAt)) ?? ""
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(role, forKey: .role)
        try c.encode(status, forKey: .status)
        try c.encode(createdBy, forKey: .createdBy)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
    }

    var statusColor: Color {
        switch status {
        case "active": .green
        case "running": .blue
        case "stopped": .orange
        default: .gray
        }
    }
}

struct AgentListResponse: Codable {
    let agents: [CCAgent]
}

struct AgentMetrics: Codable {
    let agentId: String
    let lastActivity: String?
    let messageCount: Int
    let currentTask: AgentCurrentTask?
    let uptime: Int // seconds
    let bridgeStatus: String // "connected", "disconnected", "idle"

    var bridgeStatusColor: Color {
        switch bridgeStatus {
        case "connected": .green
        case "disconnected": .red
        default: .gray
        }
    }

    var formattedUptime: String {
        let hours = uptime / 3600
        let mins = (uptime % 3600) / 60
        if hours > 0 { return "\(hours)h \(mins)m" }
        if mins > 0 { return "\(mins)m" }
        return "\(uptime)s"
    }

    var relativeLastActivity: String? {
        guard let lastActivity else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: lastActivity) else {
            // Try without fractional seconds
            formatter.formatOptions = [.withInternetDateTime]
            guard let date = formatter.date(from: lastActivity) else { return nil }
            return Self.relativeString(from: date)
        }
        return Self.relativeString(from: date)
    }

    private static func relativeString(from date: Date) -> String {
        let seconds = Int(-date.timeIntervalSinceNow)
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        if seconds < 86400 { return "\(seconds / 3600)h ago" }
        return "\(seconds / 86400)d ago"
    }
}

struct AgentCurrentTask: Codable {
    let id: String
    let title: String
}
