import SwiftUI

/// Grid of agent cards for the Team tab.
struct TeamGridView: View {
    @Environment(TeamStore.self) var teamStore
    @Environment(ProjectStore.self) var projectStore

    private let columns = [
        GridItem(.adaptive(minimum: 160), spacing: 12)
    ]

    var body: some View {
        NavigationStack {
            Group {
                if teamStore.isLoading && teamStore.agents.isEmpty {
                    ProgressView("Loading team...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = teamStore.error, teamStore.agents.isEmpty {
                    ContentUnavailableView {
                        Label("Load Failed", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Retry") { Task { await teamStore.loadAgents() } }
                            .buttonStyle(.borderedProminent)
                    }
                } else if teamStore.agents.isEmpty {
                    ContentUnavailableView("No Agents", systemImage: "person.3",
                        description: Text("Agents will appear here when added to the project."))
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 12) {
                            ForEach(teamStore.agents) { agent in
                                NavigationLink(value: agent) {
                                    AgentCardView(agent: agent, metrics: teamStore.agentMetrics[agent.id])
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding()
                    }
                    .refreshable {
                        HapticManager.light()
                        await teamStore.loadAgents()
                    }
                }
            }
            .navigationTitle("Team")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ProjectSelectorView()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Text("\(teamStore.agents.count) agents")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationDestination(for: CCAgent.self) { agent in
                AgentDetailView(agent: agent)
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                StaleBanner(isStale: teamStore.isStale)
            }
            .task {
                await teamStore.loadAgents()
                await teamStore.loadAllMetrics()
            }
            .onReceive(NotificationCenter.default.publisher(for: .projectChanged)) { _ in
                Task { await teamStore.loadAgents() }
            }
        }
    }
}

/// Card for a single agent in the grid.
struct AgentCardView: View {
    let agent: CCAgent
    var metrics: AgentMetrics?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                AgentAvatar(name: agent.name)
                Spacer()
                if let metrics {
                    Circle()
                        .fill(metrics.bridgeStatusColor)
                        .frame(width: 8, height: 8)
                } else {
                    Circle()
                        .fill(agent.statusColor)
                        .frame(width: 8, height: 8)
                }
            }

            Text(agent.name)
                .font(.headline)
                .lineLimit(1)

            Text(agent.role)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            if let metrics {
                Divider()
                VStack(alignment: .leading, spacing: 3) {
                    if let activity = metrics.relativeLastActivity {
                        HStack(spacing: 4) {
                            Image(systemName: "clock")
                                .font(.caption2)
                            Text(activity)
                                .font(.caption2)
                        }
                        .foregroundStyle(.secondary)
                    }
                    if let task = metrics.currentTask {
                        HStack(spacing: 4) {
                            Image(systemName: "bolt.fill")
                                .font(.caption2)
                                .foregroundStyle(.cyan)
                            Text(task.id)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.primary)
                        }
                    }
                }
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 2, y: 1)
    }
}
