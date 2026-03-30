import SwiftUI

/// Manages CI builds and open PRs from /api/ops.
@MainActor
@Observable
class OpsStore {
    var builds: [CIBuild] = []
    var pulls: [PullRequest] = []
    var lastUpdated: String?
    var isLoading = false
    var error: String?

    private let api: APIService

    init(api: APIService) {
        self.api = api
    }

    func load() async {
        isLoading = true
        error = nil
        do {
            let response = try await api.fetchOps()
            lastUpdated = response.lastUpdated

            // Parse builds from JSONValue array
            if let buildsJSON = response.builds {
                builds = buildsJSON.compactMap { CIBuild(from: $0) }
            }
            // Parse pulls from JSONValue array
            if let pullsJSON = response.pulls {
                pulls = pullsJSON.compactMap { PullRequest(from: $0) }
            }
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}

/// CI build run parsed from generic JSON.
struct CIBuild: Identifiable {
    let id: String
    let name: String
    let status: String       // "completed", "in_progress", "queued"
    let conclusion: String?  // "success", "failure", "cancelled"
    let branch: String
    let duration: String?
    let url: String?
    let createdAt: String

    init?(from json: JSONValue) {
        guard let obj = json.objectValue else { return nil }
        self.id = obj["id"]?.stringValue ?? obj["databaseId"]?.stringValue ?? UUID().uuidString
        self.name = obj["name"]?.stringValue ?? obj["workflowName"]?.stringValue ?? "Build"
        self.status = obj["status"]?.stringValue?.lowercased() ?? "unknown"
        self.conclusion = obj["conclusion"]?.stringValue?.lowercased()
        self.branch = obj["headBranch"]?.stringValue ?? obj["branch"]?.stringValue ?? ""
        self.duration = obj["duration"]?.stringValue
        self.url = obj["url"]?.stringValue
        self.createdAt = obj["createdAt"]?.stringValue ?? obj["created_at"]?.stringValue ?? ""
    }

    var statusIcon: String {
        if let conclusion {
            switch conclusion {
            case "success": return "checkmark.circle.fill"
            case "failure": return "xmark.circle.fill"
            case "cancelled": return "minus.circle.fill"
            default: return "questionmark.circle"
            }
        }
        switch status {
        case "in_progress": return "arrow.triangle.2.circlepath"
        case "queued": return "clock"
        default: return "questionmark.circle"
        }
    }

    var statusColor: Color {
        if let conclusion {
            switch conclusion {
            case "success": return .green
            case "failure": return .red
            case "cancelled": return .gray
            default: return .secondary
            }
        }
        switch status {
        case "in_progress": return .orange
        case "queued": return .blue
        default: return .secondary
        }
    }
}

/// Pull request parsed from generic JSON.
struct PullRequest: Identifiable {
    let id: String
    let number: Int
    let title: String
    let author: String
    let state: String       // "OPEN", "MERGED", "CLOSED"
    let branch: String
    let url: String?
    let createdAt: String

    init?(from json: JSONValue) {
        guard let obj = json.objectValue else { return nil }
        self.number = obj["number"]?.intValue ?? 0
        self.id = String(number)
        self.title = obj["title"]?.stringValue ?? "PR"
        self.author = obj["author"]?.stringValue ?? obj["user"]?.stringValue ?? ""
        self.state = obj["state"]?.stringValue ?? "OPEN"
        self.branch = obj["headRefName"]?.stringValue ?? obj["branch"]?.stringValue ?? ""
        self.url = obj["url"]?.stringValue
        self.createdAt = obj["createdAt"]?.stringValue ?? obj["created_at"]?.stringValue ?? ""
    }

    var stateColor: Color {
        switch state.uppercased() {
        case "OPEN": .green
        case "MERGED": .purple
        case "CLOSED": .red
        default: .secondary
        }
    }
}
