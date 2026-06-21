import SwiftUI

/// Drives the server's Amazon PKCE flow: get a login URL → user logs in in Safari →
/// pastes the final redirect ("maplanding") URL back → server completes the exchange.
struct AuthView: View {
    @Environment(AppModel.self) private var app

    @State private var marketplace: Marketplace = .us
    @State private var pendingId: String?
    @State private var loginURL: URL?
    @State private var pasteURL = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        @Bindable var app = app
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("https://audible-speed.pebnum.com", text: $app.serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }

                Section("Marketplace") {
                    Picker("Region", selection: $marketplace) {
                        ForEach(Marketplace.allCases) { Text($0.label).tag($0) }
                    }
                }

                Section {
                    Button {
                        Task { await getLink() }
                    } label: {
                        Label(busy && loginURL == nil ? "Requesting…" : "Get Amazon login link",
                              systemImage: "link")
                    }
                    .disabled(busy)

                    if let loginURL {
                        Link(destination: loginURL) {
                            Label("Open Amazon login", systemImage: "safari")
                        }
                        Text("After signing in, copy the address of the final page you land on and paste it below.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                if loginURL != nil {
                    Section("Paste redirect URL") {
                        TextField("https://www.amazon.com/ap/maplanding?...", text: $pasteURL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button {
                            Task { await complete() }
                        } label: {
                            Label(busy ? "Completing…" : "Complete sign-in", systemImage: "checkmark.circle")
                        }
                        .disabled(busy || pasteURL.isEmpty)
                    }
                }

                if let error {
                    Section {
                        Text(error).foregroundStyle(.red).font(.footnote)
                    }
                }
            }
            .navigationTitle("Sign in")
        }
    }

    private func getLink() async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let res = try await app.api.initLogin(marketplace: marketplace.rawValue)
            pendingId = res.pendingId
            loginURL = URL(string: res.loginUrl)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func complete() async {
        guard let pendingId else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let res = try await app.api.completeLogin(pendingId: pendingId, maplandingUrl: pasteURL)
            if res.status == "success" {
                await app.refreshAuth()
            } else {
                self.error = res.error ?? "Sign-in failed"
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}
