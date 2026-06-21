import SwiftUI

struct LibraryView: View {
    @Environment(AppModel.self) private var app
    @State private var books: [Book] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView("Loading library…")
                } else if let error {
                    ContentUnavailableView {
                        Label("Couldn't load library", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Retry") { Task { await load() } }
                    }
                } else if books.isEmpty {
                    ContentUnavailableView("No books", systemImage: "books.vertical")
                } else {
                    List(books) { book in
                        NavigationLink(value: book) { BookRow(book: book) }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Library")
            .navigationDestination(for: Book.self) { PlayerView(book: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { Task { await load() } } label: { Label("Reload", systemImage: "arrow.clockwise") }
                        Button(role: .destructive) { Task { await app.signOut() } } label: {
                            Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        loading = true; error = nil
        defer { loading = false }
        do {
            books = try await app.api.library().books
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct BookRow: View {
    let book: Book

    var body: some View {
        HStack(spacing: 12) {
            AsyncImage(url: URL(string: book.coverUrl ?? "")) { image in
                image.resizable().aspectRatio(contentMode: .fill)
            } placeholder: {
                Image(systemName: "book.closed").foregroundStyle(.secondary)
            }
            .frame(width: 52, height: 52)
            .background(.quaternary)
            .clipShape(RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 2) {
                Text(book.title).font(.subheadline).fontWeight(.medium).lineLimit(2)
                if !book.authors.isEmpty {
                    Text(book.authors.joined(separator: ", "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if book.status == "downloaded" {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).font(.caption)
            }
        }
        .padding(.vertical, 2)
    }
}
