import SwiftUI

/// CI builds and open PRs view.
struct OpsView: View {
    @Environment(OpsStore.self) var opsStore
    @Environment(ProjectStore.self) var projectStore

    var body: some View {
        NavigationStack {
            Group {
                if opsStore.isLoading && opsStore.builds.isEmpty && opsStore.pulls.isEmpty {
                    ProgressView("Loading ops...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = opsStore.error, opsStore.builds.isEmpty && opsStore.pulls.isEmpty {
                    ContentUnavailableView {
                        Label("Load Failed", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Retry") { Task { await opsStore.load() } }
                            .buttonStyle(.borderedProminent)
                    }
                } else if opsStore.builds.isEmpty && opsStore.pulls.isEmpty {
                    ContentUnavailableView("No CI Data", systemImage: "gearshape.2",
                        description: Text("CI builds and PRs will appear here when a GitHub repo is configured."))
                } else {
                    List {
                        if !opsStore.builds.isEmpty {
                            Section("CI Builds") {
                                ForEach(opsStore.builds) { build in
                                    BuildRowView(build: build)
                                }
                            }
                        }

                        if !opsStore.pulls.isEmpty {
                            Section("Pull Requests") {
                                ForEach(opsStore.pulls) { pr in
                                    PRRowView(pr: pr)
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                    .refreshable {
                        HapticManager.light()
                        await opsStore.load()
                    }
                }
            }
            .navigationTitle("Ops")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ProjectSelectorView()
                }
                if let updated = opsStore.lastUpdated {
                    ToolbarItem(placement: .topBarTrailing) {
                        Text("Updated \(formatTime(updated))")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .task { await opsStore.load() }
            .onReceive(NotificationCenter.default.publisher(for: .projectChanged)) { _ in
                Task { await opsStore.load() }
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

/// CI build row with status icon, name, branch, duration.
struct BuildRowView: View {
    let build: CIBuild

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: build.statusIcon)
                .foregroundStyle(build.statusColor)
                .font(.title3)

            VStack(alignment: .leading, spacing: 2) {
                Text(build.name)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                HStack(spacing: 8) {
                    if !build.branch.isEmpty {
                        Label(build.branch, systemImage: "arrow.triangle.branch")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let duration = build.duration {
                        Text(duration)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            Spacer()

            Text(build.conclusion ?? build.status)
                .font(.caption.weight(.medium))
                .foregroundStyle(build.statusColor)
        }
        .padding(.vertical, 2)
    }
}

/// Pull request row with number, title, author, state.
struct PRRowView: View {
    let pr: PullRequest

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.triangle.pull")
                .foregroundStyle(pr.stateColor)
                .font(.title3)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text("#\(pr.number)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(pr.title)
                        .font(.body)
                        .lineLimit(1)
                }
                HStack(spacing: 8) {
                    if !pr.author.isEmpty {
                        Label(pr.author, systemImage: "person")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if !pr.branch.isEmpty {
                        Label(pr.branch, systemImage: "arrow.triangle.branch")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            Spacer()

            StatusBadge(text: pr.state, color: pr.stateColor)
        }
        .padding(.vertical, 2)
    }
}
