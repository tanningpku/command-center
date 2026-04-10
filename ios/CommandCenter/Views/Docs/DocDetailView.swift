import SwiftUI

/// Displays the full markdown content of a design doc / spec file.
struct DocDetailView: View {
    let doc: DocItem
    @Environment(DocsStore.self) var docsStore

    var body: some View {
        Group {
            if docsStore.isLoadingContent {
                ProgressView("Loading...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let content = docsStore.docContent {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        // Metadata header
                        HStack(spacing: 8) {
                            Image(systemName: "person.circle")
                                .foregroundStyle(.secondary)
                            Text(doc.agentName)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.bottom, 4)

                        MarkdownTextView(content)
                            .textSelection(.enabled)
                    }
                    .padding()
                }
            } else {
                ContentUnavailableView("No Content", systemImage: "doc.text",
                    description: Text("Could not load document content."))
            }
        }
        .navigationTitle(doc.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await docsStore.loadDocContent(doc: doc)
        }
    }
}
