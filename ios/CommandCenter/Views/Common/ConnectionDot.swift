import SwiftUI

/// SSE connection status indicator.
struct ConnectionDot: View {
    let isConnected: Bool

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(isConnected ? .green : .red)
                .frame(width: 6, height: 6)
            Text(isConnected ? "Live" : "Disconnected")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}
