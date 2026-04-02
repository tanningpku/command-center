import SwiftUI

/// Agent detail view showing role, system prompt (identity.md), and KB file browser.
struct AgentDetailView: View {
    let agent: CCAgent
    @Environment(TeamStore.self) var teamStore
    @State private var selectedFile: String?

    private var metrics: AgentMetrics? { teamStore.agentMetrics[agent.id] }

    var body: some View {
        List {
            // Agent info section
            Section {
                HStack(spacing: 12) {
                    AgentAvatar(name: agent.name)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(agent.name)
                            .font(.headline)
                        StatusBadge(text: agent.status, color: agent.statusColor)
                    }
                }

                if !agent.role.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Role")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                        Text(agent.role)
                            .font(.body)
                    }
                }
            }

            // Metrics section
            if let metrics {
                Section("Metrics") {
                    LabeledContent("Bridge") {
                        HStack(spacing: 6) {
                            Circle()
                                .fill(metrics.bridgeStatusColor)
                                .frame(width: 8, height: 8)
                            Text(metrics.bridgeStatus.capitalized)
                                .foregroundStyle(.primary)
                        }
                    }

                    LabeledContent("Uptime", value: metrics.formattedUptime)

                    LabeledContent("Messages", value: "\(metrics.messageCount)")

                    if let activity = metrics.relativeLastActivity {
                        LabeledContent("Last Activity", value: activity)
                    }

                    if let task = metrics.currentTask {
                        LabeledContent("Current Task") {
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(task.id)
                                    .font(.caption.monospaced().weight(.medium))
                                    .foregroundStyle(.cyan)
                                Text(task.title)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
            }

            // System prompt section
            if let content = teamStore.kbContent, selectedFile == "identity.md" {
                Section("System Prompt") {
                    Text(content)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                }
            }

            // KB Files section
            Section("Knowledge Base") {
                if teamStore.isLoadingKB && teamStore.kbFiles.isEmpty {
                    ProgressView()
                } else if teamStore.kbFiles.isEmpty {
                    Text("No KB files")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(teamStore.kbFiles, id: \.self) { file in
                        Button {
                            selectedFile = file
                            Task { await teamStore.loadKBFile(agentId: agent.id, fileName: file) }
                        } label: {
                            HStack {
                                Image(systemName: "doc.text")
                                    .foregroundStyle(.blue)
                                Text(file)
                                    .foregroundStyle(.primary)
                                Spacer()
                                if selectedFile == file && teamStore.isLoadingKB {
                                    ProgressView()
                                        .scaleEffect(0.7)
                                } else if selectedFile == file {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.blue)
                                }
                            }
                        }
                    }
                }
            }

            // KB file content viewer
            if let content = teamStore.kbContent, selectedFile != nil, selectedFile != "identity.md" {
                Section(selectedFile ?? "File") {
                    Text(content)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
        }
        .navigationTitle(agent.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            async let metricsLoad: () = teamStore.loadMetrics(agentId: agent.id)
            async let kbLoad: () = teamStore.loadKBFiles(agentId: agent.id)
            _ = await (metricsLoad, kbLoad)
            // Auto-load identity.md
            if teamStore.kbFiles.contains("identity.md") {
                selectedFile = "identity.md"
                await teamStore.loadKBFile(agentId: agent.id, fileName: "identity.md")
            }
        }
    }
}
