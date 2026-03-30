import Foundation

struct CCThread: Identifiable, Codable, Hashable {
    let id: String
    let title: String
    let status: String // "active", "archived"
    let summary: String?
    let createdAt: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, title, status, summary
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    enum AltCodingKeys: String, CodingKey {
        case id, title, status, summary, createdAt, updatedAt
    }

    init(id: String, title: String, status: String = "active", summary: String? = nil,
         createdAt: String = "", updatedAt: String = "") {
        self.id = id
        self.title = title
        self.status = status
        self.summary = summary
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        if let c = try? decoder.container(keyedBy: CodingKeys.self), c.contains(.createdAt) {
            id = try c.decode(String.self, forKey: .id)
            title = try c.decode(String.self, forKey: .title)
            status = (try? c.decode(String.self, forKey: .status)) ?? "active"
            summary = try? c.decode(String.self, forKey: .summary)
            createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
            updatedAt = (try? c.decode(String.self, forKey: .updatedAt)) ?? ""
        } else {
            let c = try decoder.container(keyedBy: AltCodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decode(String.self, forKey: .title)
            status = (try? c.decode(String.self, forKey: .status)) ?? "active"
            summary = try? c.decode(String.self, forKey: .summary)
            createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
            updatedAt = (try? c.decode(String.self, forKey: .updatedAt)) ?? ""
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(status, forKey: .status)
        try c.encodeIfPresent(summary, forKey: .summary)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
    }

    var relativeTime: String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fmt.date(from: updatedAt) ?? {
            fmt.formatOptions = [.withInternetDateTime]
            return fmt.date(from: updatedAt)
        }() else { return "" }

        let diff = Date().timeIntervalSince(date)
        if diff < 60 { return "now" }
        if diff < 3600 { return "\(Int(diff / 60))m ago" }
        if diff < 86400 { return "\(Int(diff / 3600))h ago" }
        return "\(Int(diff / 86400))d ago"
    }
}

struct ThreadParticipant: Codable, Hashable {
    let threadId: String
    let participantType: String // "user", "assistant"
    let participantId: String
    let role: String // "participant", "lead", "assignee", "subscriber"
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case role
        case threadId = "thread_id"
        case participantType = "participant_type"
        case participantId = "participant_id"
        case createdAt = "created_at"
    }
}

struct ThreadListResponse: Codable {
    let threads: [CCThread]
}

struct ThreadMessagesResponse: Codable {
    let messages: [CCMessage]
}

struct ParticipantsResponse: Codable {
    let participants: [ThreadParticipant]
}

struct SendMessageResponse: Codable {
    let ok: Bool?
    let accepted: Bool?
}
