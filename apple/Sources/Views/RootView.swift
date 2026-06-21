import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            switch app.authState {
            case .loading:
                ProgressView("Connecting…")
            case .signedOut:
                AuthView()
            case .signedIn:
                LibraryView()
            }
        }
        .task { await app.refreshAuth() }
    }
}
