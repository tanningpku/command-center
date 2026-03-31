import SwiftUI

/// Manages project registry, selection, and persistence.
@MainActor
@Observable
class ProjectStore {
    var projects: [Project] = []
    var selectedId: String? {
        didSet { UserDefaults.standard.set(selectedId, forKey: AppConfig.selectedProjectKey) }
    }
    var isLoading = false
    var error: String?

    private let api: APIService

    var selected: Project? {
        projects.first { $0.id == selectedId }
    }

    init(api: APIService) {
        self.api = api
        self.selectedId = UserDefaults.standard.string(forKey: AppConfig.selectedProjectKey)
    }

    func load() async {
        isLoading = true
        error = nil
        do {
            let response = try await api.fetchRegistry()
            projects = response.projects
            // Auto-select persisted project or first available
            if selectedId == nil || !projects.contains(where: { $0.id == selectedId }) {
                selectedId = projects.first?.id
            }
            // Push project to API service
            if let id = selectedId {
                await api.setProject(id)
            }
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func createProject(name: String) async throws {
        let project = try await api.createProject(name: name)
        projects.append(project)
        await select(project.id)
    }

    func select(_ id: String) async {
        selectedId = id
        await api.setProject(id)
        // Notify observers via NotificationCenter
        NotificationCenter.default.post(name: .projectChanged, object: nil)
    }
}

extension Notification.Name {
    static let projectChanged = Notification.Name("projectChanged")
}
