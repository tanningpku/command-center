import SwiftUI

/// Sheet for creating a new thread with title and participant selection.
struct NewThreadView: View {
    @Environment(ThreadStore.self) var threadStore
    @Environment(TeamStore.self) var teamStore
    @Environment(\.dismiss) var dismiss

    var onCreated: (CCThread) -> Void

    @State private var title = ""
    @State private var selectedAgentIds: Set<String> = ["captain"]
    @State private var isCreating = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Thread Title") {
                    TextField("e.g. Design: New Feature", text: $title)
                        .autocorrectionDisabled()
                }

                Section("Participants") {
                    if teamStore.agents.isEmpty {
                        Text("Loading agents...")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(teamStore.agents) { agent in
                            Button {
                                if selectedAgentIds.contains(agent.id) {
                                    selectedAgentIds.remove(agent.id)
                                } else {
                                    selectedAgentIds.insert(agent.id)
                                }
                            } label: {
                                HStack {
                                    Image(systemName: selectedAgentIds.contains(agent.id) ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(selectedAgentIds.contains(agent.id) ? .blue : .secondary)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(agent.name)
                                            .foregroundStyle(.primary)
                                        Text(agent.role)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                }
                            }
                        }
                    }
                }

                if let error {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }
            }
            .navigationTitle("New Thread")
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
                        Button("Create") { createThread() }
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

    private func createThread() {
        let trimmedTitle = title.trimmingCharacters(in: .whitespaces)
        guard !trimmedTitle.isEmpty, !isCreating else { return }

        isCreating = true
        error = nil

        let participants = selectedAgentIds.map { ["id": $0] }

        Task {
            do {
                let newThread = try await threadStore.createThread(title: trimmedTitle, participants: participants)
                HapticManager.success()
                dismiss()
                onCreated(newThread)
            } catch let apiError as APIError {
                isCreating = false
                switch apiError {
                case .badResponse(statusCode: 409):
                    self.error = "A thread with this title already exists."
                default:
                    self.error = "Failed to create thread: \(apiError.localizedDescription)"
                }
                HapticManager.error()
            } catch {
                isCreating = false
                self.error = "Failed to create thread: \(error.localizedDescription)"
                HapticManager.error()
            }
        }
    }
}
