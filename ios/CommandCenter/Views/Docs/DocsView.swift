import SwiftUI

/// Lists design docs, specs, and design mockups aggregated from all agents.
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
                        description: Text("Design documents and mockups will appear here once agents add them."))
                } else if docsStore.filteredDocs.isEmpty {
                    if docsStore.searchText.isEmpty {
                        // Segment is selected but no items of that type
                        ContentUnavailableView {
                            Label(docsStore.selectedSegment == .design ? "No Designs" : "No Specs",
                                  systemImage: docsStore.selectedSegment == .design ? "paintbrush" : "doc.text")
                        } description: {
                            Text(docsStore.selectedSegment == .design
                                 ? "No design mockups found for this project."
                                 : "No spec documents found for this project.")
                        }
                    } else {
                        ContentUnavailableView.search(text: docsStore.searchText)
                    }
                } else {
                    List {
                        if let error = docsStore.error, !docsStore.docs.isEmpty {
                            Section {
                                Label(error, systemImage: "exclamationmark.triangle")
                                    .font(.caption)
                                    .foregroundStyle(.orange)
                            }
                        }
                        ForEach(docsStore.agentGroups, id: \.agentId) { group in
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
            .safeAreaInset(edge: .top) {
                if !docsStore.docs.isEmpty || docsStore.isLoading {
                    DocsSegmentPicker()
                        .padding(.horizontal)
                        .padding(.bottom, 8)
                        .background(.bar)
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

/// Segment picker for filtering between All, Specs, and Designs.
struct DocsSegmentPicker: View {
    @Environment(DocsStore.self) var docsStore

    var body: some View {
        @Bindable var docsStore = docsStore

        Picker("Filter", selection: $docsStore.selectedSegment) {
            Text("All (\(docsStore.docs.count))")
                .tag(nil as DocType?)
            Text("Specs (\(docsStore.specCount))")
                .tag(DocType.spec as DocType?)
            Text("Designs (\(docsStore.designCount))")
                .tag(DocType.design as DocType?)
        }
        .pickerStyle(.segmented)
    }
}

/// Row showing a single doc entry with filename, icon, and optional metadata.
struct DocRowView: View {
    let doc: DocItem

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: docIcon(for: doc))
                .foregroundStyle(doc.type == .design ? .purple : .blue)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(doc.displayTitle)
                    .font(.body)
                HStack(spacing: 6) {
                    Text(doc.fileName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let size = doc.formattedSize {
                        Text("·")
                            .font(.caption)
                            .foregroundStyle(.quaternary)
                        Text(size)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func docIcon(for doc: DocItem) -> String {
        if doc.type == .design { return "paintbrush.pointed" }
        let lower = doc.fileName.lowercased()
        if lower.contains("spec") { return "doc.text.magnifyingglass" }
        if lower.contains("design") { return "paintbrush" }
        if lower.contains("architecture") { return "building.2" }
        if lower.contains("convention") { return "list.bullet.rectangle" }
        if lower.contains("gotcha") { return "exclamationmark.triangle" }
        return "doc.text"
    }
}
