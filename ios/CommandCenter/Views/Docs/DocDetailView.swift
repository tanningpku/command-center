import SwiftUI
import WebKit

/// Displays either markdown content (specs) or HTML content (designs) for a doc item.
struct DocDetailView: View {
    let doc: DocItem
    @Environment(DocsStore.self) var docsStore

    var body: some View {
        Group {
            if docsStore.isLoadingContent {
                ProgressView("Loading...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let content = docsStore.docContent {
                if doc.type == .design {
                    DesignWebView(htmlContent: content)
                        .ignoresSafeArea(edges: .bottom)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
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
                }
            } else {
                ContentUnavailableView("No Content", systemImage: "doc.text",
                    description: Text("Could not load document content."))
            }
        }
        .navigationTitle(doc.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if doc.type == .design {
                ToolbarItem(placement: .topBarTrailing) {
                    designMetadata
                }
            }
        }
        .task {
            await docsStore.loadDocContent(doc: doc)
        }
    }

    @ViewBuilder
    private var designMetadata: some View {
        HStack(spacing: 6) {
            Image(systemName: "person.circle")
                .foregroundStyle(.secondary)
            Text(doc.agentName)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let size = doc.formattedSize {
                Text("· \(size)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// WKWebView wrapper that renders HTML design mockups with JavaScript disabled.
struct DesignWebView: UIViewRepresentable {
    let htmlContent: String

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = false
        config.defaultWebpagePreferences = prefs

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        webView.loadHTMLString(htmlContent, baseURL: nil)
    }
}
