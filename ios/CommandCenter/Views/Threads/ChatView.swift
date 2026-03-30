import SwiftUI
import PhotosUI

/// Chat interface with text, voice, and image input.
struct ChatView: View {
    let threadId: String
    let threadTitle: String

    @Environment(ThreadStore.self) var threadStore
    @State private var inputText = ""
    @State private var scrollProxy: ScrollViewProxy?

    // Voice
    @StateObject private var speechService = SpeechService()
    @State private var voiceState: VoiceState = .idle
    @State private var apiService: APIService?

    // Image
    @State private var showPhotoPicker = false
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var isUploading = false

    enum VoiceState {
        case idle, recording, transcribing
    }

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                // Messages
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 2) {
                            ForEach(threadStore.messages) { message in
                                MessageBubbleView(message: message)
                                    .id(message.id)
                            }
                        }
                        .padding(.vertical, 8)
                    }
                    .onAppear { scrollProxy = proxy }
                    .onChange(of: threadStore.messages.count) {
                        scrollToBottom(proxy: proxy)
                    }
                }

                Divider()

                // Input bar
                chatInputBar
            }

            // Recording overlay
            if voiceState == .recording {
                recordingOverlay
            }
        }
        .navigationTitle(threadTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await threadStore.loadMessages(threadId: threadId)
            // Scroll to bottom after initial load
            if let proxy = scrollProxy {
                scrollToBottom(proxy: proxy)
            }
            // Get API service from the base URL
            if let url = AppConfig.baseURL {
                apiService = APIService(baseURL: url)
                if let projectId = UserDefaults.standard.string(forKey: AppConfig.selectedProjectKey) {
                    await apiService?.setProject(projectId)
                }
            }
        }
        .onChange(of: selectedPhoto) { _, newItem in
            if let newItem { handlePhotoSelection(newItem) }
        }
    }

    // MARK: - Input bar

    private var chatInputBar: some View {
        HStack(spacing: 8) {
            // Photo button
            PhotosPicker(selection: $selectedPhoto, matching: .images) {
                Image(systemName: "photo")
                    .font(.title3)
                    .foregroundStyle(.blue)
            }
            .disabled(isUploading)

            // Text field
            TextField("Type a message...", text: $inputText, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .padding(10)
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 20))
                .onSubmit { if canSend { sendText() } }

            // Voice / Send button
            if canSend {
                Button { sendText() } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.blue)
                }
            } else {
                Button { toggleVoice() } label: {
                    Image(systemName: voiceState == .transcribing ? "ellipsis.circle" : "mic.circle.fill")
                        .font(.title2)
                        .foregroundStyle(voiceState == .idle ? .blue : .red)
                        .symbolEffect(.pulse, isActive: voiceState == .transcribing)
                }
                .disabled(voiceState == .transcribing)
            }

            if isUploading {
                ProgressView()
                    .scaleEffect(0.8)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    // MARK: - Recording overlay (companion-style)

    private var recordingOverlay: some View {
        ZStack {
            Color.red.opacity(0.12)
                .ignoresSafeArea()
                .onTapGesture { stopAndTranscribe() }

            VStack(spacing: 16) {
                Image(systemName: "mic.fill")
                    .font(.system(size: 80))
                    .foregroundStyle(.red)
                    .shadow(color: .red.opacity(0.5), radius: 20)
                    .symbolEffect(.pulse.byLayer, options: .repeating)

                Text("Listening...")
                    .font(.headline)
                    .foregroundStyle(.red)

                Button {
                    speechService.cancelRecording()
                    voiceState = .idle
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .transition(.opacity.animation(.easeInOut(duration: 0.15)))
    }

    // MARK: - Actions

    private var canSend: Bool {
        !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func sendText() {
        let text = inputText
        inputText = ""
        Task {
            await threadStore.sendMessage(text: text, threadId: threadId)
            if let proxy = scrollProxy { scrollToBottom(proxy: proxy) }
        }
    }

    private func toggleVoice() {
        switch voiceState {
        case .idle:
            startRecording()
        case .recording:
            stopAndTranscribe()
        case .transcribing:
            break
        }
    }

    private func startRecording() {
        Task {
            let authorized = await speechService.requestAuthorization()
            guard authorized else {
                speechService.error = "Microphone permission denied"
                return
            }

            speechService.onSilenceDetected = { url in
                transcribeAndSend(url: url)
            }

            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            speechService.startRecording()
            voiceState = .recording
        }
    }

    private func stopAndTranscribe() {
        guard let url = speechService.stopRecording() else {
            voiceState = .idle
            return
        }
        transcribeAndSend(url: url)
    }

    private func transcribeAndSend(url: URL) {
        voiceState = .transcribing
        Task {
            defer {
                speechService.cleanupFile(at: url)
                voiceState = .idle
            }
            guard let api = apiService else { return }
            do {
                let result = try await api.transcribeAudio(fileURL: url)
                let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    await threadStore.sendMessage(text: text, threadId: threadId)
                    if let proxy = scrollProxy { scrollToBottom(proxy: proxy) }
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                }
            } catch {
                speechService.error = "Transcription failed: \(error.localizedDescription)"
            }
        }
    }

    private func handlePhotoSelection(_ item: PhotosPickerItem) {
        isUploading = true
        Task {
            defer {
                isUploading = false
                selectedPhoto = nil
            }
            guard let data = try? await item.loadTransferable(type: Data.self),
                  let api = apiService else { return }
            do {
                _ = try await api.uploadImage(
                    imageData: data, fileName: "screenshot.jpg",
                    caption: nil, threadId: threadId
                )
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch {
                speechService.error = "Upload failed: \(error.localizedDescription)"
            }
        }
    }

    private func scrollToBottom(proxy: ScrollViewProxy) {
        if let last = threadStore.messages.last {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo(last.id, anchor: .bottom)
            }
        }
    }
}
