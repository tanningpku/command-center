import Foundation

/// A single dashboard block. Supports 7 block types: hero, stats, alert, activity, list, section, agents.
/// Can be decoded from the API or constructed client-side for auto-aggregated dashboards.
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

    init(type: String, title: String? = nil, subtitle: String? = nil, status: String? = nil,
         body: String? = nil, content: String? = nil, items: [JSONValue]? = nil, agents: [JSONValue]? = nil) {
        self.type = type
        self.title = title
        self.subtitle = subtitle
        self.status = status
        self.body = body
        self.content = content
        self.items = items
        self.agents = agents
    }
}
