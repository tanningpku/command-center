import SwiftUI

/// Chat interface for a single thread with messages and input bar.
struct ChatView: View {
    let threadId: String
    let threadTitle: String

    @Environment(ThreadStore.self) var threadStore
    @State private var inputText = ""
    @State private var scrollProxy: ScrollViewProxy?

    var body: some View {
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
            ChatInputBar(text: $inputText) {
                let text = inputText
                inputText = ""
                Task {
                    await threadStore.sendMessage(text: text, threadId: threadId)
                    if let proxy = scrollProxy {
                        scrollToBottom(proxy: proxy)
                    }
                }
            }
        }
        .navigationTitle(threadTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await threadStore.loadMessages(threadId: threadId)
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

/// Text input bar with send button.
struct ChatInputBar: View {
    @Binding var text: String
    let onSend: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            TextField("Type a message...", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .padding(10)
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 20))
                .onSubmit { if canSend { onSend() } }

            Button {
                onSend()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
                    .foregroundStyle(canSend ? .blue : .gray)
            }
            .disabled(!canSend)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
