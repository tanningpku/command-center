import SwiftUI

enum TaskState: String, Codable, CaseIterable {
    case created, assigned, in_progress, in_review, qa, blocked, done, cancelled

    var displayName: String {
        switch self {
        case .created: "Created"
        case .assigned: "Assigned"
        case .in_progress: "In Progress"
        case .in_review: "In Review"
        case .qa: "QA"
        case .blocked: "Blocked"
        case .done: "Done"
        case .cancelled: "Cancelled"
        }
    }

    var color: Color {
        switch self {
        case .created: .gray
        case .assigned: .blue
        case .in_progress: .cyan
        case .in_review: .purple
        case .qa: .indigo
        case .blocked: .red
        case .done: .green
        case .cancelled: .secondary
        }
    }

    var isTerminal: Bool { self == .done || self == .cancelled }
}

enum TaskPriority: String, Codable, Comparable {
    case critical, high, medium, normal, low

    var color: Color {
        switch self {
        case .critical: .red
        case .high: .orange
        case .medium: .yellow
        case .normal: .blue
        case .low: .gray
        }
    }

    private var sortOrder: Int {
        switch self {
        case .critical: 0
        case .high: 1
        case .medium: 2
        case .normal: 3
        case .low: 4
        }
    }

    static func < (lhs: TaskPriority, rhs: TaskPriority) -> Bool {
        lhs.sortOrder < rhs.sortOrder
    }
}

struct CCTask: Identifiable, Codable, Hashable {
    let id: String
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
        case githubIssue = "github_issue"
        case githubPR = "github_pr"
        case createdBy = "created_by"
        case threadId = "thread_id"
        case latestUpdate = "latest_update"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    // SSE payloads may use camelCase
    enum AltCodingKeys: String, CodingKey {
        case id, title, description, state, assignee, priority, labels
        case githubIssue, githubPR, createdBy, threadId, latestUpdate, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        if let c = try? decoder.container(keyedBy: CodingKeys.self), c.contains(.createdAt) {
            id = try c.decode(String.self, forKey: .id)
            title = try c.decode(String.self, forKey: .title)
            description = (try? c.decode(String.self, forKey: .description)) ?? ""
            githubIssue = try? c.decode(Int.self, forKey: .githubIssue)
            githubPR = try? c.decode(Int.self, forKey: .githubPR)
            state = (try? c.decode(TaskState.self, forKey: .state)) ?? .created
            assignee = try? c.decode(String.self, forKey: .assignee)
            createdBy = (try? c.decode(String.self, forKey: .createdBy)) ?? ""
            priority = (try? c.decode(TaskPriority.self, forKey: .priority)) ?? .normal
            labels = (try? c.decode([String].self, forKey: .labels)) ?? []
            threadId = try? c.decode(String.self, forKey: .threadId)
            latestUpdate = try? c.decode(String.self, forKey: .latestUpdate)
            createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
            updatedAt = (try? c.decode(String.self, forKey: .updatedAt)) ?? ""
        } else {
            let c = try decoder.container(keyedBy: AltCodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decode(String.self, forKey: .title)
            description = (try? c.decode(String.self, forKey: .description)) ?? ""
            githubIssue = try? c.decode(Int.self, forKey: .githubIssue)
            githubPR = try? c.decode(Int.self, forKey: .githubPR)
            state = (try? c.decode(TaskState.self, forKey: .state)) ?? .created
            assignee = try? c.decode(String.self, forKey: .assignee)
            createdBy = (try? c.decode(String.self, forKey: .createdBy)) ?? ""
            priority = (try? c.decode(TaskPriority.self, forKey: .priority)) ?? .normal
            labels = (try? c.decode([String].self, forKey: .labels)) ?? []
            threadId = try? c.decode(String.self, forKey: .threadId)
            latestUpdate = try? c.decode(String.self, forKey: .latestUpdate)
            createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
            updatedAt = (try? c.decode(String.self, forKey: .updatedAt)) ?? ""
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(description, forKey: .description)
        try c.encodeIfPresent(githubIssue, forKey: .githubIssue)
        try c.encodeIfPresent(githubPR, forKey: .githubPR)
        try c.encode(state, forKey: .state)
        try c.encodeIfPresent(assignee, forKey: .assignee)
        try c.encode(createdBy, forKey: .createdBy)
        try c.encode(priority, forKey: .priority)
        try c.encode(labels, forKey: .labels)
        try c.encodeIfPresent(threadId, forKey: .threadId)
        try c.encodeIfPresent(latestUpdate, forKey: .latestUpdate)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
    }
}

struct TaskListResponse: Codable {
    let tasks: [CCTask]
}
