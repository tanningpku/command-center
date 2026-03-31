import SwiftUI

/// Root view with 5 tabs: Home, Team, Board, Threads, Health.
struct MainTabView: View {
    @Environment(NavigationRouter.self) var router
    @Environment(ProjectStore.self) var projectStore

    var body: some View {
        @Bindable var router = router

        TabView(selection: $router.selectedTab) {
            HomeView()
                .tag(NavigationRouter.Tab.home)
                .tabItem { Label("Home", systemImage: "house") }

            TeamGridView()
                .tag(NavigationRouter.Tab.team)
                .tabItem { Label("Team", systemImage: "person.3") }

            ThreadListView()
                .tag(NavigationRouter.Tab.threads)
                .tabItem { Label("Threads", systemImage: "bubble.left.and.bubble.right") }

            BoardView()
                .tag(NavigationRouter.Tab.board)
                .tabItem { Label("Board", systemImage: "rectangle.split.3x1") }

            HealthView()
                .tag(NavigationRouter.Tab.health)
                .tabItem { Label("Health", systemImage: "heart.text.square") }
        }
        .safeAreaInset(edge: .bottom) {
            CaptainBarView()
        }
        .onChange(of: router.selectedTab) { _, _ in
            HapticManager.selection()
        }
    }
}
