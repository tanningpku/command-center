import SwiftUI

/// Root view with 6 tabs: Home, Docs, Threads, Board, Team, Health.
struct MainTabView: View {
    @Environment(NavigationRouter.self) var router
    @Environment(ProjectStore.self) var projectStore

    var body: some View {
        @Bindable var router = router

        TabView(selection: $router.selectedTab) {
            HomeView()
                .tag(NavigationRouter.Tab.home)
                .tabItem { Label("Home", systemImage: "house") }

            DocsView()
                .tag(NavigationRouter.Tab.docs)
                .tabItem { Label("Docs", systemImage: "book") }

            ThreadListView()
                .tag(NavigationRouter.Tab.threads)
                .tabItem { Label("Threads", systemImage: "bubble.left.and.bubble.right") }

            BoardView()
                .tag(NavigationRouter.Tab.board)
                .tabItem { Label("Board", systemImage: "rectangle.split.3x1") }

            TeamGridView()
                .tag(NavigationRouter.Tab.team)
                .tabItem { Label("Team", systemImage: "person.3") }

            HealthView()
                .tag(NavigationRouter.Tab.health)
                .tabItem { Label("Health", systemImage: "heart.text.square") }
        }
        .overlay(alignment: .bottom) {
            CaptainBarView()
                .padding(.bottom, 50) // clear the tab bar
        }
        .onChange(of: router.selectedTab) { _, _ in
            HapticManager.selection()
        }
    }
}
