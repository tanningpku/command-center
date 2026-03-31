import SwiftUI

/// Manages health monitoring data with polling and SSE event handling.
@MainActor
@Observable
class HealthStore {
    var healthData: HealthData?
    var isLoading = false
    var error: String?

    /// Currently performing a recovery action (shows loading indicator)
    var isPerformingAction = false
    var actionResult: String?

    private let api: APIService
    private var pollTask: Task<Void, Never>?

    init(api: APIService) {
        self.api = api
    }

    // MARK: - Data loading

    func loadHealth() async {
        isLoading = healthData == nil
        error = nil
        do {
            healthData = try await api.fetchHealth()
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    // MARK: - Polling

    func startPolling() {
        stopPolling()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.loadHealth()
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    // MARK: - SSE event handling

    func handleHealthEvent(type: String, payload: [String: Any]) {
        switch type {
        case "health_changed":
            // Full reload to get updated status
            Task { await loadHealth() }
            HapticManager.medium()
        case "bridge_status_changed", "bridge_stopped", "bridge_started", "bridge_restarted":
            // Reload to reflect bridge state changes
            Task { await loadHealth() }
            HapticManager.light()
        case "health_alert":
            // Could show a toast/banner — for now just reload
            Task { await loadHealth() }
            HapticManager.medium()
        default:
            break
        }
    }

    // MARK: - Recovery actions

    func restartBridge(agentId: String) async {
        isPerformingAction = true
        actionResult = nil
        do {
            let response = try await api.restartBridge(agentId: agentId)
            actionResult = response.ok ? "Restarting \(agentId)..." : "Failed to restart \(agentId)"
            HapticManager.success()
            // Reload after a brief delay to show new state
            try? await Task.sleep(for: .seconds(2))
            await loadHealth()
        } catch {
            actionResult = "Error: \(error.localizedDescription)"
        }
        isPerformingAction = false
    }

    func stopBridge(agentId: String) async {
        isPerformingAction = true
        actionResult = nil
        do {
            let response = try await api.stopBridge(agentId: agentId)
            actionResult = response.ok ? "Stopped \(agentId)" : "Failed to stop \(agentId)"
            HapticManager.success()
            try? await Task.sleep(for: .seconds(1))
            await loadHealth()
        } catch {
            actionResult = "Error: \(error.localizedDescription)"
        }
        isPerformingAction = false
    }

    func startBridge(agentId: String) async {
        isPerformingAction = true
        actionResult = nil
        do {
            let response = try await api.startBridge(agentId: agentId)
            actionResult = response.ok ? "Starting \(agentId)..." : "Failed to start \(agentId)"
            HapticManager.success()
            try? await Task.sleep(for: .seconds(2))
            await loadHealth()
        } catch {
            actionResult = "Error: \(error.localizedDescription)"
        }
        isPerformingAction = false
    }

    func cleanupStale() async {
        isPerformingAction = true
        actionResult = nil
        do {
            let response = try await api.cleanupStaleProcesses()
            if response.ok {
                let killed = response.killed ?? 0
                actionResult = killed > 0 ? "Cleaned up \(killed) stale process\(killed == 1 ? "" : "es")" : "No stale processes found"
            } else {
                actionResult = "Cleanup failed"
            }
            HapticManager.success()
            await loadHealth()
        } catch {
            actionResult = "Error: \(error.localizedDescription)"
        }
        isPerformingAction = false
    }

    func restartGateway() async {
        isPerformingAction = true
        actionResult = "Restarting gateway..."
        do {
            _ = try await api.restartGateway()
            actionResult = "Gateway restarting — reconnecting..."
            HapticManager.success()
        } catch {
            actionResult = "Error: \(error.localizedDescription)"
        }
        isPerformingAction = false
    }

    // MARK: - Convenience

    /// Bridges for the currently selected project
    func bridges(projectId: String?) -> [BridgeHealth] {
        guard let projectId, let data = healthData else { return [] }
        return data.bridges(forProject: projectId)
    }

    /// Stores for the currently selected project
    func stores(projectId: String?) -> [StoreHealth] {
        guard let projectId, let data = healthData else { return [] }
        return data.stores(forProject: projectId)
    }
}
