import SwiftUI

/// Lists design docs and specs aggregated from all agent knowledge bases.
struct DocsView: View {
    @Environment(DocsStore.self) var docsStore
    @Environment(ProjectStore.self) var projectStore

    var body: some View {
        @Bindable var docsStore = docsStore

        NavigationStack {
            Group {
                if docsStore.isLoading && docsStore.docs.isEmpty {
                    ProgressView("Loading docs...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = docsStore.error, docsStore.docs.isEmpty {
                    ContentUnavailableView {
                        Label("Load Failed", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Retry") { Task { await docsStore.loadDocs() } }
                            .buttonStyle(.borderedProminent)
                    }
                } else if docsStore.docs.isEmpty {
                    ContentUnavailableView("No Docs", systemImage: "book",
                        description: Text("Design documents will appear here once agents add them to their knowledge base."))
                } else if docsStore.filteredDocs.isEmpty {
                    ContentUnavailableView.search(text: docsStore.searchText)
                } else {
                    List {
                        ForEach(docsStore.agentGroups, id: \.agentName) { group in
                            Section(group.agentName) {
                                ForEach(group.docs) { doc in
                                    NavigationLink(value: doc) {
                                        DocRowView(doc: doc)
                                    }
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Docs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ProjectSelectorView()
                }
            }
            .searchable(text: $docsStore.searchText, prompt: "Search docs...")
            .navigationDestination(for: DocItem.self) { doc in
                DocDetailView(doc: doc)
            }
            .refreshable {
                HapticManager.light()
                await docsStore.loadDocs()
            }
            .task { await docsStore.loadDocs() }
            .onReceive(NotificationCenter.default.publisher(for: .projectChanged)) { _ in
                Task { await docsStore.loadDocs() }
            }
        }
    }
}

/// Row showing a single doc entry with filename and icon.
struct DocRowView: View {
    let doc: DocItem

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: docIcon(for: doc.fileName))
                .foregroundStyle(.blue)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(doc.displayTitle)
                    .font(.body)
                Text(doc.fileName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private func docIcon(for fileName: String) -> String {
        let lower = fileName.lowercased()
        if lower.contains("spec") { return "doc.text.magnifyingglass" }
        if lower.contains("design") { return "paintbrush" }
        if lower.contains("architecture") { return "building.2" }
        if lower.contains("convention") { return "list.bullet.rectangle" }
        if lower.contains("gotcha") { return "exclamationmark.triangle" }
        return "doc.text"
    }
}
