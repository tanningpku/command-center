import SwiftUI

@main
struct CommandCenterApp: App {
    @State private var apiService: APIService
    @State private var sseService = SSEService()
    @State private var projectStore: ProjectStore
    @State private var threadStore: ThreadStore
    @State private var teamStore: TeamStore
    @State private var boardStore: BoardStore
    @State private var homeStore: HomeStore
    @State private var healthStore: HealthStore
    @State private var router = NavigationRouter()

    init() {
        let baseURL = AppConfig.baseURL ?? URL(string: AppConfig.defaultBaseURL)!
        let api = APIService(baseURL: baseURL)
        let sse = SSEService()
        self.apiService = api
        self.sseService = sse
        self.projectStore = ProjectStore(api: api)
        self.threadStore = ThreadStore(api: api, sseService: sse)
        self.teamStore = TeamStore(api: api)
        self.boardStore = BoardStore(api: api)
        self.homeStore = HomeStore(api: api)
        self.healthStore = HealthStore(api: api)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(projectStore)
                .environment(threadStore)
                .environment(teamStore)
                .environment(boardStore)
                .environment(homeStore)
                .environment(healthStore)
                .environment(router)
                .task {
                    await projectStore.load()
                    wireSSEEvents()
                }
                .onReceive(NotificationCenter.default.publisher(for: .projectChanged)) { _ in
                    reconnectSSE()
                }
                .onChange(of: projectStore.selectedId) { _, newId in
                    if newId != nil { reconnectSSE() }
                }
        }
    }

    private func wireSSEEvents() {
        threadStore.onAgentEvent = { type, payload in
            teamStore.handleAgentEvent(type: type, payload: payload)
        }
        threadStore.onTaskEvent = { type, payload in
            boardStore.handleTaskEvent(type: type, payload: payload)
        }
        threadStore.onHealthEvent = { type, payload in
            healthStore.handleHealthEvent(type: type, payload: payload)
        }
        threadStore.onReconnect = {
            // Auto-reload all data when SSE reconnects
            Task {
                await threadStore.loadThreads()
                await boardStore.loadTasks()
                await teamStore.loadAgents()
                await healthStore.loadHealth()
            }
        }
    }

    private func reconnectSSE() {
        guard let projectId = projectStore.selectedId,
              let baseURL = AppConfig.baseURL else { return }
        healthStore.activeProjectId = projectId
        threadStore.connectSSE(baseURL: baseURL, projectId: projectId)
    }
}

/// Root content view that shows either a loading/setup state or the main tab view.
struct ContentView: View {
    @Environment(ProjectStore.self) var projectStore
    @State private var showSettings = false
    @State private var showScreenshotShare = false
    @State private var screenshotTimestamp = Date.distantPast

    var body: some View {
        ZStack {
            if projectStore.isLoading && projectStore.projects.isEmpty {
                ProgressView("Connecting to Command Center...")
            } else if let error = projectStore.error, projectStore.projects.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 48))
                        .foregroundStyle(.secondary)
                    Text("Connection Error")
                        .font(.title2.bold())
                    Text(error)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    HStack(spacing: 12) {
                        Button("Retry") {
                            Task { await projectStore.load() }
                        }
                        .buttonStyle(.borderedProminent)
                        Button("Settings") { showSettings = true }
                            .buttonStyle(.bordered)
                    }
                }
                .padding()
                .sheet(isPresented: $showSettings) { SettingsView() }
            } else {
                MainTabView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.userDidTakeScreenshotNotification)) { _ in
            screenshotTimestamp = Date()
            // Delay to let the system save the screenshot to photo library
            Task {
                try? await Task.sleep(for: .milliseconds(1500))
                showScreenshotShare = true
            }
        }
        .sheet(isPresented: $showScreenshotShare) {
            ScreenshotShareView(screenshotTakenAt: screenshotTimestamp)
        }
    }
}
