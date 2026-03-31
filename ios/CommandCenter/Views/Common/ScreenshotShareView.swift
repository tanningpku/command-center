import SwiftUI
import Photos

/// Overlay sheet shown when a screenshot is detected.
/// Lets the user pick a thread, add a caption, and share the screenshot.
struct ScreenshotShareView: View {
    @Environment(ThreadStore.self) var threadStore
    @Environment(\.dismiss) var dismiss

    var screenshotTakenAt: Date = Date()

    @State private var screenshotImage: UIImage?
    @State private var caption = ""
    @State private var selectedThreadId: String?
    @State private var isLoading = true
    @State private var isSending = false
    @State private var error: String?
    @State private var apiService: APIService?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Fetching screenshot...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let screenshotImage {
                    ScrollView {
                        VStack(spacing: 16) {
                            // Screenshot preview
                            Image(uiImage: screenshotImage)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(maxHeight: 300)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                                .shadow(radius: 4)

                            // Caption
                            TextField("Add a caption...", text: $caption, axis: .vertical)
                                .textFieldStyle(.roundedBorder)
                                .lineLimit(1...4)

                            // Thread picker
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Share to thread")
                                    .font(.headline)

                                if threadStore.threads.isEmpty {
                                    Text("No threads available")
                                        .foregroundStyle(.secondary)
                                        .font(.subheadline)
                                } else {
                                    ForEach(threadStore.threads) { thread in
                                        Button {
                                            selectedThreadId = thread.id
                                        } label: {
                                            HStack {
                                                Image(systemName: selectedThreadId == thread.id ? "checkmark.circle.fill" : "circle")
                                                    .foregroundStyle(selectedThreadId == thread.id ? .blue : .secondary)
                                                Text(thread.title)
                                                    .foregroundStyle(.primary)
                                                Spacer()
                                            }
                                            .padding(.vertical, 6)
                                            .padding(.horizontal, 10)
                                            .background(selectedThreadId == thread.id ? Color.blue.opacity(0.1) : Color.clear)
                                            .clipShape(RoundedRectangle(cornerRadius: 8))
                                        }
                                    }
                                }
                            }

                            if let error {
                                Text(error)
                                    .font(.caption)
                                    .foregroundStyle(.red)
                            }
                        }
                        .padding()
                    }
                } else {
                    ContentUnavailableView("No Screenshot", systemImage: "photo",
                        description: Text("Could not retrieve the screenshot. Make sure photo library access is enabled."))
                }
            }
            .navigationTitle("Share Screenshot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { sendScreenshot() }
                        .disabled(selectedThreadId == nil || screenshotImage == nil || isSending)
                        .bold()
                }
            }
            .overlay {
                if isSending {
                    ZStack {
                        Color.black.opacity(0.3).ignoresSafeArea()
                        ProgressView("Sending...")
                            .padding()
                            .background(.ultraThinMaterial)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
        }
        .task {
            await setup()
        }
    }

    private func setup() async {
        // Setup API service
        if let url = AppConfig.baseURL {
            apiService = APIService(baseURL: url)
            if let projectId = UserDefaults.standard.string(forKey: AppConfig.selectedProjectKey) {
                await apiService?.setProject(projectId)
            }
        }

        // Load threads if needed
        if threadStore.threads.isEmpty {
            await threadStore.loadThreads()
        }

        // Pre-select the active thread if there is one
        if let active = threadStore.activeThreadId {
            selectedThreadId = active
        }

        // Fetch latest screenshot from photo library
        await fetchLatestScreenshot()
        isLoading = false
    }

    private func fetchLatestScreenshot() async {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined {
            let newStatus = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
            if newStatus != .authorized && newStatus != .limited { return }
        } else if status != .authorized && status != .limited {
            return
        }

        // Retry up to 5 times to wait for the new screenshot to appear in the photo library
        let maxRetries = 5
        for attempt in 0..<maxRetries {
            let asset = fetchLatestScreenshotAsset()
            guard let asset else {
                if attempt < maxRetries - 1 {
                    try? await Task.sleep(for: .milliseconds(500))
                    continue
                }
                return
            }

            // Check if this screenshot was taken after our trigger time (with 3s tolerance)
            if let creationDate = asset.creationDate,
               creationDate >= screenshotTakenAt.addingTimeInterval(-3) {
                screenshotImage = await loadImage(from: asset)
                return
            }

            // Screenshot is older than our trigger — wait and retry
            if attempt < maxRetries - 1 {
                try? await Task.sleep(for: .milliseconds(500))
            }
        }

        // Fallback: use whatever the latest screenshot is
        if let asset = fetchLatestScreenshotAsset() {
            screenshotImage = await loadImage(from: asset)
        }
    }

    private func fetchLatestScreenshotAsset() -> PHAsset? {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = 1
        options.predicate = NSPredicate(format: "mediaSubtypes == %d", PHAssetMediaSubtype.photoScreenshot.rawValue)
        return PHAsset.fetchAssets(with: .image, options: options).firstObject
    }

    private func loadImage(from asset: PHAsset) async -> UIImage? {
        let imageManager = PHImageManager.default()
        let targetSize = CGSize(width: 1080, height: 1920)
        let requestOptions = PHImageRequestOptions()
        requestOptions.deliveryMode = .highQualityFormat
        requestOptions.isSynchronous = false
        requestOptions.isNetworkAccessAllowed = true

        return await withCheckedContinuation { continuation in
            imageManager.requestImage(for: asset, targetSize: targetSize, contentMode: .aspectFit, options: requestOptions) { image, _ in
                continuation.resume(returning: image)
            }
        }
    }

    private func sendScreenshot() {
        guard let image = screenshotImage,
              let threadId = selectedThreadId,
              let api = apiService,
              let jpegData = image.jpegData(compressionQuality: 0.85) else { return }

        isSending = true
        error = nil

        Task {
            defer { isSending = false }
            do {
                let result = try await api.uploadImage(
                    imageData: jpegData,
                    fileName: "screenshot.jpg",
                    caption: caption.isEmpty ? nil : caption,
                    threadId: threadId
                )
                HapticManager.success()
                dismiss()
            } catch {
                self.error = "Failed to send: \(error.localizedDescription)"
                HapticManager.error()
            }
        }
    }
}
