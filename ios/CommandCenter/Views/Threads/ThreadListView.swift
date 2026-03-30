import SwiftUI

/// Thread list with NavigationStack drill-down to ChatView.
struct ThreadListView: View {
    @Environment(ThreadStore.self) var threadStore
    @Environment(ProjectStore.self) var projectStore
    @Environment(NavigationRouter.self) var router
    @State private var navigationPath = NavigationPath()
    @State private var showSettings = false

    var body: some View {
        NavigationStack(path: $navigationPath) {
            Group {
                if threadStore.isLoadingThreads && threadStore.threads.isEmpty {
                    ProgressView("Loading threads...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if threadStore.threads.isEmpty {
                    ContentUnavailableView("No Threads", systemImage: "bubble.left.and.bubble.right",
                        description: Text("Threads will appear here when agents start working."))
                } else {
                    List(threadStore.threads) { thread in
                        Button {
                            navigationPath.append(thread)
                        } label: {
                            ThreadRowView(thread: thread)
                        }
                        .buttonStyle(.plain)
                    }
                    .listStyle(.plain)
                    .refreshable { await threadStore.loadThreads() }
                }
            }
            .navigationTitle("Threads")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ProjectSelectorView()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 12) {
                        ConnectionDot(isConnected: threadStore.isConnected)
                        Button { showSettings = true } label: {
                            Image(systemName: "gearshape")
                                .font(.body)
                        }
                    }
                }
            }
            .navigationDestination(for: CCThread.self) { thread in
                ChatView(threadId: thread.id, threadTitle: thread.title)
            }
            .task { await threadStore.loadThreads() }
            .onChange(of: router.pendingThreadId) { _, newId in
                if let id = newId {
                    if let thread = threadStore.threads.first(where: { $0.id == id }) {
                        navigationPath.append(thread)
                    }
                    router.pendingThreadId = nil
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .projectChanged)) { _ in
                navigationPath = NavigationPath()
                Task { await threadStore.loadThreads() }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
        }
    }
}

/// Single thread row in the list.
struct ThreadRowView: View {
    let thread: CCThread

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: "number")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(thread.title)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Spacer()
                Text(thread.relativeTime)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            if let summary = thread.summary, !summary.isEmpty {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
    }
}
