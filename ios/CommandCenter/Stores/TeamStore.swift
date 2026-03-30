import SwiftUI

/// Manages the agent list and KB browsing for the Team tab.
@MainActor
@Observable
class TeamStore {
    var agents: [CCAgent] = []
    var isLoading = false
    var isStale = false
    var error: String?

    // KB browsing state
    var kbFiles: [String] = []
    var kbContent: String?
    var isLoadingKB = false

    private let api: APIService
    private static let cacheKey = "agents"

    init(api: APIService) {
        self.api = api
    }

    func loadAgents() async {
        isLoading = true
        error = nil
        do {
            let response = try await api.fetchAgents()
            agents = response.agents.filter { $0.status != "archived" }
            isStale = false
            if let projectId = UserDefaults.standard.string(forKey: AppConfig.selectedProjectKey) {
                CacheManager.save(agents, key: Self.cacheKey, projectId: projectId)
            }
        } catch {
            if agents.isEmpty, let projectId = UserDefaults.standard.string(forKey: AppConfig.selectedProjectKey),
               let cached = CacheManager.load([CCAgent].self, key: Self.cacheKey, projectId: projectId) {
                agents = cached
                isStale = true
            }
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func loadKBFiles(agentId: String) async {
        isLoadingKB = true
        kbFiles = []
        kbContent = nil
        do {
            let response = try await api.fetchKBList(agentId: agentId)
            kbFiles = response.files
        } catch {
            self.error = error.localizedDescription
        }
        isLoadingKB = false
    }

    func loadKBFile(agentId: String, fileName: String) async {
        isLoadingKB = true
        do {
            let response = try await api.fetchKBRead(agentId: agentId, fileName: fileName)
            kbContent = response.content
        } catch {
            kbContent = "Error loading file: \(error.localizedDescription)"
        }
        isLoadingKB = false
    }

    /// Handle agent SSE events
    func handleAgentEvent(type: String, payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let agent = try? JSONDecoder().decode(CCAgent.self, from: data) else { return }

        switch type {
        case "agent_created":
            if !agents.contains(where: { $0.id == agent.id }) {
                agents.append(agent)
            }
        case "agent_updated":
            if let idx = agents.firstIndex(where: { $0.id == agent.id }) {
                agents[idx] = agent
            }
        case "agent_archived":
            agents.removeAll { $0.id == agent.id }
        default: break
        }
    }
}
