import SwiftUI

/// Type of document in the Docs tab.
enum DocType: String, Codable, CaseIterable {
    case spec    // KB markdown files
    case design  // HTML design mockups
}

/// A design doc / spec file from an agent's knowledge base, or an HTML design mockup.
struct DocItem: Identifiable, Hashable {
    let id: String          // "agentId/filename"
    let fileName: String
    let agentId: String
    let agentName: String
    let type: DocType
    let size: Int?          // bytes, designs only
    let modified: String?   // ISO date, designs only

    var displayTitle: String {
        let nameWithoutExt = fileName
            .replacingOccurrences(of: ".md", with: "")
            .replacingOccurrences(of: ".html", with: "")
        return nameWithoutExt
            .split(separator: "-").joined(separator: " ")
            .split(separator: "_").joined(separator: " ")
            .localizedCapitalized
    }

    var formattedSize: String? {
        guard let size else { return nil }
        if size < 1024 { return "\(size) B" }
        if size < 1024 * 1024 { return "\(size / 1024) KB" }
        return String(format: "%.1f MB", Double(size) / 1_048_576)
    }
}

/// Aggregates KB files and design mockups from all agents.
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

    // Segment filter
    var selectedSegment: DocType? = nil  // nil = show all

    private let api: APIService

    /// System files that should not appear in the docs list.
    private static let excludedFiles: Set<String> = [
        "identity.md", "tools.md"
    ]

    init(api: APIService) {
        self.api = api
    }

    var filteredDocs: [DocItem] {
        var items = docs
        // Filter by segment
        if let segment = selectedSegment {
            items = items.filter { $0.type == segment }
        }
        // Filter by search
        if !searchText.isEmpty {
            let query = searchText.lowercased()
            items = items.filter {
                $0.displayTitle.lowercased().contains(query) ||
                $0.agentName.lowercased().contains(query) ||
                $0.fileName.lowercased().contains(query)
            }
        }
        return items
    }

    /// Agents grouped for section headers.
    var agentGroups: [(agentId: String, agentName: String, docs: [DocItem])] {
        let grouped = Dictionary(grouping: filteredDocs, by: \.agentId)
        return grouped
            .sorted { $0.value.first?.agentName ?? "" < $1.value.first?.agentName ?? "" }
            .map { (agentId: $0.key, agentName: $0.value.first?.agentName ?? $0.key, docs: $0.value.sorted { $0.displayTitle < $1.displayTitle }) }
    }

    /// Counts per segment for the picker badges.
    var specCount: Int { docs.filter { $0.type == .spec }.count }
    var designCount: Int { docs.filter { $0.type == .design }.count }

    /// Incremented on each loadDocs() call to discard stale async results.
    private var loadGeneration = 0

    func loadDocs() async {
        loadGeneration += 1
        let myGeneration = loadGeneration
        let snapshotProjectId = UserDefaults.standard.string(forKey: AppConfig.selectedProjectKey)

        isLoading = true
        error = nil
        docs = []
        selectedDoc = nil
        docContent = nil

        do {
            let agentResponse = try await api.fetchAgents()
            guard loadGeneration == myGeneration else { return }
            let agents = agentResponse.agents.filter { $0.status != "archived" }

            var allDocs: [DocItem] = []
            var hadSpecFailure = false

            // Tag task group results to distinguish spec vs design failures
            enum FetchKind { case spec, design }
            await withTaskGroup(of: (FetchKind, Bool, [DocItem]).self) { group in
                for agent in agents {
                    // Fetch KB files (specs)
                    group.addTask { [api] in
                        guard let kbResponse = try? await api.fetchKBList(agentId: agent.id) else {
                            return (.spec, false, [])
                        }
                        let items = kbResponse.files
                            .filter { !Self.excludedFiles.contains($0) }
                            .map { file in
                                DocItem(
                                    id: "\(agent.id)/\(file)",
                                    fileName: file,
                                    agentId: agent.id,
                                    agentName: agent.name,
                                    type: .spec,
                                    size: nil,
                                    modified: nil
                                )
                            }
                        return (.spec, true, items)
                    }

                    // Fetch design mockups (silently fail if endpoint not available)
                    group.addTask { [api] in
                        guard let designResponse = try? await api.fetchDesignsList(agentId: agent.id) else {
                            return (.design, false, [])
                        }
                        let items = designResponse.files.map { file in
                            DocItem(
                                id: "design:\(agent.id)/\(file.name)",
                                fileName: file.name,
                                agentId: agent.id,
                                agentName: agent.name,
                                type: .design,
                                size: file.size,
                                modified: file.modified
                            )
                        }
                        return (.design, true, items)
                    }
                }
                for await (kind, succeeded, items) in group {
                    if kind == .spec && !succeeded { hadSpecFailure = true }
                    allDocs.append(contentsOf: items)
                }
            }

            guard loadGeneration == myGeneration else { return }

            docs = allDocs.sorted { $0.displayTitle < $1.displayTitle }

            // Only show partial failure for specs; design endpoint may not exist yet
            if hadSpecFailure {
                self.error = "Some agents' docs could not be loaded"
            }

            if !hadSpecFailure, let projectId = snapshotProjectId {
                CacheManager.save(docs.map {
                    CachedDocItem(id: $0.id, fileName: $0.fileName, agentId: $0.agentId,
                                  agentName: $0.agentName, type: $0.type,
                                  size: $0.size, modified: $0.modified)
                }, key: "docs", projectId: projectId)
            }
        } catch {
            guard loadGeneration == myGeneration else { return }
            if let projectId = snapshotProjectId,
               let cached = CacheManager.load([CachedDocItem].self, key: "docs", projectId: projectId) {
                docs = cached.map {
                    DocItem(id: $0.id, fileName: $0.fileName, agentId: $0.agentId,
                            agentName: $0.agentName, type: $0.type,
                            size: $0.size, modified: $0.modified)
                }
            }
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    /// Fetches raw HTML content for a design file without needing a DocItem.
    /// Used by DesignSheetView when opening designs from the chat context header.
    func fetchDesignContent(agentId: String, fileName: String) async throws -> String {
        let response = try await api.fetchDesignRead(agentId: agentId, fileName: fileName)
        return response.content
    }

    func loadDocContent(doc: DocItem) async {
        let requestedDoc = doc
        selectedDoc = doc
        docContent = nil
        isLoadingContent = true
        defer { if selectedDoc == requestedDoc { isLoadingContent = false } }

        do {
            let content: String
            switch doc.type {
            case .spec:
                let response = try await api.fetchKBRead(agentId: doc.agentId, fileName: doc.fileName)
                content = response.content
            case .design:
                let response = try await api.fetchDesignRead(agentId: doc.agentId, fileName: doc.fileName)
                content = response.content
            }
            guard selectedDoc == requestedDoc else { return }
            docContent = content
        } catch {
            guard selectedDoc == requestedDoc else { return }
            docContent = "Error loading document: \(error.localizedDescription)"
        }
    }
}

/// Codable wrapper for caching DocItem.
/// New fields default to spec/.nil for backward compatibility with pre-designs caches.
private struct CachedDocItem: Codable {
    let id: String
    let fileName: String
    let agentId: String
    let agentName: String
    let type: DocType
    let size: Int?
    let modified: String?

    init(id: String, fileName: String, agentId: String, agentName: String,
         type: DocType, size: Int?, modified: String?) {
        self.id = id; self.fileName = fileName; self.agentId = agentId
        self.agentName = agentName; self.type = type; self.size = size
        self.modified = modified
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        fileName = try c.decode(String.self, forKey: .fileName)
        agentId = try c.decode(String.self, forKey: .agentId)
        agentName = try c.decode(String.self, forKey: .agentName)
        type = (try? c.decode(DocType.self, forKey: .type)) ?? .spec
        size = try? c.decode(Int.self, forKey: .size)
        modified = try? c.decode(String.self, forKey: .modified)
    }
}
