import SwiftUI

/// Board view with expandable sections grouped by task state.
struct BoardView: View {
    @Environment(BoardStore.self) var boardStore
    @Environment(ProjectStore.self) var projectStore
    @State private var selectedTask: CCTask?
    @State private var collapsedSections: Set<TaskState> = []
    @State private var showCreateSheet = false

    /// Only show sections that have tasks
    private var activeSections: [TaskState] {
        BoardStore.columns.filter { !boardStore.tasksForState($0).isEmpty }
    }

    var body: some View {
        NavigationStack {
            Group {
                if boardStore.isLoading && boardStore.tasks.isEmpty {
                    ProgressView("Loading board...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = boardStore.error, boardStore.tasks.isEmpty {
                    ContentUnavailableView {
                        Label("Load Failed", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Retry") { Task { await boardStore.loadTasks() } }
                            .buttonStyle(.borderedProminent)
                    }
                } else if boardStore.tasks.isEmpty {
                    ContentUnavailableView("No Tasks", systemImage: "rectangle.split.3x1",
                        description: Text("Tasks will appear here when created."))
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0, pinnedViews: .sectionHeaders) {
                            ForEach(activeSections, id: \.self) { state in
                                let tasks = boardStore.tasksForState(state)
                                let isExpanded = !collapsedSections.contains(state)

                                Section {
                                    if isExpanded {
                                        ForEach(tasks) { task in
                                            Button { selectedTask = task } label: {
                                                BoardTaskCard(task: task)
                                            }
                                            .buttonStyle(.plain)
                                            .padding(.horizontal, 16)
                                            .padding(.top, 8)
                                        }
                                        .padding(.bottom, 4)
                                    }
                                } header: {
                                    BoardSectionHeader(
                                        state: state,
                                        count: tasks.count,
                                        isExpanded: isExpanded,
                                        onToggle: { toggleSection(state) }
                                    )
                                }
                            }
                        }
                    }
                    .refreshable {
                        HapticManager.light()
                        await boardStore.loadTasks()
                    }
                }
            }
            .navigationTitle("Board")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ProjectSelectorView()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 12) {
                        Text("\(boardStore.tasks.count) tasks")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button {
                            showCreateSheet = true
                        } label: {
                            Image(systemName: "plus")
                        }
                    }
                }
            }
            .sheet(item: $selectedTask) { task in
                TaskDetailSheet(task: task)
            }
            .sheet(isPresented: $showCreateSheet) {
                CreateTaskSheet()
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                StaleBanner(isStale: boardStore.isStale)
            }
            .task { await boardStore.loadTasks() }
            .onReceive(NotificationCenter.default.publisher(for: .projectChanged)) { _ in
                Task { await boardStore.loadTasks() }
            }
        }
    }

    private func toggleSection(_ state: TaskState) {
        withAnimation(.easeInOut(duration: 0.25)) {
            if collapsedSections.contains(state) {
                collapsedSections.remove(state)
            } else {
                collapsedSections.insert(state)
            }
        }
    }
}

/// Sticky section header for a board state group.
struct BoardSectionHeader: View {
    let state: TaskState
    let count: Int
    let isExpanded: Bool
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 10) {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(state.color)
                    .frame(width: 16)

                Circle()
                    .fill(state.color)
                    .frame(width: 10, height: 10)

                Text(state.displayName.uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.primary)
                    .tracking(0.5)

                Text("\(count)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(state.color)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(state.color.opacity(0.15))
                    .clipShape(Capsule())

                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.bar)
        }
        .buttonStyle(.plain)
    }
}

/// Improved task card with colored accent and better hierarchy.
struct BoardTaskCard: View {
    let task: CCTask

    var body: some View {
        HStack(spacing: 0) {
            // Colored accent bar
            RoundedRectangle(cornerRadius: 2)
                .fill(task.state.color)
                .frame(width: 4)
                .padding(.vertical, 6)

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top) {
                    Text(task.id)
                        .font(.caption2.monospaced().weight(.medium))
                        .foregroundStyle(task.state.color)

                    Spacer()

                    Text(task.priority.rawValue.capitalized)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(task.priority.color)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(task.priority.color.opacity(0.12))
                        .clipShape(Capsule())
                }

                Text(task.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(2)
                    .foregroundStyle(.primary)

                HStack(spacing: 12) {
                    if let assignee = task.assignee {
                        HStack(spacing: 4) {
                            Image(systemName: "person.fill")
                                .font(.caption2)
                            Text(assignee)
                                .font(.caption)
                        }
                        .foregroundStyle(.secondary)
                    }

                    if let update = task.latestUpdate, !update.isEmpty {
                        Text(update)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
