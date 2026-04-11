import SwiftUI

/// Manages task list grouped by state for the kanban Board tab.
@MainActor
@Observable
class BoardStore {
    var tasks: [CCTask] = []
    var isLoading = false
    var isStale = false
    var error: String?

    // Filter state
    var searchText = ""
    var filterPriority: TaskPriority?
    var filterAssignee: String?

    var isFiltered: Bool {
        !searchText.isEmpty || filterPriority != nil || filterAssignee != nil
    }

    private let api: APIService

    /// Kanban column definitions (non-terminal states shown as active columns)
    static let columns: [TaskState] = [.created, .assigned, .in_progress, .in_review, .qa, .blocked, .done]

    private static let cacheKey = "tasks"

    init(api: APIService) {
        self.api = api
    }

    func loadTasks() async {
        isLoading = true
        error = nil
        do {
            let search = searchText.trimmingCharacters(in: .whitespaces)
            let response = try await api.fetchTasks(
                assignee: filterAssignee,
                priority: filterPriority?.rawValue,
                search: search.isEmpty ? nil : search,
                limit: 10000
            )
            tasks = response.tasks
            isStale = false
            // Cache for offline (only cache unfiltered results)
            if !isFiltered, let projectId = UserDefaults.standard.string(forKey: AppConfig.selectedProjectKey) {
                CacheManager.save(response.tasks, key: Self.cacheKey, projectId: projectId)
            }
        } catch {
            // Fall back to cache
            if tasks.isEmpty, let projectId = UserDefaults.standard.string(forKey: AppConfig.selectedProjectKey),
               let cached = CacheManager.load([CCTask].self, key: Self.cacheKey, projectId: projectId) {
                tasks = cached
                isStale = true
            }
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func clearFilters() {
        searchText = ""
        filterPriority = nil
        filterAssignee = nil
    }

    /// Tasks grouped by state for kanban columns
    func tasksForState(_ state: TaskState) -> [CCTask] {
        tasks.filter { $0.state == state }
    }

    func createTask(title: String, description: String?, priority: String, assignee: String?) async throws {
        let task = try await api.createTask(title: title, description: description, priority: priority, assignee: assignee)
        if !tasks.contains(where: { $0.id == task.id }) {
            tasks.append(task)
        }
        HapticManager.success()
    }

    func updateTaskState(id: String, state: TaskState) async throws {
        let task = try await api.updateTask(id: id, state: state.rawValue)
        if let idx = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[idx] = task
        }
        HapticManager.medium()
    }

    /// Handle task SSE events
    func handleTaskEvent(type: String, payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let task = try? JSONDecoder().decode(CCTask.self, from: data) else { return }

        switch type {
        case "task_created":
            if !tasks.contains(where: { $0.id == task.id }) {
                tasks.append(task)
                HapticManager.light()
            }
        case "task_updated":
            if let idx = tasks.firstIndex(where: { $0.id == task.id }) {
                let oldState = tasks[idx].state
                tasks[idx] = task
                if task.state != oldState {
                    HapticManager.medium()
                }
            } else {
                tasks.append(task)
            }
        case "task_completed":
            if let idx = tasks.firstIndex(where: { $0.id == task.id }) {
                tasks[idx] = task
            } else {
                tasks.append(task)
            }
            HapticManager.success()
        default: break
        }
    }
}
