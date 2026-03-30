import Foundation

/// File-based cache for offline data persistence.
/// Stores Codable data as JSON files in the app's caches directory, scoped by project.
enum CacheManager {
    private static var cacheDir: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CommandCenter", isDirectory: true)
    }

    private static func fileURL(key: String, projectId: String) -> URL {
        let dir = cacheDir.appendingPathComponent(projectId, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(key).json")
    }

    /// Save a Codable value to disk.
    static func save<T: Encodable>(_ value: T, key: String, projectId: String) {
        let url = fileURL(key: key, projectId: projectId)
        do {
            let data = try JSONEncoder().encode(value)
            try data.write(to: url, options: .atomic)
        } catch {
            // Cache write failures are non-fatal
        }
    }

    /// Load a Codable value from disk. Returns nil if not cached or decode fails.
    static func load<T: Decodable>(_ type: T.Type, key: String, projectId: String) -> T? {
        let url = fileURL(key: key, projectId: projectId)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    /// Check if a cache file exists.
    static func exists(key: String, projectId: String) -> Bool {
        FileManager.default.fileExists(atPath: fileURL(key: key, projectId: projectId).path)
    }
}
