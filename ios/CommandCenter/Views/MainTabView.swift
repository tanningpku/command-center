import SwiftUI

/// Root view with 4 tabs: Home, Team, Board, Threads.
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

            BoardView()
                .tag(NavigationRouter.Tab.board)
                .tabItem { Label("Board", systemImage: "rectangle.split.3x1") }

            ThreadListView()
                .tag(NavigationRouter.Tab.threads)
                .tabItem { Label("Threads", systemImage: "bubble.left.and.bubble.right") }
        }
        .onChange(of: router.selectedTab) { _, _ in
            HapticManager.selection()
        }
    }
}
