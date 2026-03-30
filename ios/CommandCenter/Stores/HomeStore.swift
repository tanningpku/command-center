import SwiftUI

/// Fetches and holds dashboard data from GET /api/dashboard.
@MainActor
@Observable
class HomeStore {
    var blocks: [DashboardBlock] = []
    var updatedAt: String?
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
            let response = try await api.fetchDashboard()
            blocks = response.blocks ?? []
            updatedAt = response.updatedAt
        } catch let apiError as APIError {
            self.error = apiError.errorDescription
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}
