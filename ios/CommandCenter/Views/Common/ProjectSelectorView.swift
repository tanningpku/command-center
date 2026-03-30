import SwiftUI

/// Compact project picker shown in the navigation bar across all tabs.
struct ProjectSelectorView: View {
    @Environment(ProjectStore.self) var projectStore

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
    }
}
