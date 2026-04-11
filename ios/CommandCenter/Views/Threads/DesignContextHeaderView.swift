import SwiftUI
import WebKit

/// Collapsible header in ChatView that surfaces design docs linked to the thread's task.
///
/// Collapsed: shows task ID badge + state chip + design count.
/// Expanded: shows tappable pills — each opens the HTML design in a sheet.
struct DesignContextHeaderView: View {
    let task: CCTask

    @State private var isExpanded = false
    @State private var selectedDesign: DesignRef?

    var body: some View {
        if task.designDocs.isEmpty { EmptyView() } else {
            VStack(spacing: 0) {
                // Collapsed row — always visible
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { isExpanded.toggle() }
                    HapticManager.selection()
                } label: {
                    HStack(spacing: 8) {
                        Text(task.id)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)

                        taskStateBadge

                        Text("\(task.designDocs.count) design\(task.designDocs.count == 1 ? "" : "s")")
                            .font(.caption2)
                            .foregroundStyle(.secondary)

                        Spacer()

                        Image(systemName: "chevron.down")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(isExpanded ? 180 : 0))
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                // Expanded pills row
                if isExpanded {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(designRefs, id: \.id) { ref in
                                Button {
                                    selectedDesign = ref
                                    HapticManager.light()
                                } label: {
                                    HStack(spacing: 4) {
                                        Image(systemName: "paintbrush.pointed")
                                            .font(.caption2)
                                        Text(ref.displayTitle)
                                            .font(.caption)
                                            .lineLimit(1)
                                    }
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(Color.accentColor.opacity(0.12))
                                    .foregroundStyle(Color.accentColor)
                                    .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.bottom, 8)
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }

                Divider()
            }
            .background(Color(.systemGray6))
            .sheet(item: $selectedDesign) { ref in
                DesignSheetView(ref: ref)
            }
        }
    }

    // MARK: - Helpers

    private var taskStateBadge: some View {
        Text(task.state.displayName)
            .font(.caption2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(task.state.color.opacity(0.15))
            .foregroundStyle(task.state.color)
            .clipShape(Capsule())
    }

    private var designRefs: [DesignRef] {
        task.designDocs.compactMap { raw in
            let parts = raw.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { return nil }
            return DesignRef(agentId: String(parts[0]), fileName: String(parts[1]))
        }
    }
}

// MARK: - Design reference model

struct DesignRef: Identifiable {
    let agentId: String
    let fileName: String

    var id: String { "\(agentId):\(fileName)" }

    var displayTitle: String {
        fileName
            .replacingOccurrences(of: ".html", with: "")
            .replacingOccurrences(of: ".md", with: "")
            .split(separator: "-").joined(separator: " ")
            .split(separator: "_").joined(separator: " ")
            .localizedCapitalized
    }
}

// MARK: - Design sheet

/// Sheet that loads and renders an HTML design file.
struct DesignSheetView: View {
    let ref: DesignRef

    @Environment(DocsStore.self) var docsStore
    @State private var htmlContent: String?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Loading design…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let html = htmlContent {
                    DesignWebView(htmlContent: html)
                        .ignoresSafeArea(edges: .bottom)
                } else {
                    ContentUnavailableView(
                        "Could not load design",
                        systemImage: "doc.text",
                        description: Text(errorMessage ?? "Unknown error")
                    )
                }
            }
            .navigationTitle(ref.displayTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 4) {
                        Image(systemName: "person.circle")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(ref.agentId)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .task {
            await loadDesign()
        }
    }

    private func loadDesign() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await docsStore.fetchDesignContent(agentId: ref.agentId, fileName: ref.fileName)
            htmlContent = response
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
