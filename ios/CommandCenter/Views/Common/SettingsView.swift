import SwiftUI

/// Settings screen for configuring gateway URL and testing connection.
struct SettingsView: View {
    @Environment(ProjectStore.self) var projectStore
    @Environment(\.dismiss) var dismiss

    @State private var urlText: String = ""
    @State private var connectionStatus: ConnectionTestStatus = .idle
    @State private var savedMessage = false

    enum ConnectionTestStatus: Equatable {
        case idle, testing, success(Int), failed(String)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Gateway URL") {
                    TextField("http://192.168.86.27:3300", text: $urlText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)

                    Button("Test Connection") {
                        testConnection()
                    }
                    .disabled(urlText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    switch connectionStatus {
                    case .idle:
                        EmptyView()
                    case .testing:
                        HStack {
                            ProgressView()
                                .scaleEffect(0.8)
                            Text("Testing...")
                                .foregroundStyle(.secondary)
                        }
                    case .success(let projectCount):
                        Label("Connected (\(projectCount) projects)", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    case .failed(let error):
                        Label(error, systemImage: "xmark.circle.fill")
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }

                Section {
                    Button("Save") {
                        save()
                    }
                    .disabled(urlText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    if savedMessage {
                        Label("Saved! Restart the app to apply.", systemImage: "checkmark")
                            .foregroundStyle(.green)
                    }
                }

                Section("Current") {
                    LabeledContent("URL", value: AppConfig.baseURL?.absoluteString ?? "not set")
                    LabeledContent("Project", value: projectStore.selected?.name ?? "none")
                    LabeledContent("Projects loaded", value: "\(projectStore.projects.count)")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                urlText = UserDefaults.standard.string(forKey: AppConfig.baseURLKey)
                    ?? AppConfig.defaultBaseURL
            }
        }
    }

    private func save() {
        let trimmed = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(trimmed, forKey: AppConfig.baseURLKey)
        savedMessage = true
    }

    private func testConnection() {
        let trimmed = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed)?.appendingPathComponent("api/registry") else {
            connectionStatus = .failed("Invalid URL")
            return
        }
        connectionStatus = .testing

        Task {
            do {
                let (data, response) = try await URLSession.shared.data(from: url)
                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    connectionStatus = .failed("HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
                    return
                }
                if let json = try? JSONDecoder().decode(RegistryResponse.self, from: data) {
                    connectionStatus = .success(json.projects.count)
                } else {
                    connectionStatus = .success(0)
                }
            } catch {
                connectionStatus = .failed(error.localizedDescription)
            }
        }
    }
}
