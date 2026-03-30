import SwiftUI

/// Message bubble with role-based styling.
/// User messages: blue, right-aligned. Agent/system: gray, left-aligned.
struct MessageBubbleView: View {
    let message: CCMessage

    var body: some View {
        if message.isSystem {
            // System messages centered, no bubble
            HStack {
                Spacer()
                VStack(spacing: 2) {
                    Text(message.content)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .italic()
                        .multilineTextAlignment(.center)
                    Text(message.displayTime)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 4)
                Spacer()
            }
        } else {
            HStack(alignment: .bottom, spacing: 8) {
                if !message.isUser {
                    // Agent avatar
                    AgentAvatar(name: message.displaySender)
                } else {
                    Spacer(minLength: 48)
                }

                VStack(alignment: message.isUser ? .trailing : .leading, spacing: 3) {
                    // Sender badge for non-user messages
                    if !message.isUser {
                        Text(message.displaySender)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }

                    // Image or text content
                    if let imagePaths = message.extractImagePaths, !imagePaths.isEmpty {
                        VStack(alignment: message.isUser ? .trailing : .leading, spacing: 4) {
                            imageContent(paths: imagePaths)
                            if let caption = message.extractCaption, !caption.isEmpty {
                                MarkdownTextView(caption, foregroundColor: message.isUser ? .white : .primary)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 8)
                                    .background(message.isUser ? Color.blue : Color(.systemGray5))
                                    .clipShape(RoundedRectangle(cornerRadius: 16))
                            }
                        }
                    } else {
                        MarkdownTextView(message.content, foregroundColor: message.isUser ? .white : .primary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(message.isUser ? Color.blue : Color(.systemGray5))
                            .clipShape(RoundedRectangle(cornerRadius: 18))
                    }

                    // Timestamp
                    Text(message.displayTime)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                if message.isUser {
                    Spacer(minLength: 48)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func imageContent(paths: [String]) -> some View {
        VStack(spacing: 4) {
            ForEach(paths, id: \.self) { imagePath in
                if let url = imageURL(for: imagePath) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(maxWidth: 240, maxHeight: 320)
                        case .failure:
                            Label("Image failed to load", systemImage: "photo.badge.exclamationmark")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(10)
                        case .empty:
                            ProgressView()
                                .frame(width: 120, height: 80)
                        @unknown default:
                            EmptyView()
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                }
            }
        }
        .padding(4)
        .background(message.isUser ? Color.blue.opacity(0.15) : Color(.systemGray6))
        .clipShape(RoundedRectangle(cornerRadius: 18))
    }

    private func imageURL(for path: String) -> URL? {
        guard let base = AppConfig.baseURL else { return nil }
        var components = URLComponents(url: base.appendingPathComponent("api/harness/media"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "path", value: path)]
        return components?.url
    }
}

/// Simple avatar circle with initial.
struct AgentAvatar: View {
    let name: String

    var body: some View {
        ZStack {
            Circle()
                .fill(Color(.systemGray4))
                .frame(width: 32, height: 32)
            Text(String(name.prefix(1)).uppercased())
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
        }
    }
}
