import SwiftUI

/// Auto-aggregated project dashboard — fetches tasks, agents, and threads,
/// then composes dashboard blocks client-side.
struct HomeView: View {
    @Environment(HomeStore.self) var homeStore
    @Environment(ProjectStore.self) var projectStore

    var body: some View {
        NavigationStack {
            Group {
                if homeStore.isLoading && homeStore.blocks.isEmpty {
                    ProgressView("Loading dashboard...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = homeStore.error, homeStore.blocks.isEmpty {
                    ContentUnavailableView {
                        Label("Load Failed", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Retry") { Task { await homeStore.load() } }
                            .buttonStyle(.borderedProminent)
                    }
                } else if homeStore.blocks.isEmpty {
                    ContentUnavailableView("No Data", systemImage: "house",
                        description: Text("No tasks, agents, or threads found for this project."))
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 16) {
                            ForEach(homeStore.blocks) { block in
                                DashboardBlockView(block: block)
                            }
                        }
                        .padding()
                    }
                    .refreshable {
                        HapticManager.light()
                        await homeStore.load()
                    }
                }
            }
            .navigationTitle("Home")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ProjectSelectorView()
                }
                if let updated = homeStore.updatedAt {
                    ToolbarItem(placement: .topBarTrailing) {
                        Text(formatTime(updated))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .task { await homeStore.load() }
            .onReceive(NotificationCenter.default.publisher(for: .projectChanged)) { _ in
                Task { await homeStore.load() }
            }
        }
    }

    private func formatTime(_ iso: String) -> String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fmt.date(from: iso) ?? {
            fmt.formatOptions = [.withInternetDateTime]
            return fmt.date(from: iso)
        }() else { return "" }
        let tf = DateFormatter()
        tf.dateFormat = "h:mm a"
        return tf.string(from: date)
    }
}

// MARK: - Block dispatcher

struct DashboardBlockView: View {
    let block: DashboardBlock

    var body: some View {
        switch block.type {
        case "hero":     HeroBlockView(block: block)
        case "stats":    StatsBlockView(block: block)
        case "alert":    AlertBlockView(block: block)
        case "activity": ActivityBlockView(block: block)
        case "list":     ListBlockView(block: block)
        case "section":  SectionBlockView(block: block)
        case "agents":   AgentsBlockView(block: block)
        default:         EmptyView()
        }
    }
}

// MARK: - Hero block

struct HeroBlockView: View {
    let block: DashboardBlock

    private var statusColor: Color {
        switch block.status ?? "" {
        case "healthy": .green
        case "warning": .yellow
        case "critical": .red
        default: .blue
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let status = block.status {
                Text(status.uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(statusColor)
            }
            if let title = block.title {
                Text(title)
                    .font(.title3.bold())
            }
            if let subtitle = block.subtitle {
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(statusColor)
                .frame(width: 4)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Stats block

struct StatsBlockView: View {
    let block: DashboardBlock

    private var statItems: [(label: String, value: String, trend: String?)] {
        (block.items ?? []).compactMap { item in
            guard let obj = item.objectValue,
                  let label = obj["label"]?.stringValue,
                  let value = obj["value"]?.stringValue else { return nil }
            return (label, value, obj["trend"]?.stringValue)
        }
    }

    private let columns = [GridItem(.adaptive(minimum: 140), spacing: 12)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 12) {
            ForEach(statItems, id: \.label) { item in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(item.value)
                            .font(.title2.bold())
                        if let trend = item.trend {
                            Image(systemName: trendIcon(trend))
                                .font(.caption)
                                .foregroundStyle(trendColor(trend))
                        }
                    }
                    Text(item.label)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    private func trendIcon(_ trend: String) -> String {
        switch trend {
        case "up": "arrow.up.right"
        case "down": "arrow.down.right"
        default: "minus"
        }
    }

    private func trendColor(_ trend: String) -> Color {
        switch trend {
        case "up": .green
        case "down": .red
        default: .secondary
        }
    }
}

// MARK: - Alert block

struct AlertBlockView: View {
    let block: DashboardBlock

    private var alertColor: Color {
        switch block.status ?? "" {
        case "warning": .yellow
        case "critical", "error": .red
        case "info": .blue
        default: .orange
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(alertColor)
            VStack(alignment: .leading, spacing: 2) {
                if let title = block.title {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                }
                if !block.text.isEmpty {
                    Text(block.text)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding()
        .background(alertColor.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Activity block

struct ActivityBlockView: View {
    let block: DashboardBlock

    private var activityItems: [(time: String, actor: String, text: String)] {
        (block.items ?? []).compactMap { item in
            guard let obj = item.objectValue,
                  let text = obj["text"]?.stringValue else { return nil }
            return (obj["time"]?.stringValue ?? "", obj["actor"]?.stringValue ?? "", text)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title = block.title {
                Text(title)
                    .font(.headline)
            }
            ForEach(activityItems, id: \.text) { item in
                HStack(alignment: .top, spacing: 8) {
                    Circle()
                        .fill(.blue)
                        .frame(width: 6, height: 6)
                        .padding(.top, 5)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.text)
                            .font(.subheadline)
                        if !item.time.isEmpty || !item.actor.isEmpty {
                            HStack(spacing: 6) {
                                if !item.actor.isEmpty {
                                    Text(item.actor)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                if !item.time.isEmpty {
                                    Text(item.time)
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                    Spacer()
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - List block

struct ListBlockView: View {
    let block: DashboardBlock

    private var listItems: [String] {
        (block.items ?? []).compactMap { $0.stringValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title = block.title {
                Text(title)
                    .font(.headline)
            }
            ForEach(listItems, id: \.self) { item in
                HStack(alignment: .top, spacing: 8) {
                    Text("•")
                        .foregroundStyle(.secondary)
                    Text(item)
                        .font(.subheadline)
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Section block

struct SectionBlockView: View {
    let block: DashboardBlock

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title = block.title {
                Text(title)
                    .font(.headline)
            }
            if !block.text.isEmpty {
                Text(block.text)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Agents block

struct AgentsBlockView: View {
    let block: DashboardBlock

    private var agentItems: [(name: String, status: String, task: String)] {
        (block.agents ?? []).compactMap { item in
            guard let obj = item.objectValue,
                  let name = obj["name"]?.stringValue ?? obj["id"]?.stringValue else { return nil }
            return (name, obj["status"]?.stringValue ?? "unknown", obj["task"]?.stringValue ?? "")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title = block.title {
                Text(title)
                    .font(.headline)
            }
            ForEach(agentItems, id: \.name) { agent in
                HStack(spacing: 10) {
                    // Avatar circle with initial
                    ZStack {
                        Circle()
                            .fill(agentStatusColor(agent.status).opacity(0.15))
                            .frame(width: 32, height: 32)
                        Text(String(agent.name.prefix(1)).uppercased())
                            .font(.caption.bold())
                            .foregroundStyle(agentStatusColor(agent.status))
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(agent.name)
                            .font(.subheadline.weight(.medium))
                        if !agent.task.isEmpty && agent.task != "\u{2014}" {
                            Text(agent.task)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer()
                    Text(agent.status)
                        .font(.caption)
                        .foregroundStyle(agentStatusColor(agent.status))
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func agentStatusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "active", "online": .green
        case "busy", "working": .orange
        case "idle": .blue
        default: .secondary
        }
    }
}
