import SwiftUI

/// Subtle floating bar that shows Captain's live thought stream.
/// Appears briefly when new thoughts arrive, then auto-fades.
struct CaptainBarView: View {
    @Environment(ThreadStore.self) var threadStore

    @State private var isVisible = false
    @State private var hideTask: Task<Void, Never>?

    var body: some View {
        Group {
            if let thought = threadStore.captainThought, isVisible {
                HStack(spacing: 6) {
                    Circle()
                        .fill(.blue.opacity(0.7))
                        .frame(width: 5, height: 5)
                        .modifier(PulseModifier())

                    Text(thought.agentName)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.blue.opacity(0.8))

                    Text(thought.text)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
                .padding(.horizontal, 12)
                .padding(.bottom, 2)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .onChange(of: threadStore.captainThought) { _, newValue in
            guard newValue != nil else { return }
            scheduleHide()
        }
    }

    private func scheduleHide() {
        hideTask?.cancel()
        withAnimation(.easeInOut(duration: 0.25)) { isVisible = true }
        hideTask = Task {
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                withAnimation(.easeOut(duration: 0.8)) { isVisible = false }
            }
        }
    }
}

/// Subtle pulsing dot to indicate live streaming.
private struct PulseModifier: ViewModifier {
    @State private var isPulsing = false

    func body(content: Content) -> some View {
        content
            .opacity(isPulsing ? 0.4 : 1.0)
            .animation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true), value: isPulsing)
            .onAppear { isPulsing = true }
    }
}
