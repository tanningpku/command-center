import SwiftUI

/// Compact project picker shown in the navigation bar across all tabs.
struct ProjectSelectorView: View {
    @Environment(ProjectStore.self) var projectStore
    @State private var showingCreateSheet = false
    @State private var newProjectName = ""
    @State private var isCreating = false
    @State private var createError: String?
    @State private var projectToDelete: Project?
    @State private var deleteError: String?

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

            Menu {
                ForEach(projectStore.projects) { project in
                    Button(role: .destructive) {
                        projectToDelete = project
                    } label: {
                        Text(project.name)
                    }
                }
            } label: {
                Label("Delete Project…", systemImage: "trash")
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
        .alert("Delete Project?", isPresented: .init(
            get: { projectToDelete != nil },
            set: { if !$0 { projectToDelete = nil } }
        )) {
            Button("Cancel", role: .cancel) {
                projectToDelete = nil
            }
            Button("Delete", role: .destructive) {
                if let project = projectToDelete {
                    Task { await deleteProject(project) }
                }
            }
        } message: {
            if let project = projectToDelete {
                Text("This will stop all Claude sessions and permanently remove \"\(project.name)\" and its data.")
            }
        }
        .alert("Delete Failed", isPresented: .init(
            get: { deleteError != nil },
            set: { if !$0 { deleteError = nil } }
        )) {
            Button("OK") { deleteError = nil }
        } message: {
            if let deleteError {
                Text(deleteError)
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

    private func deleteProject(_ project: Project) async {
        do {
            try await projectStore.deleteProject(id: project.id)
        } catch {
            deleteError = error.localizedDescription
        }
        projectToDelete = nil
    }
}
