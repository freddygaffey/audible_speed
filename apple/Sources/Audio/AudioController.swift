import Foundation
import AVFoundation
import MediaPlayer
import Observation

/// AVPlayer-backed audio engine with pitch-preserving high-speed playback,
/// background audio, and lock-screen / Control Center controls.
@MainActor
@Observable
final class AudioController {
    private let player = AVPlayer()
    nonisolated(unsafe) private var timeObserver: Any?
    nonisolated(unsafe) private var endObserver: NSObjectProtocol?
    private var commandsInstalled = false

    var isPlaying = false
    var currentTime: Double = 0
    var duration: Double = 0
    var rate: Double = 1.0
    var title = ""
    var author = ""
    var errorMessage: String?

    static let minRate: Double = 0.5
    static let maxRate: Double = 16.0

    init() {
        let saved = UserDefaults.standard.double(forKey: "speed")
        rate = saved > 0 ? saved : 1.0
        configureSession()
        installRemoteCommands()
        installTimeObserver()
    }

    // MARK: Setup

    private func configureSession() {
        #if os(iOS)
        do {
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playback, mode: .spokenAudio)
            try s.setActive(true)
        } catch {
            errorMessage = "Audio session error: \(error.localizedDescription)"
        }
        #endif
    }

    private func installTimeObserver() {
        let interval = CMTime(seconds: 0.5, preferredTimescale: 600)
        timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            // Delivered on the main queue, so main-actor access is safe.
            MainActor.assumeIsolated {
                guard let self else { return }
                self.currentTime = time.seconds.isFinite ? time.seconds : 0
                if let d = self.player.currentItem?.duration.seconds, d.isFinite, d > 0 {
                    self.duration = d
                }
                self.updateNowPlaying()
            }
        }
    }

    private func installRemoteCommands() {
        guard !commandsInstalled else { return }
        commandsInstalled = true
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.play() }; return .success
        }
        c.pauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.pause() }; return .success
        }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.toggle() }; return .success
        }
        c.skipForwardCommand.preferredIntervals = [30]
        c.skipForwardCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.skip(30) }; return .success
        }
        c.skipBackwardCommand.preferredIntervals = [30]
        c.skipBackwardCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.skip(-30) }; return .success
        }
        c.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            MainActor.assumeIsolated { self?.seek(to: e.positionTime) }
            return .success
        }
    }

    // MARK: Loading / transport

    func load(url: URL, title: String, author: String, resumeSeconds: Double = 0) {
        self.title = title
        self.author = author
        let item = AVPlayerItem(url: url)
        // .timeDomain = WSOLA-style; great for speech, cheap, pitch-preserved across the full range.
        item.audioTimePitchAlgorithm = .timeDomain
        player.replaceCurrentItem(with: item)

        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.isPlaying = false
                self?.updateNowPlaying()
            }
        }

        if resumeSeconds > 0 {
            player.seek(to: CMTime(seconds: resumeSeconds, preferredTimescale: 600))
            currentTime = resumeSeconds
        }
        errorMessage = nil
        updateNowPlaying()
    }

    func play() {
        player.rate = Float(rate)
        isPlaying = true
        updateNowPlaying()
    }

    func pause() {
        player.pause()
        isPlaying = false
        updateNowPlaying()
    }

    func toggle() { isPlaying ? pause() : play() }

    func skip(_ seconds: Double) {
        let upper = duration > 0 ? duration : .greatestFiniteMagnitude
        seek(to: max(0, min(upper, currentTime + seconds)))
    }

    func seek(to seconds: Double) {
        let clamped = max(0, seconds)
        player.seek(to: CMTime(seconds: clamped, preferredTimescale: 600))
        currentTime = clamped
        updateNowPlaying()
    }

    func setRate(_ newRate: Double) {
        rate = min(Self.maxRate, max(Self.minRate, newRate))
        UserDefaults.standard.set(rate, forKey: "speed")
        if isPlaying { player.rate = Float(rate) }
        updateNowPlaying()
    }

    func stop() {
        player.pause()
        player.replaceCurrentItem(with: nil)
        isPlaying = false
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    // MARK: Now Playing

    private func updateNowPlaying() {
        var info: [String: Any] = [:]
        info[MPMediaItemPropertyTitle] = title
        info[MPMediaItemPropertyArtist] = author
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTime
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? rate : 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    deinit {
        // NotificationCenter is global/thread-safe; safe to detach here.
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    }
}
