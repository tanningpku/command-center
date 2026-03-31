import SwiftUI

/// Compact project picker shown in the navigation bar across all tabs.
struct ProjectSelectorView: View {
    @Environment(ProjectStore.self) var projectStore
    @State private var showingCreateSheet = false
    @State private var newProjectName = ""
    @State private var isCreating = false
    @State private var createError: String?

    var body: some View {
        Menu {
            ForEach(projectStore.projects) { project in
                Button {
                    Task { await projectStore.select(project.id) }
                } label: {
                    HStack {
                        Text(project.name)
                        if project.id == projectStore.selectedId {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }

            Divider()

            Button {
                showingCreateSheet = true
            } label: {
                Label("New Project…", systemImage: "plus")
            }
        } label: {
            HStack(spacing: 4) {
                Circle()
                    .fill(projectStore.selected?.status == "active" ? .green : .gray)
                    .frame(width: 8, height: 8)
                Text(projectStore.selected?.name ?? "Select Project")
                    .font(.headline)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .alert("New Project", isPresented: $showingCreateSheet) {
            TextField("Project name", text: $newProjectName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Cancel", role: .cancel) {
                newProjectName = ""
                createError = nil
            }
            Button("Create") {
                Task { await createProject() }
            }
            .disabled(newProjectName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            if let createError {
                Text(createError)
            } else {
                Text("Enter a name for the new project.")
            }
        }
    }

    private func createProject() async {
        let name = newProjectName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        isCreating = true
        createError = nil
        do {
            try await projectStore.createProject(name: name)
            newProjectName = ""
        } catch {
            createError = error.localizedDescription
        }
        isCreating = false
    }
}
