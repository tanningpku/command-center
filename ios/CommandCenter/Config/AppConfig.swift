import Foundation

enum AppConfig {
    /// Default gateway URL for development
    static let defaultBaseURL = "http://localhost:3300"

    /// UserDefaults key for persisted base URL
    static let baseURLKey = "gatewayBaseURL"

    /// UserDefaults key for persisted project selection
    static let selectedProjectKey = "selectedProjectId"

    /// UserDefaults key for persisted tab selection
    static let selectedTabKey = "selectedTab"

    static var baseURL: URL? {
        let urlString = UserDefaults.standard.string(forKey: baseURLKey) ?? defaultBaseURL
        return URL(string: urlString)
    }
}
