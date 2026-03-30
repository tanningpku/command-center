import SwiftUI

/// Board view with expandable sections grouped by task state.
struct BoardView: View {
    @Environment(BoardStore.self) var boardStore
    @Environment(ProjectStore.self) var projectStore
    @State private var selectedTask: CCTask?
    @State private var expandedSections: Set<TaskState> = Set(TaskState.allCases)

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
                } else if boardStore.tasks.isEmpty {
                    ContentUnavailableView("No Tasks", systemImage: "rectangle.split.3x1",
                        description: Text("Tasks will appear here when created."))
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(activeSections, id: \.self) { state in
                                BoardSection(
                                    state: state,
                                    tasks: boardStore.tasksForState(state),
                                    isExpanded: expandedSections.contains(state),
                                    onToggle: { toggleSection(state) },
                                    onSelect: { selectedTask = $0 }
                                )
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
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
                    Text("\(boardStore.tasks.count) tasks")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .sheet(item: $selectedTask) { task in
                TaskDetailSheet(task: task)
            }
            .task { await boardStore.loadTasks() }
            .onReceive(NotificationCenter.default.publisher(for: .projectChanged)) { _ in
                Task { await boardStore.loadTasks() }
            }
        }
    }

    private func toggleSection(_ state: TaskState) {
        withAnimation(.easeInOut(duration: 0.25)) {
            if expandedSections.contains(state) {
                expandedSections.remove(state)
            } else {
                expandedSections.insert(state)
            }
        }
    }
}

/// An expandable section for a task state with a header and task cards.
struct BoardSection: View {
    let state: TaskState
    let tasks: [CCTask]
    let isExpanded: Bool
    let onToggle: () -> Void
    let onSelect: (CCTask) -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Section header
            Button(action: onToggle) {
                HStack(spacing: 10) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 16)

                    Circle()
                        .fill(state.color)
                        .frame(width: 10, height: 10)

                    Text(state.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)

                    Text("\(tasks.count)")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Color(.systemGray5))
                        .clipShape(Capsule())

                    Spacer()
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .buttonStyle(.plain)

            // Task cards
            if isExpanded {
                VStack(spacing: 8) {
                    ForEach(tasks) { task in
                        Button { onSelect(task) } label: {
                            TaskCardView(task: task)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(Color(.systemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
