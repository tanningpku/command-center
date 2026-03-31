import SwiftUI

/// Detail view for a single bridge with full info and recovery action buttons.
struct BridgeDetailView: View {
    let bridge: BridgeHealth
    @Environment(HealthStore.self) var healthStore

    @State private var showRestartAlert = false
    @State private var showStopAlert = false

    var body: some View {
        List {
            // Status section
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

            // Restart info
            Section("Reliability") {
                LabeledContent("Restart Count", value: "\(bridge.restartCount)")
                if let reason = bridge.lastRestartReason {
                    LabeledContent("Last Restart Reason", value: reason)
                }
            }

            // Technical details
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

            // Actions
            Section("Actions") {
                if bridge.status == .stopped {
                    Button {
                        Task { await healthStore.startBridge(agentId: bridge.agentId) }
                    } label: {
                        Label("Start Bridge", systemImage: "play.circle")
                    }
                    .disabled(healthStore.isPerformingAction)
                } else {
                    Button {
                        showRestartAlert = true
                    } label: {
                        Label("Restart Bridge", systemImage: "arrow.clockwise")
                    }
                    .disabled(healthStore.isPerformingAction)

                    Button(role: .destructive) {
                        showStopAlert = true
                    } label: {
                        Label("Stop Bridge", systemImage: "stop.circle")
                    }
                    .disabled(healthStore.isPerformingAction)
                }
            }
        }
        .navigationTitle(bridge.agentId)
        .navigationBarTitleDisplayMode(.inline)
        .alert("Restart Bridge", isPresented: $showRestartAlert) {
            Button("Cancel", role: .cancel) {}
            Button("Restart", role: .destructive) {
                Task { await healthStore.restartBridge(agentId: bridge.agentId) }
            }
        } message: {
            Text("This will stop and restart the bridge for \(bridge.agentId). The agent will be temporarily disconnected.")
        }
        .alert("Stop Bridge", isPresented: $showStopAlert) {
            Button("Cancel", role: .cancel) {}
            Button("Stop", role: .destructive) {
                Task { await healthStore.stopBridge(agentId: bridge.agentId) }
            }
        } message: {
            Text("This will stop the bridge for \(bridge.agentId). The agent will go offline and will not auto-restart.")
        }
    }
}
