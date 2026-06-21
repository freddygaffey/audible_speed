import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    enum AuthState: Equatable { case loading, signedOut, signedIn }

    var serverURL: String {
        didSet {
            UserDefaults.standard.set(serverURL, forKey: "serverURL")
            api.baseURL = AppModel.normalize(serverURL)
        }
    }
    var authState: AuthState = .loading
    var session: AuthStatus?
    var lastError: String?

    let api: APIClient

    init() {
        let stored = UserDefaults.standard.string(forKey: "serverURL") ?? "https://audible-speed.pebnum.com"
        serverURL = stored
        api = APIClient(baseURL: AppModel.normalize(stored))
    }

    static func normalize(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        while t.hasSuffix("/") { t.removeLast() }
        return t
    }

    func refreshAuth() async {
        do {
            let status = try await api.authStatus()
            session = status
            authState = status.authenticated ? .signedIn : .signedOut
            lastError = nil
        } catch {
            // Can't reach server (or not authed) — treat as signed out so the UI is usable.
            session = nil
            authState = .signedOut
            lastError = error.localizedDescription
        }
    }

    func signOut() async {
        try? await api.logout()
        session = nil
        authState = .signedOut
    }
}
