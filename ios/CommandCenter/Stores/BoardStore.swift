import SwiftUI

/// Manages task list grouped by state for the kanban Board tab.
@MainActor
@Observable
class BoardStore {
    var tasks: [CCTask] = []
    var isLoading = false
    var error: String?

    private let api: APIService

    /// Kanban column definitions (non-terminal states shown as active columns)
    static let columns: [TaskState] = [.created, .assigned, .in_progress, .in_review, .qa, .blocked, .done]

    init(api: APIService) {
        self.api = api
    }

    func loadTasks() async {
        isLoading = true
        error = nil
        do {
            let response = try await api.fetchTasks()
            tasks = response.tasks
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    /// Tasks grouped by state for kanban columns
    func tasksForState(_ state: TaskState) -> [CCTask] {
        tasks.filter { $0.state == state }
    }

    /// Handle task SSE events
    func handleTaskEvent(type: String, payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let task = try? JSONDecoder().decode(CCTask.self, from: data) else { return }

        switch type {
        case "task_created":
            if !tasks.contains(where: { $0.id == task.id }) {
                tasks.append(task)
            }
        case "task_updated", "task_completed":
            if let idx = tasks.firstIndex(where: { $0.id == task.id }) {
                tasks[idx] = task
            } else {
                tasks.append(task)
            }
        default: break
        }
    }
}
