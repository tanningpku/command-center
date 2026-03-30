import Foundation

/// A single block in the captain-authored dashboard.
/// Supports 7 block types: hero, stats, alert, activity, list, section, agents.
struct DashboardBlock: Codable, Identifiable {
    let type: String
    let title: String?
    let subtitle: String?
    let status: String?
    let body: String?
    let content: String?
    let items: [JSONValue]?
    let agents: [JSONValue]?

    var id: String { "\(type)-\(title ?? "")-\(subtitle ?? "")" }

    /// Section/body text — API may use either "body" or "content" field
    var text: String { body ?? content ?? "" }
}
