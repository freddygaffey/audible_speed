import Foundation

struct APIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Type-erased Encodable so request bodies can be passed as dictionaries/structs.
private struct AnyEncodable: Encodable {
    private let encodeImpl: (Encoder) throws -> Void
    init(_ wrapped: Encodable) { encodeImpl = wrapped.encode }
    func encode(to encoder: Encoder) throws { try encodeImpl(encoder) }
}

/// Thin REST client for the Speed server (`/api/audible/*`).
final class APIClient: @unchecked Sendable {
    var baseURL: String
    private let session: URLSession

    init(baseURL: String) {
        self.baseURL = baseURL
        let cfg = URLSessionConfiguration.default
        cfg.waitsForConnectivity = true
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 600
        self.session = URLSession(configuration: cfg)
    }

    private func makeURL(_ path: String) throws -> URL {
        guard let url = URL(string: baseURL + "/api" + path) else {
            throw APIError(message: "Invalid server URL: \(baseURL)")
        }
        return url
    }

    private func send<T: Decodable>(
        _ path: String,
        method: String = "GET",
        body: Encodable? = nil,
        as type: T.Type
    ) async throws -> T {
        var req = URLRequest(url: try makeURL(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body {
            req.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }

        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch {
            throw APIError(message: "Network error contacting \(baseURL): \(error.localizedDescription)")
        }

        guard let http = resp as? HTTPURLResponse else {
            throw APIError(message: "No HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let msg = (obj["error"] as? String) ?? (obj["message"] as? String) {
                throw APIError(message: msg)
            }
            let raw = String(data: data, encoding: .utf8) ?? ""
            throw APIError(message: raw.isEmpty ? "HTTP \(http.statusCode)" : String(raw.prefix(300)))
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError(message: "Could not decode \(T.self): \(error.localizedDescription)")
        }
    }

    // MARK: Auth
    func authStatus() async throws -> AuthStatus {
        try await send("/audible/auth/status", as: AuthStatus.self)
    }
    func initLogin(marketplace: String) async throws -> InitLogin {
        try await send("/audible/auth/login", method: "POST",
                       body: ["marketplace": marketplace], as: InitLogin.self)
    }
    func completeLogin(pendingId: String, maplandingUrl: String) async throws -> CompleteLoginResult {
        try await send("/audible/auth/complete-url", method: "POST",
                       body: ["pendingId": pendingId, "maplandingUrl": maplandingUrl],
                       as: CompleteLoginResult.self)
    }
    func logout() async throws {
        _ = try await send("/audible/auth/logout", method: "POST", as: MessageResponse.self)
    }

    // MARK: Library
    func library(page: Int = 1, pageSize: Int = 200) async throws -> LibraryResponse {
        try await send("/audible/library?page=\(page)&pageSize=\(pageSize)", as: LibraryResponse.self)
    }

    // MARK: Downloads
    func startDownload(asin: String, title: String, format: String = "m4b") async throws -> DownloadJob {
        try await send("/audible/download", method: "POST",
                       body: ["asin": asin, "title": title, "format": format], as: DownloadJob.self)
    }
    func downloads() async throws -> [DownloadJob] {
        try await send("/audible/downloads", as: [DownloadJob].self)
    }
    /// Direct, Range-streamable URL for a finished job's audio file (fed to AVPlayer).
    func fileURL(jobId: String) -> URL? {
        URL(string: baseURL + "/api/audible/download/\(jobId)/file")
    }

    // MARK: Chapters
    func chapters(asin: String) async throws -> ChapterInfo {
        try await send("/audible/chapters/\(asin)", as: ChapterInfo.self)
    }

    // MARK: Settings
    func setActivationBytes(_ bytes: String) async throws {
        _ = try await send("/audible/settings/activation-bytes", method: "POST",
                           body: ["activationBytes": bytes], as: MessageResponse.self)
    }
}
