import SwiftUI

/// Task metrics dashboard with stat cards and state breakdown.
struct MetricsView: View {
    @Environment(MetricsStore.self) var metricsStore
    @Environment(ProjectStore.self) var projectStore

    private let columns = [GridItem(.adaptive(minimum: 140), spacing: 12)]

    var body: some View {
        NavigationStack {
            Group {
                if metricsStore.isLoading && metricsStore.tasks.isEmpty {
                    ProgressView("Loading metrics...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = metricsStore.error, metricsStore.tasks.isEmpty {
                    ContentUnavailableView {
                        Label("Load Failed", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Retry") { Task { await metricsStore.load() } }
                            .buttonStyle(.borderedProminent)
                    }
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 20) {
                            // Stat cards
                            LazyVGrid(columns: columns, spacing: 12) {
                                StatCard(title: "Total Tasks", value: "\(metricsStore.totalTasks)", icon: "list.bullet", color: .blue)
                                StatCard(title: "In Progress", value: "\(metricsStore.inProgressCount)", icon: "arrow.right.circle", color: .cyan)
                                StatCard(title: "Blocked", value: "\(metricsStore.blockedCount)", icon: "exclamationmark.triangle", color: .red)
                                StatCard(title: "Done", value: "\(metricsStore.doneCount)", icon: "checkmark.circle", color: .green)
                                StatCard(title: "Threads", value: "\(metricsStore.threadCount)", icon: "bubble.left.and.bubble.right", color: .purple)
                                StatCard(title: "Completion", value: "\(Int(metricsStore.completionRate * 100))%", icon: "chart.bar", color: .orange)
                            }
                            .padding(.horizontal)

                            // State breakdown
                            if !metricsStore.byState.isEmpty {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("Tasks by State")
                                        .font(.headline)
                                        .padding(.horizontal)

                                    VStack(spacing: 4) {
                                        ForEach(metricsStore.byState, id: \.state) { item in
                                            StateBarRow(state: item.state, count: item.count, total: metricsStore.totalTasks)
                                        }
                                    }
                                    .padding(.horizontal)
                                }
                            }

                            // Priority breakdown
                            if !metricsStore.byPriority.isEmpty {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("Tasks by Priority")
                                        .font(.headline)
                                        .padding(.horizontal)

                                    VStack(spacing: 4) {
                                        ForEach(metricsStore.byPriority, id: \.priority) { item in
                                            PriorityBarRow(priority: item.priority, count: item.count, total: metricsStore.totalTasks)
                                        }
                                    }
                                    .padding(.horizontal)
                                }
                            }
                        }
                        .padding(.vertical)
                    }
                    .refreshable {
                        HapticManager.light()
                        await metricsStore.load()
                    }
                }
            }
            .navigationTitle("Metrics")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ProjectSelectorView()
                }
            }
            .task { await metricsStore.load() }
            .onReceive(NotificationCenter.default.publisher(for: .projectChanged)) { _ in
                Task { await metricsStore.load() }
            }
        }
    }
}

/// Stat card with icon, value, and title.
struct StatCard: View {
    let title: String
    let value: String
    let icon: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: icon)
                    .foregroundStyle(color)
                Spacer()
            }
            Text(value)
                .font(.title.bold())
                .foregroundStyle(.primary)
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

/// Horizontal bar showing task state count as proportion.
struct StateBarRow: View {
    let state: TaskState
    let count: Int
    let total: Int

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(state.color)
                .frame(width: 8, height: 8)
            Text(state.displayName)
                .font(.caption)
                .frame(width: 80, alignment: .leading)
            GeometryReader { geo in
                RoundedRectangle(cornerRadius: 3)
                    .fill(state.color.opacity(0.7))
                    .frame(width: total > 0 ? geo.size.width * CGFloat(count) / CGFloat(total) : 0)
            }
            .frame(height: 12)
            Text("\(count)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 24, alignment: .trailing)
        }
        .frame(height: 20)
    }
}

/// Horizontal bar showing task priority count as proportion.
struct PriorityBarRow: View {
    let priority: TaskPriority
    let count: Int
    let total: Int

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(priority.color)
                .frame(width: 8, height: 8)
            Text(priority.rawValue.capitalized)
                .font(.caption)
                .frame(width: 80, alignment: .leading)
            GeometryReader { geo in
                RoundedRectangle(cornerRadius: 3)
                    .fill(priority.color.opacity(0.7))
                    .frame(width: total > 0 ? geo.size.width * CGFloat(count) / CGFloat(total) : 0)
            }
            .frame(height: 12)
            Text("\(count)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 24, alignment: .trailing)
        }
        .frame(height: 20)
    }
}
