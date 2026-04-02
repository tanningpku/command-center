import SwiftUI

/// Board view with expandable sections grouped by task state.
struct BoardView: View {
    @Environment(BoardStore.self) var boardStore
    @Environment(ProjectStore.self) var projectStore
    @Environment(TeamStore.self) var teamStore
    @State private var selectedTask: CCTask?
    @State private var collapsedSections: Set<TaskState> = []
    @State private var showCreateSheet = false
    @State private var showFilterSheet = false

    /// Only show sections that have tasks
    private var activeSections: [TaskState] {
        BoardStore.columns.filter { !boardStore.tasksForState($0).isEmpty }
    }

    var body: some View {
        @Bindable var store = boardStore
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
                    if boardStore.isFiltered {
                        ContentUnavailableView.search(text: boardStore.searchText)
                    } else {
                        ContentUnavailableView("No Tasks", systemImage: "rectangle.split.3x1",
                            description: Text("Tasks will appear here when created."))
                    }
                } else {
                    ScrollView {
                        // Active filter chips
                        if boardStore.isFiltered {
                            BoardFilterChips(boardStore: boardStore)
                                .padding(.horizontal, 16)
                                .padding(.top, 8)
                        }

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
            .searchable(text: $store.searchText, prompt: "Search tasks")
            .onSubmit(of: .search) {
                Task { await boardStore.loadTasks() }
            }
            .onChange(of: boardStore.searchText) { oldValue, newValue in
                // Reload when search is cleared
                if !oldValue.isEmpty && newValue.isEmpty {
                    Task { await boardStore.loadTasks() }
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ProjectSelectorView()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 12) {
                        Button {
                            showFilterSheet = true
                        } label: {
                            Image(systemName: boardStore.isFiltered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                        }
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
            .sheet(isPresented: $showFilterSheet) {
                BoardFilterSheet()
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

/// Horizontal row of active filter chips with tap-to-remove.
struct BoardFilterChips: View {
    let boardStore: BoardStore

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if let priority = boardStore.filterPriority {
                    FilterChip(label: priority.rawValue.capitalized, color: priority.color) {
                        boardStore.filterPriority = nil
                        Task { await boardStore.loadTasks() }
                    }
                }
                if let assignee = boardStore.filterAssignee {
                    FilterChip(label: assignee, color: .blue) {
                        boardStore.filterAssignee = nil
                        Task { await boardStore.loadTasks() }
                    }
                }
                if boardStore.isFiltered {
                    Button {
                        boardStore.clearFilters()
                        Task { await boardStore.loadTasks() }
                    } label: {
                        Text("Clear all")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

struct FilterChip: View {
    let label: String
    let color: Color
    let onRemove: () -> Void

    var body: some View {
        Button(action: onRemove) {
            HStack(spacing: 4) {
                Text(label)
                    .font(.caption.weight(.medium))
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
            }
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
        }
    }
}

/// Sheet for selecting priority and assignee filters.
struct BoardFilterSheet: View {
    @Environment(BoardStore.self) var boardStore
    @Environment(TeamStore.self) var teamStore
    @Environment(\.dismiss) var dismiss

    @State private var selectedPriority: TaskPriority?
    @State private var selectedAssignee: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Priority") {
                    Picker("Priority", selection: $selectedPriority) {
                        Text("Any").tag(nil as TaskPriority?)
                        ForEach([TaskPriority.critical, .high, .medium, .normal, .low], id: \.self) { p in
                            HStack(spacing: 6) {
                                Circle().fill(p.color).frame(width: 8, height: 8)
                                Text(p.rawValue.capitalized)
                            }
                            .tag(p as TaskPriority?)
                        }
                    }
                    .pickerStyle(.menu)
                }

                Section("Assignee") {
                    if teamStore.agents.isEmpty {
                        Text("Loading agents...")
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Assignee", selection: $selectedAssignee) {
                            Text("Anyone").tag(nil as String?)
                            ForEach(teamStore.agents) { agent in
                                Text(agent.name).tag(agent.id as String?)
                            }
                        }
                        .pickerStyle(.menu)
                    }
                }
            }
            .navigationTitle("Filters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") { applyFilters() }
                        .bold()
                }
            }
            .onAppear {
                selectedPriority = boardStore.filterPriority
                selectedAssignee = boardStore.filterAssignee
            }
            .task {
                if teamStore.agents.isEmpty {
                    await teamStore.loadAgents()
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func applyFilters() {
        boardStore.filterPriority = selectedPriority
        boardStore.filterAssignee = selectedAssignee
        dismiss()
        Task { await boardStore.loadTasks() }
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
