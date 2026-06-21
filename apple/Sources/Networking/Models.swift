import Foundation

// Mirrors the Zod schemas the server returns (see artifacts/api-server + the old web apiClient.ts).

struct AuthStatus: Codable, Sendable {
    let authenticated: Bool
    let username: String?
    let email: String?
    let marketplace: String?
}

struct InitLogin: Codable, Sendable {
    let loginUrl: String
    let pendingId: String
}

/// `complete-url` returns a discriminated union ({status:"success",...} | {status:"error",error}).
/// Decoded leniently into one struct.
struct CompleteLoginResult: Codable, Sendable {
    let status: String
    let username: String?
    let email: String?
    let marketplace: String?
    let error: String?
}

struct Book: Codable, Identifiable, Hashable, Sendable {
    var id: String { asin }
    let asin: String
    let title: String
    let subtitle: String?
    let authors: [String]
    let narrators: [String]
    let coverUrl: String?
    let runtimeMinutes: Double?
    let purchaseDate: String?
    let seriesTitle: String?
    let seriesPosition: String?
    let releaseDate: String?
    let description: String?
    let lastPositionMs: Double?
    let lastPositionUpdated: String?
    let status: String   // available | downloaded | downloading
}

struct LibraryResponse: Codable, Sendable {
    let books: [Book]
    let total: Int
    let page: Int
    let pageSize: Int
}

struct DownloadJob: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let asin: String
    let title: String
    let status: String   // queued | downloading | converting | done | error
    let progress: Double
    let format: String
    let outputPath: String?
    let error: String?
    let createdAt: String
    let updatedAt: String
}

struct Chapter: Codable, Hashable, Sendable {
    let title: String
    let startOffsetMs: Double
    let lengthMs: Double
}

struct ChapterInfo: Codable, Sendable {
    let runtimeLengthMs: Double?
    let isAccurate: Bool?
    let chapters: [Chapter]
}

struct MessageResponse: Codable, Sendable {
    let message: String
}

/// Known Audible marketplaces (server accepts the short code).
enum Marketplace: String, CaseIterable, Identifiable {
    case us, uk, de, fr, ca, au, jp, it, es, india = "in", br
    var id: String { rawValue }
    var label: String { rawValue.uppercased() }
}
