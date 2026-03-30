import Foundation

struct Project: Identifiable, Codable, Hashable {
    let id: String
    let name: String
    let port: Int
    let repo: String
    let status: String // "active", "inactive"
}

struct RegistryResponse: Codable {
    let projects: [Project]
}
