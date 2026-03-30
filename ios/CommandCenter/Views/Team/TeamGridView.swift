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
                } else if teamStore.agents.isEmpty {
                    ContentUnavailableView("No Agents", systemImage: "person.3",
                        description: Text("Agents will appear here when added to the project."))
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 12) {
                            ForEach(teamStore.agents) { agent in
                                NavigationLink(value: agent) {
                                    AgentCardView(agent: agent)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding()
                    }
                    .refreshable { await teamStore.loadAgents() }
                }
            }
            .navigationTitle("Team")
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
            .task { await teamStore.loadAgents() }
            .onReceive(NotificationCenter.default.publisher(for: .projectChanged)) { _ in
                Task { await teamStore.loadAgents() }
            }
        }
    }
}

/// Card for a single agent in the grid.
struct AgentCardView: View {
    let agent: CCAgent

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                AgentAvatar(name: agent.name)
                Spacer()
                Circle()
                    .fill(agent.statusColor)
                    .frame(width: 8, height: 8)
            }

            Text(agent.name)
                .font(.headline)
                .lineLimit(1)

            Text(agent.role)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 2, y: 1)
    }
}
