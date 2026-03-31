import SwiftUI

/// Main Health tab view showing system status, bridges, stores, and recovery actions.
struct HealthView: View {
    @Environment(HealthStore.self) var healthStore
    @Environment(ProjectStore.self) var projectStore

    @State private var showRestartGatewayAlert = false
    @State private var showCleanupAlert = false

    var body: some View {
        NavigationStack {
            Group {
                if healthStore.isLoading && healthStore.healthData == nil {
                    ProgressView("Loading health data...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = healthStore.error, healthStore.healthData == nil {
                    ContentUnavailableView {
                        Label("Health Unavailable", systemImage: "heart.slash")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Retry") { Task { await healthStore.loadHealth() } }
                            .buttonStyle(.borderedProminent)
                    }
                } else if let data = healthStore.healthData {
                    ScrollView {
                        VStack(spacing: 16) {
                            SystemStatusCard(data: data)
                            BridgeListSection(
                                bridges: healthStore.bridges(projectId: projectStore.selectedId)
                            )
                            StoreStatusSection(
                                stores: healthStore.stores(projectId: projectStore.selectedId)
                            )
                            SSEStatusCard(sse: data.sse)
                            RecoveryActionsSection(
                                showRestartGateway: $showRestartGatewayAlert,
                                showCleanup: $showCleanupAlert
                            )
                        }
                        .padding()
                    }
                    .refreshable {
                        HapticManager.light()
                        await healthStore.loadHealth()
                    }
                } else {
                    ContentUnavailableView("No Data", systemImage: "heart.slash",
                        description: Text("Health data is not available yet."))
                }
            }
            .navigationTitle("Health")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ProjectSelectorView()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if healthStore.isPerformingAction {
                        ProgressView()
                            .controlSize(.small)
                    } else if let data = healthStore.healthData {
                        Image(systemName: data.status.icon)
                            .foregroundStyle(data.status.color)
                    }
                }
            }
            .alert("Restart Gateway", isPresented: $showRestartGatewayAlert) {
                Button("Cancel", role: .cancel) {}
                Button("Restart", role: .destructive) {
                    Task { await healthStore.restartGateway() }
                }
            } message: {
                Text("This will restart the entire gateway process. All bridges will disconnect and reconnect. Are you sure?")
            }
            .alert("Clean Up Stale Processes", isPresented: $showCleanupAlert) {
                Button("Cancel", role: .cancel) {}
                Button("Clean Up", role: .destructive) {
                    Task { await healthStore.cleanupStale() }
                }
            } message: {
                Text("This will kill any orphaned claude processes that are no longer managed by the gateway.")
            }
            .overlay(alignment: .bottom) {
                if let result = healthStore.actionResult {
                    ActionResultBanner(text: result)
                }
            }
            .onAppear { healthStore.startPolling() }
            .onDisappear { healthStore.stopPolling() }
            .onReceive(NotificationCenter.default.publisher(for: .projectChanged)) { _ in
                Task { await healthStore.loadHealth() }
            }
        }
    }
}

// MARK: - System Status Card

private struct SystemStatusCard: View {
    let data: HealthData

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Image(systemName: data.status.icon)
                    .font(.title2)
                    .foregroundStyle(data.status.color)
                Text(data.status.displayName)
                    .font(.title2.bold())
                    .foregroundStyle(data.status.color)
                Spacer()
            }

            HStack(spacing: 20) {
                StatItem(label: "Uptime", value: data.formattedUptime)
                StatItem(label: "Memory", value: "\(Int(data.memory.rssMb))MB")
                StatItem(label: "Heap", value: "\(Int(data.memory.heapUsedMb))/\(Int(data.memory.heapTotalMb))MB")
                StatItem(label: "Errors/hr", value: "\(data.errorsLastHour)")
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

private struct StatItem: View {
    let label: String
    let value: String

    var body: some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.subheadline.bold().monospacedDigit())
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Bridge List Section

private struct BridgeListSection: View {
    let bridges: [BridgeHealth]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Bridges")
                .font(.headline)
                .padding(.horizontal, 4)

            if bridges.isEmpty {
                Text("No bridges found")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 12)
            } else {
                ForEach(bridges) { bridge in
                    NavigationLink(value: bridge) {
                        BridgeRowView(bridge: bridge)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .navigationDestination(for: BridgeHealth.self) { bridge in
            BridgeDetailView(bridge: bridge)
        }
    }
}

private struct BridgeRowView: View {
    let bridge: BridgeHealth

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: bridge.status.icon)
                .foregroundStyle(bridge.status.color)
                .font(.title3)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 2) {
                Text(bridge.agentId)
                    .font(.subheadline.bold())
                HStack(spacing: 8) {
                    StatusBadge(text: bridge.status.displayName, color: bridge.status.color)
                    Text("uptime \(bridge.formattedUptime)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if bridge.restartCount > 0 {
                        Text("\(bridge.restartCount) restart\(bridge.restartCount == 1 ? "" : "s")")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer()

            if let ago = bridge.lastActivityAgo {
                Text(ago)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Store Status Section

private struct StoreStatusSection: View {
    let stores: [StoreHealth]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Stores")
                .font(.headline)
                .padding(.horizontal, 4)

            if stores.isEmpty {
                Text("No store info available")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 12)
            } else {
                HStack(spacing: 8) {
                    ForEach(stores) { store in
                        StoreCard(store: store)
                    }
                }
            }
        }
    }
}

private struct StoreCard: View {
    let store: StoreHealth

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: store.ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                .foregroundStyle(store.ok ? .green : .red)
            Text(store.name)
                .font(.caption.bold())
            Text("\(store.sizeKb)KB")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - SSE Status Card

private struct SSEStatusCard: View {
    let sse: SSEInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("SSE")
                .font(.headline)
                .padding(.horizontal, 4)

            HStack(spacing: 20) {
                StatItem(label: "Clients", value: "\(sse.connectedClients)")
                StatItem(label: "Buffer", value: "\(sse.bufferSize)/\(sse.bufferCapacity)")
            }
            .padding()
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }
}

// MARK: - Recovery Actions Section

private struct RecoveryActionsSection: View {
    @Environment(HealthStore.self) var healthStore
    @Binding var showRestartGateway: Bool
    @Binding var showCleanup: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Actions")
                .font(.headline)
                .padding(.horizontal, 4)

            HStack(spacing: 12) {
                Button {
                    showCleanup = true
                } label: {
                    Label("Clean Up Stale", systemImage: "trash")
                        .font(.subheadline)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(healthStore.isPerformingAction)

                Button {
                    showRestartGateway = true
                } label: {
                    Label("Restart Gateway", systemImage: "arrow.clockwise")
                        .font(.subheadline)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .disabled(healthStore.isPerformingAction)
            }
        }
    }
}

// MARK: - Action Result Banner

private struct ActionResultBanner: View {
    let text: String
    @State private var isVisible = true

    var body: some View {
        if isVisible {
            Text(text)
                .font(.subheadline)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.ultraThinMaterial)
                .clipShape(Capsule())
                .shadow(radius: 4)
                .padding(.bottom, 8)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .onAppear {
                    Task {
                        try? await Task.sleep(for: .seconds(3))
                        withAnimation { isVisible = false }
                    }
                }
        }
    }
}
