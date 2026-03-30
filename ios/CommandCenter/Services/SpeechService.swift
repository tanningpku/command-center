import AVFoundation
import Foundation

/// Voice recording service with silence detection. Ported from companion app.
@MainActor
class SpeechService: ObservableObject {
    @Published var isRecording = false
    @Published var error: String?

    /// Called when silence is detected after speech, with the audio file URL
    var onSilenceDetected: ((URL) -> Void)?

    private var recorder: AVAudioRecorder?
    private var silenceTimer: Timer?
    private var silenceCount = 0
    private var hasDetectedSpeech = false
    private var recordingStartTime: Date?

    private let silenceThreshold: Float = -45.0
    private let silenceSamplesToStop = 20  // 2 seconds at 10Hz
    private let minimumDuration: TimeInterval = 1.5

    func requestAuthorization() async -> Bool {
        await withCheckedContinuation { cont in
            AVAudioApplication.requestRecordPermission { granted in
                cont.resume(returning: granted)
            }
        }
    }

    func startRecording() {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice_\(UUID().uuidString).m4a")

        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, options: [.duckOthers, .defaultToSpeaker])
            try session.setActive(true)

            recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder?.isMeteringEnabled = true
            recorder?.record()

            isRecording = true
            hasDetectedSpeech = false
            silenceCount = 0
            recordingStartTime = Date()

            silenceTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.checkAudioLevel() }
            }
        } catch {
            self.error = "Recording failed: \(error.localizedDescription)"
        }
    }

    func stopRecording() -> URL? {
        silenceTimer?.invalidate()
        silenceTimer = nil

        guard let recorder, recorder.isRecording else { return nil }
        let url = recorder.url
        recorder.stop()
        self.recorder = nil
        isRecording = false
        return url
    }

    func cancelRecording() {
        if let url = stopRecording() {
            cleanupFile(at: url)
        }
    }

    func cleanupFile(at url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    private func checkAudioLevel() {
        guard let recorder, recorder.isRecording else { return }
        recorder.updateMeters()
        let level = recorder.averagePower(forChannel: 0)

        if level > silenceThreshold {
            hasDetectedSpeech = true
            silenceCount = 0
        } else if hasDetectedSpeech {
            silenceCount += 1
            if silenceCount >= silenceSamplesToStop {
                let elapsed = Date().timeIntervalSince(recordingStartTime ?? Date())
                if elapsed >= minimumDuration {
                    if let url = stopRecording() {
                        onSilenceDetected?(url)
                    }
                }
            }
        }
    }
}
