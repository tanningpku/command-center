import SwiftUI

/// Captain-driven dashboard — fetches curated blocks from GET /api/dashboard,
/// falls back to client-side composition if the dashboard is empty.
@MainActor
@Observable
class HomeStore {
    var blocks: [DashboardBlock] = []
    var updatedAt: String?
    var isLoading = false
    var error: String?

    private let api: APIService

    init(api: APIService) {
        self.api = api
    }

    func load() async {
        isLoading = true
        error = nil
        do {
            // Try captain-driven dashboard first
            let dashboard = try await api.fetchDashboard()
            if let captainBlocks = dashboard.blocks, !captainBlocks.isEmpty {
                blocks = captainBlocks
                updatedAt = dashboard.updatedAt
            } else {
                // Fallback: compose blocks client-side from raw data
                await loadFallback()
            }
        } catch {
            // Dashboard endpoint failed — try fallback
            do {
                await loadFallback()
            } catch let fallbackError {
                if let apiError = fallbackError as? APIError {
                    self.error = apiError.errorDescription
                } else {
                    self.error = fallbackError.localizedDescription
                }
            }
        }
        isLoading = false
    }

    private func loadFallback() async {
        do {
            async let tasksReq = api.fetchTasks()
            async let agentsReq = api.fetchAgents()
            async let threadsReq = api.fetchThreads()

            let (tasksResp, agentsResp, threadsResp) = try await (tasksReq, agentsReq, threadsReq)

            blocks = buildBlocks(
                tasks: tasksResp.tasks,
                agents: agentsResp.agents,
                threads: threadsResp.threads
            )
            updatedAt = ISO8601DateFormatter().string(from: Date())
        } catch {
            throw error
        }
    }

    // MARK: - Fallback block composition

    private func buildBlocks(tasks: [CCTask], agents: [CCAgent], threads: [CCThread]) -> [DashboardBlock] {
        var result: [DashboardBlock] = []

        let inProgress = tasks.filter { $0.state == .in_progress }
        let blocked = tasks.filter { $0.state == .blocked }
        let done = tasks.filter { $0.state == .done }
        let inReview = tasks.filter { $0.state == .in_review }
        let activeAgents = agents.filter { $0.status == "active" || $0.status == "running" }

        // 1. Hero — project health
        result.append(buildHeroBlock(
            total: tasks.count, inProgress: inProgress.count,
            blocked: blocked.count, done: done.count
        ))

        // 2. Stats grid
        result.append(buildStatsBlock(
            inProgress: inProgress.count, blocked: blocked.count,
            done: done.count, inReview: inReview.count,
            activeAgents: activeAgents.count
        ))

        // 3. Blocked alert (only if blocked tasks exist)
        if !blocked.isEmpty {
            result.append(buildBlockedAlert(blocked))
        }

        // 4. Active work list
        if !inProgress.isEmpty {
            result.append(buildActiveWorkBlock(inProgress))
        }

        // 5. Agent status cards (exclude archived)
        let visibleAgents = agents.filter { $0.status != "archived" }
        if !visibleAgents.isEmpty {
            result.append(buildAgentsBlock(visibleAgents))
        }

        // 6. Recent activity from threads (sort by parsed date)
        let recentThreads = threads
            .sorted { parseISO8601($0.updatedAt) > parseISO8601($1.updatedAt) }
            .prefix(8)
        if !recentThreads.isEmpty {
            result.append(buildActivityBlock(Array(recentThreads)))
        }

        return result
    }

    private func buildHeroBlock(total: Int, inProgress: Int, blocked: Int, done: Int) -> DashboardBlock {
        let status: String
        let subtitle: String

        if total == 0 {
            status = "healthy"
            subtitle = "No tasks yet"
        } else if blocked > 0 {
            status = "warning"
            subtitle = "\(blocked) blocked — \(inProgress) active, \(done) complete"
        } else {
            status = "healthy"
            subtitle = "\(inProgress) active, \(done) complete of \(total) total"
        }

        return DashboardBlock(
            type: "hero",
            title: "Project Health",
            subtitle: subtitle,
            status: status
        )
    }

    private func buildStatsBlock(inProgress: Int, blocked: Int, done: Int, inReview: Int, activeAgents: Int) -> DashboardBlock {
        let items: [JSONValue] = [
            .object([
                "label": .string("In Progress"),
                "value": .string("\(inProgress)")
            ]),
            .object([
                "label": .string("In Review"),
                "value": .string("\(inReview)")
            ]),
            .object([
                "label": .string("Blocked"),
                "value": .string("\(blocked)"),
                "trend": .string(blocked > 0 ? "down" : "flat")
            ]),
            .object([
                "label": .string("Done"),
                "value": .string("\(done)")
            ]),
            .object([
                "label": .string("Active Agents"),
                "value": .string("\(activeAgents)")
            ]),
        ]
        return DashboardBlock(type: "stats", items: items)
    }

    private func buildBlockedAlert(_ blocked: [CCTask]) -> DashboardBlock {
        let descriptions = blocked.map { task in
            let assignee = task.assignee ?? "unassigned"
            return "\(task.id): \(task.title) (\(assignee))"
        }
        return DashboardBlock(
            type: "alert",
            title: "\(blocked.count) Blocked Task\(blocked.count == 1 ? "" : "s")",
            status: "warning",
            body: descriptions.joined(separator: "\n")
        )
    }

    private func buildActiveWorkBlock(_ inProgress: [CCTask]) -> DashboardBlock {
        let items: [JSONValue] = inProgress.map { task in
            let assignee = task.assignee ?? "unassigned"
            return .string("\(task.title) — \(assignee)")
        }
        return DashboardBlock(type: "list", title: "Active Work", items: items)
    }

    private func buildAgentsBlock(_ agents: [CCAgent]) -> DashboardBlock {
        let agentItems: [JSONValue] = agents.map { agent in
            .object([
                "name": .string(agent.name),
                "status": .string(agent.status),
                "id": .string(agent.id)
            ])
        }
        return DashboardBlock(type: "agents", title: "Team", agents: agentItems)
    }

    private func buildActivityBlock(_ threads: [CCThread]) -> DashboardBlock {
        let items: [JSONValue] = threads.map { thread in
            .object([
                "text": .string(thread.title),
                "time": .string(thread.relativeTime)
            ])
        }
        return DashboardBlock(type: "activity", title: "Recent Activity", items: items)
    }

    private func parseISO8601(_ string: String) -> Date {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fmt.date(from: string) { return date }
        fmt.formatOptions = [.withInternetDateTime]
        return fmt.date(from: string) ?? .distantPast
    }
}
