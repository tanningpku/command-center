import SwiftUI

/// Detail view for a single bridge with full info and recovery action buttons.
/// Derives live bridge data from HealthStore so it updates after actions/polls.
struct BridgeDetailView: View {
    let agentId: String
    @Environment(HealthStore.self) var healthStore
    @Environment(ProjectStore.self) var projectStore

    @State private var confirmAction: BridgeAction?

    private enum BridgeAction: Identifiable {
        case restart, stop
        var id: String {
            switch self {
            case .restart: "restart"
            case .stop: "stop"
            }
        }
    }

    /// Live bridge from the store, or nil if not found
    private var bridge: BridgeHealth? {
        healthStore.bridges(projectId: projectStore.selectedId)
            .first { $0.agentId == agentId }
    }

    var body: some View {
        Group {
            if let bridge {
                List {
                    Section("Status") {
                        LabeledContent("Status") {
                            HStack(spacing: 6) {
                                Image(systemName: bridge.status.icon)
                                    .foregroundStyle(bridge.status.color)
                                Text(bridge.status.displayName)
                                    .foregroundStyle(bridge.status.color)
                            }
                        }
                        LabeledContent("Ready", value: bridge.ready ? "Yes" : "No")
                        LabeledContent("Uptime", value: bridge.formattedUptime)
                        if let ago = bridge.lastActivityAgo {
                            LabeledContent("Last Activity", value: ago)
                        }
                    }

                    Section("Reliability") {
                        LabeledContent("Restart Count", value: "\(bridge.restartCount)")
                        if let reason = bridge.lastRestartReason {
                            LabeledContent("Last Restart Reason", value: reason)
                        }
                    }

                    Section("Details") {
                        if let pid = bridge.pid {
                            LabeledContent("PID", value: "\(pid)")
                        }
                        if let wsPort = bridge.wsPort {
                            LabeledContent("WS Port", value: "\(wsPort)")
                        }
                        if !bridge.startedAt.isEmpty {
                            LabeledContent("Started At", value: bridge.startedAt)
                        }
                        if let lastActivity = bridge.lastActivityAt {
                            LabeledContent("Last Activity At", value: lastActivity)
                        }
                    }

                    Section("Actions") {
                        if bridge.status == .stopped {
                            Button {
                                Task { await healthStore.startBridge(agentId: agentId) }
                            } label: {
                                Label("Start Bridge", systemImage: "play.circle")
                            }
                            .disabled(healthStore.isPerformingAction)
                        } else {
                            Button {
                                confirmAction = .restart
                            } label: {
                                Label("Restart Bridge", systemImage: "arrow.clockwise")
                            }
                            .disabled(healthStore.isPerformingAction)

                            Button(role: .destructive) {
                                confirmAction = .stop
                            } label: {
                                Label("Stop Bridge", systemImage: "stop.circle")
                            }
                            .disabled(healthStore.isPerformingAction)
                        }
                    }
                }
            } else {
                ContentUnavailableView("Bridge Not Found",
                    systemImage: "questionmark.circle",
                    description: Text("\(agentId) is no longer available."))
            }
        }
        .navigationTitle(agentId)
        .navigationBarTitleDisplayMode(.inline)
        .alert(item: $confirmAction) { action in
            switch action {
            case .restart:
                Alert(
                    title: Text("Restart Bridge"),
                    message: Text("This will stop and restart the bridge for \(agentId). The agent will be temporarily disconnected."),
                    primaryButton: .destructive(Text("Restart")) {
                        Task { await healthStore.restartBridge(agentId: agentId) }
                    },
                    secondaryButton: .cancel()
                )
            case .stop:
                Alert(
                    title: Text("Stop Bridge"),
                    message: Text("This will stop the bridge for \(agentId). The agent will go offline and will not auto-restart."),
                    primaryButton: .destructive(Text("Stop")) {
                        Task { await healthStore.stopBridge(agentId: agentId) }
                    },
                    secondaryButton: .cancel()
                )
            }
        }
    }
}
