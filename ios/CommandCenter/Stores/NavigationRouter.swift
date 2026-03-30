import SwiftUI

/// Manages tab selection, thread navigation, and deep link state.
@MainActor
@Observable
class NavigationRouter {
    enum Tab: String, CaseIterable {
        case home, team, board, threads

        var label: String {
            switch self {
            case .home: "Home"
            case .team: "Team"
            case .board: "Board"
            case .threads: "Threads"
            }
        }

        var icon: String {
            switch self {
            case .home: "house"
            case .team: "person.3"
            case .board: "rectangle.split.3x1"
            case .threads: "bubble.left.and.bubble.right"
            }
        }
    }

    var selectedTab: Tab {
        didSet { UserDefaults.standard.set(selectedTab.rawValue, forKey: AppConfig.selectedTabKey) }
    }

    /// Thread to navigate into (set by tap or deep link)
    var pendingThreadId: String?

    init() {
        let saved = UserDefaults.standard.string(forKey: AppConfig.selectedTabKey)
        self.selectedTab = Tab(rawValue: saved ?? "") ?? .home
    }

    func navigateToThread(id: String) {
        selectedTab = .threads
        pendingThreadId = id
    }
}
