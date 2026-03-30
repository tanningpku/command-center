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
                } else if threadStore.threads.isEmpty {
                    ContentUnavailableView("No Threads", systemImage: "bubble.left.and.bubble.right",
                        description: Text("Threads will appear here when agents start working."))
                } else {
                    List {
                        // Active threads
                        ForEach(activeThreads) { thread in
                            threadRow(thread)
                        }

                        // Completed section
                        if !completedThreads.isEmpty {
                            Section {
                                if showCompleted {
                                    ForEach(completedThreads) { thread in
                                        threadRow(thread)
                                            .opacity(0.6)
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
                                    .foregroundStyle(.secondary)
                                    .textCase(nil)
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                    .refreshable {
                        await threadStore.loadThreads()
                        await boardStore.loadTasks()
                    }
                }
            }
            .navigationTitle("Threads")
            .navigationBarTitleDisplayMode(.inline)
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
            .task {
                await threadStore.loadThreads()
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
        }
    }

    private func threadRow(_ thread: CCThread) -> some View {
        ThreadRowView(thread: thread)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { navigationPath.append(thread) }
            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
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
        .padding(.vertical, 2)
    }
}
