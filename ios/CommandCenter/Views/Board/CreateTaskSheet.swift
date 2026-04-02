import SwiftUI

/// Sheet for creating a new task with title, priority, assignee, and description.
struct CreateTaskSheet: View {
    @Environment(BoardStore.self) var boardStore
    @Environment(TeamStore.self) var teamStore
    @Environment(\.dismiss) var dismiss

    @State private var title = ""
    @State private var description = ""
    @State private var priority: TaskPriority = .normal
    @State private var selectedAssignee: String?
    @State private var isCreating = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Title") {
                    TextField("Task title", text: $title)
                        .autocorrectionDisabled()
                }

                Section("Priority") {
                    Picker("Priority", selection: $priority) {
                        ForEach([TaskPriority.low, .normal, .medium, .high, .critical], id: \.self) { p in
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(p.color)
                                    .frame(width: 8, height: 8)
                                Text(p.rawValue.capitalized)
                            }
                            .tag(p)
                        }
                    }
                    .pickerStyle(.menu)
                }

                Section("Assignee") {
                    if teamStore.agents.isEmpty {
                        Text("Loading agents...")
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Assignee", selection: $selectedAssignee) {
                            Text("Unassigned").tag(nil as String?)
                            ForEach(teamStore.agents) { agent in
                                Text(agent.name).tag(agent.id as String?)
                            }
                        }
                        .pickerStyle(.menu)
                    }
                }

                Section("Description") {
                    TextField("Optional description", text: $description, axis: .vertical)
                        .lineLimit(3...6)
                }

                if let error {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }
            }
            .navigationTitle("New Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isCreating)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isCreating {
                        ProgressView()
                    } else {
                        Button("Create") { createTask() }
                            .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                            .bold()
                    }
                }
            }
            .interactiveDismissDisabled(isCreating)
            .task {
                if teamStore.agents.isEmpty {
                    await teamStore.loadAgents()
                }
            }
        }
    }

    private func createTask() {
        let trimmedTitle = title.trimmingCharacters(in: .whitespaces)
        guard !trimmedTitle.isEmpty, !isCreating else { return }

        isCreating = true
        error = nil

        let desc = description.trimmingCharacters(in: .whitespaces)

        Task {
            do {
                try await boardStore.createTask(
                    title: trimmedTitle,
                    description: desc.isEmpty ? nil : desc,
                    priority: priority.rawValue,
                    assignee: selectedAssignee
                )
                dismiss()
            } catch {
                isCreating = false
                self.error = "Failed to create task: \(error.localizedDescription)"
                HapticManager.error()
            }
        }
    }
}
