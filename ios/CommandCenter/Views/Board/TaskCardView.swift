import SwiftUI

/// Compact task card for the kanban board.
struct TaskCardView: View {
    let task: CCTask

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(task.id)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                StatusBadge(text: task.priority.rawValue, color: task.priority.color)
            }

            Text(task.title)
                .font(.subheadline.weight(.medium))
                .lineLimit(2)
                .foregroundStyle(.primary)

            if let assignee = task.assignee {
                HStack(spacing: 4) {
                    Image(systemName: "person")
                        .font(.caption2)
                    Text(assignee)
                        .font(.caption)
                }
                .foregroundStyle(.secondary)
            }

            if let update = task.latestUpdate, !update.isEmpty {
                Text(update)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .padding(10)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .shadow(color: .black.opacity(0.04), radius: 1, y: 1)
    }
}

/// Full task detail shown in a sheet.
struct TaskDetailSheet: View {
    let task: CCTask
    @Environment(\.dismiss) var dismiss
    @Environment(NavigationRouter.self) var router
    @Environment(BoardStore.self) var boardStore

    @State private var isUpdating = false
    @State private var updateError: String?

    /// Logical next states based on current state
    private var availableTransitions: [TaskState] {
        switch task.state {
        case .created: [.assigned, .cancelled]
        case .assigned: [.in_progress, .blocked, .cancelled]
        case .in_progress: [.in_review, .blocked, .cancelled]
        case .in_review: [.qa, .in_progress, .cancelled]
        case .qa: [.done, .in_progress, .cancelled]
        case .blocked: [.in_progress, .cancelled]
        case .done: [.in_progress]
        case .cancelled: [.created]
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("ID", value: task.id)
                    LabeledContent("State") {
                        StatusBadge(text: task.state.displayName, color: task.state.color)
                    }
                    LabeledContent("Priority") {
                        StatusBadge(text: task.priority.rawValue, color: task.priority.color)
                    }
                    if let assignee = task.assignee {
                        LabeledContent("Assignee", value: assignee)
                    }
                    LabeledContent("Created by", value: task.createdBy)
                }

                if !availableTransitions.isEmpty {
                    Section("Change State") {
                        if isUpdating {
                            HStack {
                                Spacer()
                                ProgressView("Updating...")
                                Spacer()
                            }
                        } else {
                            ForEach(availableTransitions, id: \.self) { newState in
                                Button {
                                    transitionTo(newState)
                                } label: {
                                    HStack(spacing: 8) {
                                        Circle()
                                            .fill(newState.color)
                                            .frame(width: 10, height: 10)
                                        Text(newState.displayName)
                                            .foregroundStyle(.primary)
                                        Spacer()
                                        Image(systemName: "arrow.right")
                                            .font(.caption)
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                            }
                        }

                        if let updateError {
                            Text(updateError)
                                .foregroundStyle(.red)
                                .font(.caption)
                        }
                    }
                }

                if !task.description.isEmpty {
                    Section("Description") {
                        Text(task.description)
                    }
                }

                if let update = task.latestUpdate, !update.isEmpty {
                    Section("Latest Update") {
                        Text(update)
                            .font(.callout)
                    }
                }

                if let threadId = task.threadId {
                    Section {
                        Button {
                            dismiss()
                            router.navigateToThread(id: threadId)
                        } label: {
                            Label("Open Thread", systemImage: "bubble.left.and.bubble.right")
                        }
                    }
                }

                if !task.labels.isEmpty {
                    Section("Labels") {
                        FlowLayout(spacing: 6) {
                            ForEach(task.labels, id: \.self) { label in
                                Text(label)
                                    .font(.caption)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(Color(.systemGray5))
                                    .clipShape(Capsule())
                            }
                        }
                    }
                }
            }
            .navigationTitle(task.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func transitionTo(_ newState: TaskState) {
        guard !isUpdating else { return }
        isUpdating = true
        updateError = nil

        Task {
            do {
                try await boardStore.updateTaskState(id: task.id, state: newState)
                dismiss()
            } catch {
                isUpdating = false
                updateError = "Failed: \(error.localizedDescription)"
                HapticManager.error()
            }
        }
    }
}

/// Simple horizontal flow layout for labels.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = arrange(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(proposal: proposal, subviews: subviews)
        for (index, position) in result.positions.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y),
                                  proposal: .unspecified)
        }
    }

    private func arrange(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        let maxWidth = proposal.width ?? .infinity
        var positions: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var maxX: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth && x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
            maxX = max(maxX, x)
        }

        return (CGSize(width: maxX, height: y + rowHeight), positions)
    }
}
