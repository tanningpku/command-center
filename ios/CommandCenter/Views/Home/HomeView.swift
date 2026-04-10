import SwiftUI

/// Captain-driven Home tab — renders blocks from /api/dashboard.
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
            .onReceive(NotificationCenter.default.publisher(for: .dashboardUpdated)) { _ in
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
        // Captain-driven blocks (new)
        case "brief":          BriefBlockView(block: block)
        case "attention":      AttentionBlockView(block: block)
        case "thread_waiting": ThreadWaitingBlockView(block: block)
        case "recommendation": RecommendationBlockView(block: block)
        case "inflight":       InflightBlockView(block: block)
        case "shipped":        ShippedBlockView(block: block)
        case "team_pulse":     TeamPulseBlockView(block: block)
        case "week_stats":     WeekStatsBlockView(block: block)
        case "empty_well":     EmptyWellBlockView(block: block)
        // Legacy/fallback blocks
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

// MARK: - Captain Brief

struct BriefBlockView: View {
    let block: DashboardBlock

    private var level: String { block.status ?? "healthy" }

    private var accentColor: Color {
        switch level {
        case "critical": .red
        case "warning": .yellow
        default: .green
        }
    }

    private var bgGradient: LinearGradient {
        LinearGradient(
            colors: [accentColor.opacity(0.08), accentColor.opacity(0.03)],
            startPoint: .topLeading, endPoint: .bottomTrailing
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                // Captain avatar
                ZStack {
                    Circle()
                        .fill(accentColor.opacity(0.2))
                        .frame(width: 32, height: 32)
                    Text("C")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(accentColor)
                }
                Text("Captain")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if let subtitle = block.subtitle {
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Text(block.text)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineSpacing(3)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(bgGradient)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(accentColor.opacity(0.15), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Attention items

struct AttentionBlockView: View {
    let block: DashboardBlock

    private var attentionItems: [AttentionItem] {
        (block.items ?? []).compactMap { item in
            guard let obj = item.objectValue else { return nil }
            return AttentionItem(
                category: obj["category"]?.stringValue ?? "blocked",
                taskId: obj["taskId"]?.stringValue,
                title: obj["title"]?.stringValue ?? "",
                context: obj["context"]?.stringValue ?? "",
                assignee: obj["assignee"]?.stringValue,
                age: obj["age"]?.stringValue,
                urgency: obj["urgency"]?.stringValue ?? "warning"
            )
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Section header
            HStack(spacing: 6) {
                Text((block.title ?? "Needs Your Attention").uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
                    .tracking(0.5)
                if !attentionItems.isEmpty {
                    Text("\(attentionItems.count)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(headerCountColor)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(headerCountColor.opacity(0.15))
                        .clipShape(Capsule())
                }
            }
            .padding(.bottom, 2)

            ForEach(attentionItems, id: \.title) { item in
                AttentionCardView(item: item)
            }
        }
    }

    private var headerCountColor: Color {
        let hasUrgent = attentionItems.contains { $0.urgency == "urgent" || $0.category == "blocked" || $0.category == "agent-issue" }
        return hasUrgent ? .red : .yellow
    }
}

private struct AttentionItem {
    let category: String
    let taskId: String?
    let title: String
    let context: String
    let assignee: String?
    let age: String?
    let urgency: String
}

private struct AttentionCardView: View {
    let item: AttentionItem

    private var borderColor: Color {
        switch item.urgency {
        case "urgent": .red
        case "info": .blue
        default: .yellow
        }
    }

    private var badgeColor: Color {
        switch item.category {
        case "blocked", "agent-issue": .red
        case "stale": .yellow
        case "waiting": .blue
        default: .yellow
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Top row: badge + task ID
            HStack(spacing: 8) {
                Text(item.category.replacingOccurrences(of: "-", with: " ").uppercased())
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(badgeColor)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(badgeColor.opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                if let taskId = item.taskId {
                    Text(taskId)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .monospacedDigit()
                }
            }

            // Title
            Text(item.title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)

            // Context
            if !item.context.isEmpty {
                Text(item.context)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }

            // Meta row: assignee + age
            if item.assignee != nil || item.age != nil {
                HStack(spacing: 8) {
                    if let assignee = item.assignee {
                        HStack(spacing: 4) {
                            ZStack {
                                Circle()
                                    .fill(.green.opacity(0.3))
                                    .frame(width: 16, height: 16)
                                Text(String(assignee.prefix(1)).uppercased())
                                    .font(.system(size: 8, weight: .bold))
                                    .foregroundStyle(.white)
                            }
                            Text(assignee)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    if let age = item.age {
                        Text(age)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground))
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(borderColor)
                .frame(width: 3)
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Thread Waiting

struct ThreadWaitingBlockView: View {
    let block: DashboardBlock

    private var threads: [(name: String, preview: String, unread: String, age: String, threadId: String?)] {
        (block.items ?? []).compactMap { item in
            guard let obj = item.objectValue else { return nil }
            return (
                obj["threadName"]?.stringValue ?? "",
                obj["preview"]?.stringValue ?? "",
                obj["unread"]?.stringValue ?? "",
                obj["age"]?.stringValue ?? "",
                obj["threadId"]?.stringValue
            )
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(threads, id: \.name) { thread in
                VStack(alignment: .leading, spacing: 4) {
                    Text(thread.name)
                        .font(.subheadline.weight(.medium))
                    if !thread.preview.isEmpty {
                        Text(thread.preview)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    HStack(spacing: 8) {
                        if !thread.unread.isEmpty {
                            Text(thread.unread)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        if !thread.age.isEmpty {
                            Text(thread.age)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .padding(.top, 2)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemGroupedBackground))
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(.blue)
                        .frame(width: 3)
                }
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
    }
}

// MARK: - Recommendation

struct RecommendationBlockView: View {
    let block: DashboardBlock

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: "arrow.right")
                    .font(.caption2.weight(.bold))
                Text("CAPTAIN RECOMMENDS")
                    .font(.system(size: 10, weight: .bold))
                    .tracking(0.4)
            }
            .foregroundStyle(.blue)

            Text(block.text)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineSpacing(2)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.blue.opacity(0.06))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(.blue.opacity(0.2), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - In-Flight tasks

struct InflightBlockView: View {
    let block: DashboardBlock

    private var tasks: [InflightItem] {
        (block.items ?? []).compactMap { item in
            guard let obj = item.objectValue else { return nil }
            return InflightItem(
                taskId: obj["taskId"]?.stringValue ?? "",
                title: obj["title"]?.stringValue ?? "",
                note: obj["note"]?.stringValue ?? "",
                agent: obj["agent"]?.stringValue ?? "",
                status: obj["status"]?.stringValue ?? "active"
            )
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Section header
            HStack(spacing: 6) {
                Text((block.title ?? "In Flight").uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
                    .tracking(0.5)
                if !tasks.isEmpty {
                    Text("\(tasks.count)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.blue)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(.blue.opacity(0.15))
                        .clipShape(Capsule())
                }
            }
            .padding(.bottom, 2)

            ForEach(tasks, id: \.taskId) { task in
                InflightCardView(item: task)
            }
        }
    }
}

private struct InflightItem {
    let taskId: String
    let title: String
    let note: String
    let agent: String
    let status: String
}

private struct InflightCardView: View {
    let item: InflightItem

    private var dotColor: Color {
        switch item.status {
        case "review": .yellow
        case "qa": .purple
        default: .blue
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            // Pulsing status dot
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)
                .modifier(item.status == "active" ? PulseDotModifier() : PulseDotModifier(enabled: false))

            // Task info
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                if !item.note.isEmpty {
                    Text(item.note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer()

            if !item.agent.isEmpty {
                Text(item.agent)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

private struct PulseDotModifier: ViewModifier {
    var enabled: Bool = true
    @State private var isPulsing = false

    func body(content: Content) -> some View {
        content
            .opacity(enabled && isPulsing ? 0.4 : 1.0)
            .animation(enabled ? .easeInOut(duration: 1.2).repeatForever(autoreverses: true) : nil, value: isPulsing)
            .onAppear { if enabled { isPulsing = true } }
    }
}

// MARK: - Shipped items

struct ShippedBlockView: View {
    let block: DashboardBlock

    private var shippedItems: [(title: String, meta: String)] {
        (block.items ?? []).compactMap { item in
            guard let obj = item.objectValue,
                  let title = obj["title"]?.stringValue else { return nil }
            return (title, obj["meta"]?.stringValue ?? "")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Section header
            HStack(spacing: 6) {
                Text((block.title ?? "Shipped").uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
                    .tracking(0.5)
                if !shippedItems.isEmpty {
                    Text("\(shippedItems.count)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.green)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(.green.opacity(0.15))
                        .clipShape(Capsule())
                }
            }
            .padding(.bottom, 10)

            ForEach(Array(shippedItems.enumerated()), id: \.offset) { idx, item in
                HStack(alignment: .top, spacing: 8) {
                    // Checkmark circle
                    ZStack {
                        Circle()
                            .fill(.green.opacity(0.15))
                            .frame(width: 18, height: 18)
                        Image(systemName: "checkmark")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.green)
                    }
                    .padding(.top, 1)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        if !item.meta.isEmpty {
                            Text(item.meta)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    Spacer()
                }
                .padding(.vertical, 8)
                if idx < shippedItems.count - 1 {
                    Divider()
                }
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Team Pulse (2-column grid)

struct TeamPulseBlockView: View {
    let block: DashboardBlock

    private var agents: [PulseAgent] {
        (block.items ?? []).compactMap { item in
            guard let obj = item.objectValue,
                  let name = obj["name"]?.stringValue else { return nil }
            return PulseAgent(
                name: name,
                initial: obj["initial"]?.stringValue ?? String(name.prefix(1)).uppercased(),
                status: obj["status"]?.stringValue ?? "offline",
                task: obj["task"]?.stringValue ?? "",
                color: obj["color"]?.stringValue
            )
        }
    }

    private let columns = [
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8)
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text((block.title ?? "Team Pulse").uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
                .tracking(0.5)
                .padding(.bottom, 2)

            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(agents, id: \.name) { agent in
                    PulseAgentCard(agent: agent)
                }
            }
        }
    }
}

private struct PulseAgent {
    let name: String
    let initial: String
    let status: String
    let task: String
    let color: String?
}

private struct PulseAgentCard: View {
    let agent: PulseAgent

    private var avatarColor: Color {
        if let hex = agent.color { return Color(hex: hex) }
        switch agent.name.lowercased() {
        case let n where n.contains("backend"): return .green
        case let n where n.contains("frontend"): return .blue
        case let n where n.contains("devtools"): return .purple
        case let n where n.contains("ios"): return .orange
        case let n where n.contains("design"): return .pink
        default: return .green
        }
    }

    private var dotColor: Color {
        switch agent.status {
        case "online", "active": .green
        case "idle": .yellow
        case "error", "crashed": .red
        default: .gray
        }
    }

    var body: some View {
        HStack(spacing: 8) {
            ZStack(alignment: .bottomTrailing) {
                ZStack {
                    Circle()
                        .fill(avatarColor)
                        .frame(width: 28, height: 28)
                    Text(agent.initial)
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.white)
                }
                Circle()
                    .fill(dotColor)
                    .frame(width: 10, height: 10)
                    .overlay(
                        Circle()
                            .stroke(Color(.secondarySystemGroupedBackground), lineWidth: 2)
                    )
                    .offset(x: 2, y: 2)
            }

            VStack(alignment: .leading, spacing: 1) {
                Text(agent.name)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                if !agent.task.isEmpty {
                    Text(agent.task)
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Week Stats (horizontal row)

struct WeekStatsBlockView: View {
    let block: DashboardBlock

    private var stats: [(label: String, value: String, color: Color?)] {
        (block.items ?? []).compactMap { item in
            guard let obj = item.objectValue,
                  let label = obj["label"]?.stringValue,
                  let value = obj["value"]?.displayString else { return nil }
            let color: Color? = {
                switch obj["color"]?.stringValue {
                case "green": return .green
                case "red": return .red
                case "blue": return .blue
                case "yellow": return .yellow
                default: return nil
                }
            }()
            return (label, value, color)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title = block.title {
                Text(title.uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
                    .tracking(0.5)
            }
            HStack(spacing: 8) {
                ForEach(stats, id: \.label) { stat in
                    VStack(spacing: 4) {
                        Text(stat.value)
                            .font(.title2.bold())
                            .foregroundStyle(stat.color ?? .primary)
                        Text(stat.label.uppercased())
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                            .tracking(0.3)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
        }
    }
}

// MARK: - Empty Well

struct EmptyWellBlockView: View {
    let block: DashboardBlock

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "checkmark")
                .font(.title2)
                .foregroundStyle(.green)
            Text(block.text.isEmpty ? "Nothing needs your attention right now" : block.text)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Legacy block views (fallback)

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

struct StatsBlockView: View {
    let block: DashboardBlock

    private var statItems: [(label: String, value: String, trend: String?)] {
        (block.items ?? []).compactMap { item in
            guard let obj = item.objectValue,
                  let label = obj["label"]?.stringValue,
                  let value = obj["value"]?.displayString else { return nil }
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
                    Text("\u{2022}")
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

// MARK: - Hex color extension

private extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let r = Double((int >> 16) & 0xFF) / 255.0
        let g = Double((int >> 8) & 0xFF) / 255.0
        let b = Double(int & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}
