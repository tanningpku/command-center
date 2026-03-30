import SwiftUI

/// Root view with 5 tabs matching the Command Center web UI.
/// All tabs fully functional: Team, Board, Threads, Ops, Metrics.
struct MainTabView: View {
    @Environment(NavigationRouter.self) var router
    @Environment(ProjectStore.self) var projectStore

    var body: some View {
        @Bindable var router = router

        TabView(selection: $router.selectedTab) {
            TeamGridView()
                .tag(NavigationRouter.Tab.team)
                .tabItem { Label("Team", systemImage: "person.3") }

            BoardView()
                .tag(NavigationRouter.Tab.board)
                .tabItem { Label("Board", systemImage: "rectangle.split.3x1") }

            ThreadListView()
                .tag(NavigationRouter.Tab.threads)
                .tabItem { Label("Threads", systemImage: "bubble.left.and.bubble.right") }

            OpsView()
                .tag(NavigationRouter.Tab.ops)
                .tabItem { Label("Ops", systemImage: "gearshape.2") }

            MetricsView()
                .tag(NavigationRouter.Tab.metrics)
                .tabItem { Label("Metrics", systemImage: "chart.bar") }
        }
        .onChange(of: router.selectedTab) { _, _ in
            HapticManager.selection()
        }
    }
}
