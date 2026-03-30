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
            HStack(alignment: .bottom, spacing: 6) {
                if !message.isUser {
                    // Agent avatar
                    AgentAvatar(name: message.displaySender)
                } else {
                    Spacer(minLength: 60)
                }

                VStack(alignment: message.isUser ? .trailing : .leading, spacing: 2) {
                    // Sender badge for non-user messages
                    if !message.isUser {
                        Text(message.displaySender)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                    }

                    // Message content
                    MarkdownTextView(message.content, foregroundColor: message.isUser ? .white : .primary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(message.isUser ? Color.blue : Color(.systemGray5))
                        .clipShape(RoundedRectangle(cornerRadius: 18))

                    // Timestamp
                    Text(message.displayTime)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                if message.isUser {
                    Spacer(minLength: 60)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 2)
        }
    }
}

/// Simple avatar circle with initial.
struct AgentAvatar: View {
    let name: String

    var body: some View {
        ZStack {
            Circle()
                .fill(Color(.systemGray4))
                .frame(width: 28, height: 28)
            Text(String(name.prefix(1)).uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
        }
    }
}
