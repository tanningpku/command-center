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

/// Banner shown when data is stale (loaded from cache while offline).
struct StaleBanner: View {
    let isStale: Bool

    var body: some View {
        if isStale {
            HStack(spacing: 6) {
                Image(systemName: "icloud.slash")
                    .font(.caption2)
                Text("Offline — showing cached data")
                    .font(.caption2)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity)
            .background(Color.orange)
        }
    }
}
