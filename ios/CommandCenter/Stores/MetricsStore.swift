import SwiftUI

/// Computes task metrics client-side from /api/tasks (no metrics endpoint).
@MainActor
@Observable
class MetricsStore {
    var tasks: [CCTask] = []
    var threadCount: Int = 0
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
            let taskResponse = try await api.fetchTasks()
            tasks = taskResponse.tasks
            let threadResponse = try await api.fetchThreads()
            threadCount = threadResponse.threads.count
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    // MARK: - Computed metrics

    var totalTasks: Int { tasks.count }

    var byState: [(state: TaskState, count: Int)] {
        TaskState.allCases.compactMap { state in
            let count = tasks.filter { $0.state == state }.count
            return count > 0 ? (state, count) : nil
        }
    }

    var byPriority: [(priority: TaskPriority, count: Int)] {
        [TaskPriority.critical, .high, .normal, .low].compactMap { priority in
            let count = tasks.filter { $0.priority == priority }.count
            return count > 0 ? (priority, count) : nil
        }
    }

    var inProgressCount: Int { tasks.filter { $0.state == .in_progress }.count }
    var blockedCount: Int { tasks.filter { $0.state == .blocked }.count }
    var doneCount: Int { tasks.filter { $0.state == .done }.count }

    var completionRate: Double {
        guard totalTasks > 0 else { return 0 }
        return Double(doneCount) / Double(totalTasks)
    }
}
