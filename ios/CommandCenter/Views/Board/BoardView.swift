import SwiftUI

/// Kanban board with horizontal-scrolling columns grouped by task state.
struct BoardView: View {
    @Environment(BoardStore.self) var boardStore
    @Environment(ProjectStore.self) var projectStore
    @State private var selectedTask: CCTask?

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
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(alignment: .top, spacing: 12) {
                            ForEach(BoardStore.columns, id: \.self) { state in
                                let tasks = boardStore.tasksForState(state)
                                KanbanColumn(state: state, tasks: tasks, onSelect: { selectedTask = $0 })
                            }
                        }
                        .padding()
                    }
                    .refreshable { await boardStore.loadTasks() }
                }
            }
            .navigationTitle("Board")
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
}

/// A single kanban column for a task state.
struct KanbanColumn: View {
    let state: TaskState
    let tasks: [CCTask]
    let onSelect: (CCTask) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Column header
            HStack {
                Circle()
                    .fill(state.color)
                    .frame(width: 8, height: 8)
                Text(state.displayName)
                    .font(.subheadline.weight(.semibold))
                Text("\(tasks.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color(.systemGray5))
                    .clipShape(Capsule())
            }
            .padding(.horizontal, 4)

            // Task cards
            if tasks.isEmpty {
                Text("No tasks")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
            } else {
                ForEach(tasks) { task in
                    Button { onSelect(task) } label: {
                        TaskCardView(task: task)
                    }
                    .buttonStyle(.plain)
                }
            }

            Spacer()
        }
        .frame(width: 220)
        .padding(8)
        .background(Color(.systemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
