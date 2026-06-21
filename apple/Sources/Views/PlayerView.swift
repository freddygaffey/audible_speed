import SwiftUI

struct PlayerView: View {
    let book: Book

    @Environment(AppModel.self) private var app
    @State private var audio = AudioController()
    @State private var phase: Phase = .preparing("Preparing…")

    enum Phase: Equatable {
        case preparing(String)
        case ready
        case failed(String)
    }

    var body: some View {
        VStack(spacing: 28) {
            cover

            VStack(spacing: 4) {
                Text(book.title).font(.headline).multilineTextAlignment(.center)
                if !book.authors.isEmpty {
                    Text(book.authors.joined(separator: ", "))
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            }

            switch phase {
            case .preparing(let msg):
                VStack(spacing: 10) {
                    ProgressView()
                    Text(msg).font(.footnote).foregroundStyle(.secondary)
                }
                .frame(maxHeight: .infinity)
            case .failed(let msg):
                ContentUnavailableView {
                    Label("Couldn't play", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(msg)
                } actions: {
                    Button("Retry") { Task { await prepare() } }
                }
                .frame(maxHeight: .infinity)
            case .ready:
                controls.frame(maxHeight: .infinity)
            }
        }
        .padding()
        .navigationTitle(book.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await prepare() }
        .onDisappear { audio.stop() }
    }

    // MARK: Pieces

    private var cover: some View {
        AsyncImage(url: URL(string: book.coverUrl ?? "")) { image in
            image.resizable().aspectRatio(contentMode: .fit)
        } placeholder: {
            Image(systemName: "book.closed").font(.largeTitle).foregroundStyle(.secondary)
        }
        .frame(width: 220, height: 220)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(radius: 8)
    }

    private var controls: some View {
        VStack(spacing: 24) {
            // Scrubber
            VStack(spacing: 4) {
                Slider(
                    value: Binding(get: { audio.currentTime },
                                   set: { audio.seek(to: $0) }),
                    in: 0...max(audio.duration, 1)
                )
                HStack {
                    Text(timeString(audio.currentTime))
                    Spacer()
                    Text(timeString(audio.duration))
                }
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
            }

            // Transport
            HStack(spacing: 44) {
                Button { audio.skip(-30) } label: {
                    Image(systemName: "gobackward.30").font(.title2)
                }
                Button { audio.toggle() } label: {
                    Image(systemName: audio.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 64))
                }
                Button { audio.skip(30) } label: {
                    Image(systemName: "goforward.30").font(.title2)
                }
            }
            .tint(.orange)

            // Speed
            VStack(spacing: 6) {
                HStack {
                    Button { audio.setRate(audio.rate - 0.1) } label: { Image(systemName: "minus.circle") }
                    Spacer()
                    Text(String(format: "%.1f×", audio.rate))
                        .font(.title3.weight(.bold).monospacedDigit())
                        .foregroundStyle(.orange)
                    Spacer()
                    Button { audio.setRate(audio.rate + 0.1) } label: { Image(systemName: "plus.circle") }
                }
                Slider(
                    value: Binding(get: { audio.rate }, set: { audio.setRate($0) }),
                    in: AudioController.minRate...AudioController.maxRate
                )
                HStack {
                    Text("0.5×"); Spacer(); Text("16×")
                }
                .font(.caption2).foregroundStyle(.secondary)
            }

            if let err = audio.errorMessage {
                Text(err).font(.caption).foregroundStyle(.red).multilineTextAlignment(.center)
            }
        }
    }

    // MARK: Orchestration

    private func prepare() async {
        phase = .preparing("Checking download…")
        do {
            var job = try await findDoneJob()
            if job == nil {
                phase = .preparing("Starting download…")
                _ = try await app.api.startDownload(asin: book.asin, title: book.title)
                job = try await pollUntilDone()
            }
            guard let job, let url = app.api.fileURL(jobId: job.id) else {
                throw APIError(message: "No playable file for this title.")
            }
            audio.load(
                url: url,
                title: book.title,
                author: book.authors.joined(separator: ", "),
                resumeSeconds: (book.lastPositionMs ?? 0) / 1000
            )
            phase = .ready
            audio.play()
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private func findDoneJob() async throws -> DownloadJob? {
        try await app.api.downloads().first { $0.asin == book.asin && $0.status == "done" }
    }

    private func pollUntilDone() async throws -> DownloadJob {
        for _ in 0..<300 {  // ~10 min ceiling at 2s intervals
            try await Task.sleep(for: .seconds(2))
            let jobs = try await app.api.downloads().filter { $0.asin == book.asin }
            if let done = jobs.first(where: { $0.status == "done" }) { return done }
            if let err = jobs.first(where: { $0.status == "error" }) {
                throw APIError(message: err.error ?? "Download failed on the server.")
            }
            if let active = jobs.first(where: { $0.status == "downloading" || $0.status == "converting" || $0.status == "queued" }) {
                let pct = Int((active.progress * 100).rounded())
                phase = .preparing("\(active.status.capitalized)… \(pct)%")
            }
        }
        throw APIError(message: "Timed out waiting for the download.")
    }

    private func timeString(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let s = Int(seconds)
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, sec)
            : String(format: "%d:%02d", m, sec)
    }
}
