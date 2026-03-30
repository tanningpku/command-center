import SwiftUI

/// Root view with 5 tabs matching the Command Center web UI.
/// Phase 1: Threads tab is fully functional, others show placeholders.
struct MainTabView: View {
    @Environment(NavigationRouter.self) var router
    @Environment(ProjectStore.self) var projectStore

    var body: some View {
        @Bindable var router = router

        TabView(selection: $router.selectedTab) {
            PlaceholderTab(title: "Team", icon: "person.3", message: "Coming in Phase 2")
                .tag(NavigationRouter.Tab.team)
                .tabItem { Label("Team", systemImage: "person.3") }

            PlaceholderTab(title: "Board", icon: "rectangle.split.3x1", message: "Coming in Phase 2")
                .tag(NavigationRouter.Tab.board)
                .tabItem { Label("Board", systemImage: "rectangle.split.3x1") }

            ThreadListView()
                .tag(NavigationRouter.Tab.threads)
                .tabItem { Label("Threads", systemImage: "bubble.left.and.bubble.right") }

            PlaceholderTab(title: "Ops", icon: "gearshape.2", message: "Coming in Phase 3")
                .tag(NavigationRouter.Tab.ops)
                .tabItem { Label("Ops", systemImage: "gearshape.2") }

            PlaceholderTab(title: "Metrics", icon: "chart.bar", message: "Coming in Phase 3")
                .tag(NavigationRouter.Tab.metrics)
                .tabItem { Label("Metrics", systemImage: "chart.bar") }
        }
    }
}

/// Placeholder for tabs not yet implemented.
struct PlaceholderTab: View {
    let title: String
    let icon: String
    let message: String

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Image(systemName: icon)
                    .font(.system(size: 48))
                    .foregroundStyle(.tertiary)
                Text(title)
                    .font(.title2.bold())
                Text(message)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(.systemGroupedBackground))
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ProjectSelectorView()
                }
            }
        }
    }
}
