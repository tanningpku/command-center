import SwiftUI

/// A design doc / spec file from an agent's knowledge base.
struct DocItem: Identifiable, Hashable {
    let id: String          // "agentId/filename"
    let fileName: String
    let agentId: String
    let agentName: String

    var displayTitle: String {
        fileName
            .replacingOccurrences(of: ".md", with: "")
            .split(separator: "-").joined(separator: " ")
            .split(separator: "_").joined(separator: " ")
            .localizedCapitalized
    }
}

/// Aggregates KB files from all agents, filtering out system files.
@MainActor
@Observable
class DocsStore {
    var docs: [DocItem] = []
    var isLoading = false
    var error: String?

    // Detail loading state
    var selectedDoc: DocItem?
    var docContent: String?
    var isLoadingContent = false

    // Search / filter
    var searchText = ""

    private let api: APIService

    /// System files that should not appear in the docs list.
    private static let excludedFiles: Set<String> = [
        "identity.md", "tools.md"
    ]

    init(api: APIService) {
        self.api = api
    }

    var filteredDocs: [DocItem] {
        guard !searchText.isEmpty else { return docs }
        let query = searchText.lowercased()
        return docs.filter {
            $0.displayTitle.lowercased().contains(query) ||
            $0.agentName.lowercased().contains(query) ||
            $0.fileName.lowercased().contains(query)
        }
    }

    /// Agents grouped for section headers.
    var agentGroups: [(agentName: String, docs: [DocItem])] {
        let grouped = Dictionary(grouping: filteredDocs, by: \.agentName)
        return grouped
            .sorted { $0.key < $1.key }
            .map { (agentName: $0.key, docs: $0.value.sorted { $0.displayTitle < $1.displayTitle }) }
    }

    func loadDocs() async {
        isLoading = true
        error = nil
        // Clear all stale state so a project switch never shows old data
        docs = []
        selectedDoc = nil
        docContent = nil

        do {
            // 1. Fetch all agents
            let agentResponse = try await api.fetchAgents()
            let agents = agentResponse.agents.filter { $0.status != "archived" }

            // 2. For each agent, fetch KB file list concurrently
            var allDocs: [DocItem] = []
            var hadPartialFailure = false
            await withTaskGroup(of: (Bool, [DocItem]).self) { group in
                for agent in agents {
                    group.addTask { [api] in
                        guard let kbResponse = try? await api.fetchKBList(agentId: agent.id) else {
                            return (false, [])
                        }
                        let items = kbResponse.files
                            .filter { !Self.excludedFiles.contains($0) }
                            .map { file in
                                DocItem(
                                    id: "\(agent.id)/\(file)",
                                    fileName: file,
                                    agentId: agent.id,
                                    agentName: agent.name
                                )
                            }
                        return (true, items)
                    }
                }
                for await (succeeded, items) in group {
                    if !succeeded { hadPartialFailure = true }
                    allDocs.append(contentsOf: items)
                }
            }

            docs = allDocs.sorted { $0.displayTitle < $1.displayTitle }

            if hadPartialFailure {
                self.error = "Some agents' docs could not be loaded"
            }

            // Only cache when all agents loaded successfully to avoid persisting partial results
            if !hadPartialFailure, let projectId = UserDefaults.standard.string(forKey: AppConfig.selectedProjectKey) {
                CacheManager.save(docs.map { CachedDocItem(id: $0.id, fileName: $0.fileName, agentId: $0.agentId, agentName: $0.agentName) },
                                  key: "docs", projectId: projectId)
            }
        } catch {
            // Fall back to cache only when docs are empty (cleared above on project switch)
            if let projectId = UserDefaults.standard.string(forKey: AppConfig.selectedProjectKey),
               let cached = CacheManager.load([CachedDocItem].self, key: "docs", projectId: projectId) {
                docs = cached.map { DocItem(id: $0.id, fileName: $0.fileName, agentId: $0.agentId, agentName: $0.agentName) }
            }
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    func loadDocContent(doc: DocItem) async {
        let requestedDoc = doc
        selectedDoc = doc
        docContent = nil
        isLoadingContent = true
        do {
            let response = try await api.fetchKBRead(agentId: doc.agentId, fileName: doc.fileName)
            // Guard against race: only update if this is still the selected doc
            guard selectedDoc == requestedDoc else { return }
            docContent = response.content
        } catch {
            guard selectedDoc == requestedDoc else { return }
            docContent = "Error loading document: \(error.localizedDescription)"
        }
        isLoadingContent = false
    }
}

/// Codable wrapper for caching DocItem.
private struct CachedDocItem: Codable {
    let id: String
    let fileName: String
    let agentId: String
    let agentName: String
}
