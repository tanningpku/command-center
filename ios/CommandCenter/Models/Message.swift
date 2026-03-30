import Foundation

/// Command Center message with dual-format Codable (REST snake_case + SSE camelCase).
/// Ported from companion ChatMessage pattern.
struct CCMessage: Identifiable, Hashable {
    let localId: String
    let serverId: Int
    let threadId: String
    let role: String        // "user", "assistant"
    let kind: String        // "message", "system", "thought"
    let content: String
    let sender: String?
    let source: String?     // "cli", "webui", "ios", "gateway", "task-update"
    let metadata: JSONValue?
    let createdAt: String

    var id: String { localId }

    // Snake_case keys from REST API
    enum CodingKeys: String, CodingKey {
        case serverId = "id"
        case role, kind, content, sender, source, metadata
        case threadId = "thread_id"
        case createdAt = "created_at"
    }

    // CamelCase keys from SSE payloads
    enum AltCodingKeys: String, CodingKey {
        case serverId = "id"
        case role, kind, content, sender, source, metadata
        case threadId, createdAt
    }

    init(localId: String? = nil, serverId: Int = 0, threadId: String,
         role: String, kind: String = "message", content: String,
         sender: String? = nil, source: String? = nil,
         metadata: JSONValue? = nil, createdAt: String = "") {
        self.serverId = serverId
        self.threadId = threadId
        self.role = role
        self.kind = kind
        self.content = content
        self.sender = sender
        self.source = source
        self.metadata = metadata
        self.createdAt = createdAt.isEmpty ? ISO8601DateFormatter().string(from: Date()) : createdAt
        if let localId {
            self.localId = localId
        } else if serverId > 0 {
            self.localId = "s\(serverId)"
        } else {
            self.localId = "l_\(UUID().uuidString)"
        }
    }

    var isUser: Bool { role == "user" }
    var isAssistant: Bool { role == "assistant" }
    var isSystem: Bool { kind == "system" }

    private static let imageExtensions: Set<String> = ["jpg", "jpeg", "png", "gif", "webp", "heic"]

    private static func isImageFile(_ path: String) -> Bool {
        guard let dot = path.lastIndex(of: ".") else { return false }
        let ext = path[path.index(after: dot)...].lowercased()
        return imageExtensions.contains(ext)
    }

    /// Extract image paths from message metadata or content pattern [image: path1, path2]
    var extractImagePaths: [String]? {
        // Check metadata for imagePaths array
        if case .object(let dict) = metadata,
           case .array(let paths) = dict["imagePaths"] {
            let result = paths.compactMap { item -> String? in
                if case .string(let s) = item, Self.isImageFile(s) { return s }
                return nil
            }
            if !result.isEmpty { return result }
        }
        // Fallback: parse content pattern [image: path1, path2]
        guard content.hasPrefix("[image: ") && content.hasSuffix("]") else { return nil }
        let inner = String(content.dropFirst(8).dropLast(1))
        let paths = inner.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { Self.isImageFile($0) }
        return paths.isEmpty ? nil : paths
    }

    /// Extract caption from metadata or content (if content isn't the [image:] placeholder)
    var extractCaption: String? {
        // Check metadata for explicit caption
        if case .object(let dict) = metadata,
           case .string(let cap) = dict["caption"], !cap.isEmpty {
            return cap
        }
        // If content doesn't start with [image:, it IS the caption
        if !content.hasPrefix("[image:") && !content.isEmpty {
            return content
        }
        return nil
    }

    var displaySender: String {
        if isSystem { return "System" }
        return sender ?? (isUser ? "You" : "Agent")
    }

    var displayTime: String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fmt.date(from: createdAt) ?? {
            fmt.formatOptions = [.withInternetDateTime]
            return fmt.date(from: createdAt)
        }() else { return "" }
        return Self.timeFormatter.string(from: date)
    }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        return f
    }()

    /// Content hash for deduplication (matches companion pattern)
    var contentHash: String {
        "\(role):\(content.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())"
    }

    static func == (lhs: CCMessage, rhs: CCMessage) -> Bool {
        lhs.localId == rhs.localId
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(localId)
    }
}

// MARK: - Codable (dual-format)

extension CCMessage: Codable {
    init(from decoder: Decoder) throws {
        // Detect format: snake_case has "created_at", camelCase has "createdAt"
        let serverId: Int
        let threadId: String
        let role: String
        let kind: String
        let content: String
        let sender: String?
        let source: String?
        let createdAt: String
        var metadataValue: JSONValue?

        if let c = try? decoder.container(keyedBy: CodingKeys.self), c.contains(.createdAt) {
            serverId = decodeLossyInt(c, forKey: .serverId) ?? 0
            threadId = decodeLossyString(c, forKey: .threadId) ?? ""
            guard let r = decodeLossyString(c, forKey: .role) else {
                throw DecodingError.dataCorruptedError(forKey: .role, in: c, debugDescription: "Missing role")
            }
            role = r
            kind = decodeLossyString(c, forKey: .kind) ?? "message"
            guard let ct = decodeLossyString(c, forKey: .content) else {
                throw DecodingError.dataCorruptedError(forKey: .content, in: c, debugDescription: "Missing content")
            }
            content = ct
            sender = decodeLossyString(c, forKey: .sender)
            source = decodeLossyString(c, forKey: .source)
            createdAt = decodeLossyString(c, forKey: .createdAt) ?? ISO8601DateFormatter().string(from: Date())
            metadataValue = try? c.decodeIfPresent(JSONValue.self, forKey: .metadata)
        } else {
            let c = try decoder.container(keyedBy: AltCodingKeys.self)
            serverId = decodeLossyInt(c, forKey: .serverId) ?? 0
            threadId = decodeLossyString(c, forKey: .threadId) ?? ""
            guard let r = decodeLossyString(c, forKey: .role) else {
                throw DecodingError.dataCorruptedError(forKey: .role, in: c, debugDescription: "Missing role")
            }
            role = r
            kind = decodeLossyString(c, forKey: .kind) ?? "message"
            guard let ct = decodeLossyString(c, forKey: .content) else {
                throw DecodingError.dataCorruptedError(forKey: .content, in: c, debugDescription: "Missing content")
            }
            content = ct
            sender = decodeLossyString(c, forKey: .sender)
            source = decodeLossyString(c, forKey: .source)
            createdAt = decodeLossyString(c, forKey: .createdAt) ?? ISO8601DateFormatter().string(from: Date())
            metadataValue = try? c.decodeIfPresent(JSONValue.self, forKey: .metadata)
        }

        self.serverId = serverId
        self.threadId = threadId
        self.role = role
        self.kind = kind
        self.content = content
        self.sender = sender
        self.source = source
        self.createdAt = createdAt
        self.metadata = metadataValue
        self.localId = serverId > 0 ? "s\(serverId)" : "s\(serverId)_\(UUID().uuidString)"
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(serverId, forKey: .serverId)
        try c.encode(threadId, forKey: .threadId)
        try c.encode(role, forKey: .role)
        try c.encode(kind, forKey: .kind)
        try c.encode(content, forKey: .content)
        try c.encodeIfPresent(sender, forKey: .sender)
        try c.encodeIfPresent(source, forKey: .source)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(metadata, forKey: .metadata)
    }
}

// MARK: - Lossy decoding helpers

private func decodeLossyString<K: CodingKey>(_ container: KeyedDecodingContainer<K>, forKey key: K) -> String? {
    if let v = try? container.decodeIfPresent(String.self, forKey: key) { return v }
    if let v = try? container.decodeIfPresent(Int.self, forKey: key) { return String(v) }
    if let v = try? container.decodeIfPresent(Double.self, forKey: key) { return String(v) }
    if let v = try? container.decodeIfPresent(Bool.self, forKey: key) { return v ? "true" : "false" }
    return nil
}

private func decodeLossyInt<K: CodingKey>(_ container: KeyedDecodingContainer<K>, forKey key: K) -> Int? {
    if let v = try? container.decodeIfPresent(Int.self, forKey: key) { return v }
    if let v = try? container.decodeIfPresent(String.self, forKey: key) { return Int(v) }
    if let v = try? container.decodeIfPresent(Double.self, forKey: key) { return Int(v) }
    return nil
}
