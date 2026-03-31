import SwiftUI

/// Thread list with NavigationStack drill-down to ChatView.
/// Splits threads into Active and Completed sections based on linked task state.
struct ThreadListView: View {
    @Environment(ThreadStore.self) var threadStore
    @Environment(BoardStore.self) var boardStore
    @Environment(ProjectStore.self) var projectStore
    @Environment(NavigationRouter.self) var router
    @State private var navigationPath = NavigationPath()
    @State private var showSettings = false
    @State private var showCompleted = false
    @State private var showNewThread = false
    @State private var threadToDelete: CCThread?

    /// Thread IDs linked to done/cancelled tasks
    private var completedThreadIds: Set<String> {
        Set(boardStore.tasks
            .filter { $0.state.isTerminal }
            .compactMap { $0.threadId })
    }

    private var activeThreads: [CCThread] {
        threadStore.threads.filter { !completedThreadIds.contains($0.id) }
    }

    private var completedThreads: [CCThread] {
        threadStore.threads.filter { completedThreadIds.contains($0.id) }
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            Group {
                if threadStore.isLoadingThreads && threadStore.threads.isEmpty {
                    ProgressView("Loading threads...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = threadStore.error, threadStore.threads.isEmpty {
                    ContentUnavailableView {
                        Label("Load Failed", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Retry") {
                            Task {
                                await threadStore.loadThreads()
                                await boardStore.loadTasks()
                            }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                } else if threadStore.threads.isEmpty {
                    ContentUnavailableView("No Threads", systemImage: "bubble.left.and.bubble.right",
                        description: Text("Threads will appear here when agents start working."))
                } else {
                    List {
                        // Active threads
                        ForEach(activeThreads) { thread in
                            NavigationLink(value: thread) {
                                ThreadRowView(thread: thread, preview: threadStore.threadPreviews[thread.id])
                            }
                        }
                        .onDelete { offsets in
                            if let idx = offsets.first {
                                threadToDelete = activeThreads[idx]
                            }
                        }

                        // Completed section
                        if !completedThreads.isEmpty {
                            Section {
                                if showCompleted {
                                    ForEach(completedThreads) { thread in
                                        NavigationLink(value: thread) {
                                            ThreadRowView(thread: thread, preview: threadStore.threadPreviews[thread.id])
                                        }
                                        .opacity(0.6)
                                    }
                                    .onDelete { offsets in
                                        if let idx = offsets.first {
                                            threadToDelete = completedThreads[idx]
                                        }
                                    }
                                }
                            } header: {
                                Button {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        showCompleted.toggle()
                                    }
                                } label: {
                                    HStack(spacing: 6) {
                                        Image(systemName: showCompleted ? "chevron.down" : "chevron.right")
                                            .font(.caption2.weight(.semibold))
                                        Text("Completed (\(completedThreads.count))")
                                            .font(.subheadline.weight(.medium))
                                    }
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                    .refreshable {
                        HapticManager.light()
                        await threadStore.loadThreads()
                        await threadStore.loadPreviews()
                        await boardStore.loadTasks()
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Threads")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ProjectSelectorView()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 12) {
                        ConnectionDot(isConnected: threadStore.isConnected)
                        Button { showNewThread = true } label: {
                            Image(systemName: "plus")
                                .font(.body)
                        }
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
            .safeAreaInset(edge: .top, spacing: 0) {
                StaleBanner(isStale: threadStore.isStale)
            }
            .task {
                await threadStore.loadThreads()
                await threadStore.loadPreviews()
                await boardStore.loadTasks()
            }
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
                Task {
                    await threadStore.loadThreads()
                    await boardStore.loadTasks()
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .sheet(isPresented: $showNewThread) {
                NewThreadView { thread in
                    navigationPath.append(thread)
                }
            }
            .alert("Delete Thread?", isPresented: Binding(
                get: { threadToDelete != nil },
                set: { if !$0 { threadToDelete = nil } }
            )) {
                Button("Cancel", role: .cancel) { threadToDelete = nil }
                Button("Delete", role: .destructive) {
                    if let thread = threadToDelete {
                        Task {
                            try? await threadStore.deleteThread(id: thread.id)
                            HapticManager.success()
                        }
                    }
                    threadToDelete = nil
                }
            } message: {
                if let thread = threadToDelete {
                    Text("This will archive \"\(thread.title)\". This action cannot be undone.")
                }
            }
        }
    }

}

/// Single thread row in the list with optional last-message preview.
struct ThreadRowView: View {
    let thread: CCThread
    var preview: ThreadPreview?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: "number")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text(thread.title)
                    .font(.body.weight(.medium))
                    .lineLimit(2)
                Spacer()
                Text(thread.relativeTime)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            if let preview {
                HStack(alignment: .top, spacing: 4) {
                    Text(preview.sender + ":")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .layoutPriority(1)
                    Text(preview.content.replacingOccurrences(of: "\n", with: " "))
                        .font(.subheadline)
                        .foregroundStyle(.tertiary)
                        .lineLimit(2)
                }
            } else if let summary = thread.summary, !summary.isEmpty {
                Text(summary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }
}
