import SwiftUI
import PhotosUI

/// Chat interface with text, voice, and image input.
struct ChatView: View {
    let threadId: String
    let threadTitle: String

    @Environment(ThreadStore.self) var threadStore
    @Environment(BoardStore.self) var boardStore
    @State private var inputText = ""
    @State private var scrollProxy: ScrollViewProxy?

    // Voice
    @StateObject private var speechService = SpeechService()
    @State private var voiceState: VoiceState = .idle
    @State private var apiService: APIService?
    @AppStorage("voiceModeEnabled") private var voiceModeEnabled = false

    // Image draft
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var draftImageData: Data?
    @State private var draftImage: UIImage?
    @State private var isUploading = false

    enum VoiceState {
        case idle, recording, transcribing
    }

    /// Task linked to this thread via threadId, if any.
    private var linkedTask: CCTask? {
        boardStore.tasks.first { $0.threadId == threadId }
    }

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                // Design context header (shown only when task has designDocs)
                if let task = linkedTask, !task.designDocs.isEmpty {
                    DesignContextHeaderView(task: task)
                }

                // Messages
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 6) {
                            ForEach(threadStore.messages) { message in
                                MessageBubbleView(message: message)
                                    .id(message.id)
                            }
                            // Anchor at bottom — always present, ensures scrollTo target exists
                            Color.clear.frame(height: 1).id("bottom-anchor")
                        }
                        .padding(.vertical, 12)
                    }
                    .defaultScrollAnchor(.bottom)
                    .onAppear { scrollProxy = proxy }
                    .onChange(of: threadStore.messages.count) {
                        scrollToBottom(proxy: proxy)
                    }
                    .onTapGesture {
                        // Voice mode: tap anywhere to start recording
                        if voiceModeEnabled && voiceState == .idle {
                            startRecording()
                        }
                    }
                }
                Divider()

                // Draft image preview
                if let draftImage {
                    HStack(alignment: .top, spacing: 8) {
                        Image(uiImage: draftImage)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(width: 60, height: 60)
                            .clipShape(RoundedRectangle(cornerRadius: 8))

                        Text("Add a caption...")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Spacer()

                        Button {
                            self.draftImageData = nil
                            self.draftImage = nil
                            self.selectedPhoto = nil
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color(.systemGray6))
                }

                // Voice mode indicator
                if voiceModeEnabled && voiceState == .idle {
                    HStack(spacing: 6) {
                        Image(systemName: "mic.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                        Text("Voice mode — tap anywhere to record")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }

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
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    voiceModeEnabled.toggle()
                    if voiceModeEnabled {
                        HapticManager.light()
                    }
                } label: {
                    Image(systemName: voiceModeEnabled ? "mic.fill" : "mic.slash")
                        .font(.body)
                        .foregroundStyle(voiceModeEnabled ? .red : .secondary)
                }
            }
        }
        .task {
            await threadStore.loadMessages(threadId: threadId)
            // Yield to let LazyVStack lay out, then scroll
            try? await Task.sleep(for: .milliseconds(100))
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
            if let newItem { loadPhotoDraft(newItem) }
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
            TextField(draftImage != nil ? "Add context..." : "Type a message...", text: $inputText, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .padding(10)
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 20))
                .onSubmit { if canSend { sendMessage() } }

            // Send / Voice button
            if canSend || draftImage != nil {
                Button { sendMessage() } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.blue)
                }
                .disabled(isUploading)
            } else if !voiceModeEnabled {
                Button { toggleVoice() } label: {
                    Image(systemName: voiceState == .transcribing ? "ellipsis.circle" : "mic.circle.fill")
                        .font(.title2)
                        .foregroundStyle(voiceState == .idle ? .blue : .red)
                        .symbolEffect(.pulse, isActive: voiceState == .transcribing)
                }
                .disabled(voiceState == .transcribing)
            }

            if isUploading || voiceState == .transcribing {
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

    private func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let imageData = draftImageData

        inputText = ""
        draftImageData = nil
        draftImage = nil
        selectedPhoto = nil

        Task {
            if let imageData, let api = apiService {
                // Upload image with optional caption
                isUploading = true
                defer { isUploading = false }
                do {
                    let result = try await api.uploadImage(
                        imageData: imageData, fileName: "screenshot.jpg",
                        caption: text.isEmpty ? nil : text, threadId: threadId
                    )
                    // Add optimistic local message with image paths + caption
                    let jpgPaths = (result.paths ?? []).filter { $0.hasSuffix(".jpg") || $0.hasSuffix(".jpeg") || $0.hasSuffix(".png") }
                    if !jpgPaths.isEmpty {
                        let content = text.isEmpty ? "[image: \(jpgPaths.joined(separator: ", "))]" : text
                        var metaDict: [String: JSONValue] = ["imagePaths": .array(jpgPaths.map { .string($0) })]
                        if !text.isEmpty { metaDict["caption"] = .string(text) }
                        let local = CCMessage(
                            threadId: threadId, role: "user", content: content,
                            sender: "user", source: "upload",
                            metadata: .object(metaDict)
                        )
                        threadStore.messages.append(local)
                    }
                    HapticManager.success()
                } catch {
                    speechService.error = "Upload failed: \(error.localizedDescription)"
                }
            } else if !text.isEmpty {
                // Text-only message
                HapticManager.light()
                await threadStore.sendMessage(text: text, threadId: threadId)
            }
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
        Task { @MainActor in
            let authorized = await speechService.requestAuthorization()
            guard authorized else {
                speechService.error = "Microphone permission denied"
                return
            }

            speechService.onSilenceDetected = { url in
                transcribeAndSend(url: url)
            }

            HapticManager.medium()
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
                    if draftImageData != nil, apiService != nil {
                        // Photo draft is attached — route through sendMessage()
                        // which handles image upload with caption
                        let existing = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
                        inputText = existing.isEmpty ? text : "\(existing) \(text)"
                        sendMessage()
                    } else {
                        await threadStore.sendMessage(text: text, threadId: threadId, source: "ios-voice")
                        if let proxy = scrollProxy { scrollToBottom(proxy: proxy) }
                        HapticManager.success()
                    }
                }
            } catch {
                speechService.error = "Transcription failed: \(error.localizedDescription)"
            }
        }
    }

    private func loadPhotoDraft(_ item: PhotosPickerItem) {
        Task {
            guard let data = try? await item.loadTransferable(type: Data.self) else { return }
            draftImageData = data
            draftImage = UIImage(data: data)
        }
    }

    private func scrollToBottom(proxy: ScrollViewProxy, animated: Bool = true) {
        if animated {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo("bottom-anchor", anchor: .bottom)
            }
        } else {
            proxy.scrollTo("bottom-anchor", anchor: .bottom)
        }
    }
}
