import Foundation
import Capacitor
import AVFoundation
import QuartzCore

@objc(NativeAudioPlugin)
public class NativeAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeAudioPlugin"
    public let jsName = "NativeAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seekTo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unload", returnType: CAPPluginReturnPromise)
    ]

    private enum PlaybackBackend {
        case none
        case engine
        case player
    }

    private var backend: PlaybackBackend = .none

    // High-speed local-file path.
    private var audioEngine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var varispeedNode: AVAudioUnitVarispeed?
    private var audioFile: AVAudioFile?
    private var sampleRate: Double = 0
    private var totalFrames: AVAudioFramePosition = 0
    private var currentFrame: AVAudioFramePosition = 0
    private var anchorFrame: AVAudioFramePosition = 0
    private var anchorHostTime: CFTimeInterval = 0
    private var isEngineScheduled = false
    private var scheduledChunkStart: AVAudioFramePosition = 0
    private var scheduledChunkCount: AVAudioFrameCount = 0
    private var playing = false

    // Streaming/non-file fallback path.
    private var player: AVPlayer?
    private var endedObserver: NSObjectProtocol?
    private var failedObserver: NSObjectProtocol?
    private var statusTimer: DispatchSourceTimer?

    private var targetRate: Float = 1.0
    private var autotestAudioURL: URL?
    private var autotestRates: [Float] = []
    private var autotestIndex = 0
    private var autotestResults: [[String: Any]] = []

    @objc public func prepare(_ call: CAPPluginCall) {
        guard let src = call.getString("src"), let url = resolveSourceUrl(src) else {
            call.reject("Missing or invalid src")
            return
        }
        withMain {
            self.unloadInternal()
            self.configureAudioSession()
            self.targetRate = self.clampRate(Float(call.getDouble("rate") ?? 1.0))

            do {
                if url.isFileURL {
                    try self.prepareEngine(url: url)
                } else {
                    self.prepareStreamPlayer(url: url)
                }
                call.resolve(self.statusPayload())
            } catch {
                call.reject("Failed to prepare native audio: \(error.localizedDescription)")
            }
        }
    }

    @objc public func play(_ call: CAPPluginCall) {
        withMain {
            switch self.backend {
            case .none:
                call.reject("Player not prepared")
            case .engine:
                self.playEngine(call)
            case .player:
                self.playStreamPlayer(call)
            }
        }
    }

    @objc public func pause(_ call: CAPPluginCall) {
        withMain {
            switch self.backend {
            case .none:
                call.reject("Player not prepared")
            case .engine:
                self.pauseEngine(call)
            case .player:
                self.pauseStreamPlayer(call)
            }
        }
    }

    @objc public func seekTo(_ call: CAPPluginCall) {
        let seconds = max(0.0, call.getDouble("position") ?? 0.0)
        withMain {
            switch self.backend {
            case .none:
                call.reject("Player not prepared")
            case .engine:
                self.seekEngine(to: seconds, call: call)
            case .player:
                self.seekStreamPlayer(to: seconds, call: call)
            }
        }
    }

    @objc public func setRate(_ call: CAPPluginCall) {
        let nextRate = clampRate(Float(call.getDouble("rate") ?? 1.0))
        withMain {
            self.targetRate = nextRate
            switch self.backend {
            case .none:
                call.reject("Player not prepared")
            case .engine:
                self.applyEngineRate()
                self.emitStatus()
                call.resolve(self.statusPayload())
            case .player:
                self.applyStreamRateIfPlaying()
                self.emitStatus()
                call.resolve(self.statusPayload())
            }
        }
    }

    @objc public func getStatus(_ call: CAPPluginCall) {
        withMain {
            call.resolve(self.statusPayload())
        }
    }

    @objc public func unload(_ call: CAPPluginCall) {
        withMain {
            self.unloadInternal()
            call.resolve()
        }
    }

    deinit {
        unloadInternal()
    }

    private func configureAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            notifyListeners("error", data: ["message": "Audio session failed: \(error.localizedDescription)"])
        }
    }

    private func prepareEngine(url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw NSError(domain: "NativeAudio", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local file not found"])
        }

        let file = try AVAudioFile(forReading: url)
        let engine = AVAudioEngine()
        let node = AVAudioPlayerNode()
        let varispeed = AVAudioUnitVarispeed()

        engine.attach(node)
        engine.attach(varispeed)
        engine.connect(node, to: varispeed, format: file.processingFormat)
        engine.connect(varispeed, to: engine.mainMixerNode, format: file.processingFormat)

        varispeed.rate = targetRate

        try engine.start()

        self.audioFile = file
        self.audioEngine = engine
        self.playerNode = node
        self.varispeedNode = varispeed
        self.sampleRate = file.fileFormat.sampleRate
        self.totalFrames = file.length
        self.currentFrame = 0
        self.anchorFrame = 0
        self.anchorHostTime = CACurrentMediaTime()
        self.playing = false
        self.isEngineScheduled = false
        self.backend = .engine
        self.startStatusLoop()
        self.emitStatus()
    }

    private func prepareStreamPlayer(url: URL) {
        let item = AVPlayerItem(url: url)
        item.audioTimePitchAlgorithm = .varispeed
        let nextPlayer = AVPlayer(playerItem: item)
        nextPlayer.automaticallyWaitsToMinimizeStalling = true
        player = nextPlayer
        backend = .player
        playing = false

        endedObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.playing = false
            self.notifyListeners("ended", data: [:])
            self.emitStatus()
        }
        failedObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] note in
            let err = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? NSError
            self?.notifyListeners("error", data: [
                "message": "iOS native playback failed: \(err?.localizedDescription ?? "unknown")"
            ])
            self?.emitStatus()
        }

        startStatusLoop()
        emitStatus()
    }

    private func unloadInternal() {
        stopStatusLoop()

        playerNode?.stop()
        audioEngine?.stop()
        playerNode = nil
        varispeedNode = nil
        audioFile = nil
        audioEngine = nil
        sampleRate = 0
        totalFrames = 0
        currentFrame = 0
        anchorFrame = 0
        anchorHostTime = 0
        isEngineScheduled = false
        scheduledChunkStart = 0
        scheduledChunkCount = 0
        playing = false

        if let observer = endedObserver {
            NotificationCenter.default.removeObserver(observer)
            endedObserver = nil
        }
        if let observer = failedObserver {
            NotificationCenter.default.removeObserver(observer)
            failedObserver = nil
        }
        player?.pause()
        player = nil
        backend = .none
    }

    private func statusPayload() -> [String: Any] {
        switch backend {
        case .none:
            return [
                "position": 0.0,
                "duration": 0.0,
                "playing": false,
                "buffering": false,
                "rate": Double(targetRate),
                "engine": "none"
            ]
        case .engine:
            let duration = sampleRate > 0 ? Double(totalFrames) / sampleRate : 0
            let position = sampleRate > 0 ? Double(computedCurrentFrame()) / sampleRate : 0
            return [
                "position": max(0.0, min(duration, position)),
                "duration": max(0.0, duration),
                "playing": playing,
                "buffering": false,
                "rate": Double(targetRate),
                "engine": "avAudioEngine"
            ]
        case .player:
            guard let player else {
                return [
                    "position": 0.0,
                    "duration": 0.0,
                    "playing": false,
                    "buffering": false,
                    "rate": Double(targetRate),
                    "engine": "avPlayer"
                ]
            }
            let current = player.currentTime().seconds
            let rawDuration = player.currentItem?.duration.seconds ?? 0.0
            let position = current.isFinite ? current : 0.0
            let duration = rawDuration.isFinite ? rawDuration : 0.0
            return [
                "position": max(0.0, position),
                "duration": max(0.0, duration),
                "playing": player.rate > 0.0,
                "buffering": player.timeControlStatus == .waitingToPlayAtSpecifiedRate,
                "rate": Double(targetRate),
                "engine": "avPlayer"
            ]
        }
    }

    private func emitStatus() {
        notifyListeners("status", data: statusPayload())
    }

    private func clampRate(_ requested: Float) -> Float {
        max(0.5, min(16.0, requested))
    }

    private func applyEngineRate() {
        guard backend == .engine else { return }
        if playing {
            let frame = computedCurrentFrame()
            currentFrame = frame
            anchorFrame = frame
            anchorHostTime = CACurrentMediaTime()
        }
        varispeedNode?.rate = targetRate
    }

    private func applyStreamRateIfPlaying() {
        guard backend == .player, let player else { return }
        if player.timeControlStatus == .playing {
            if targetRate != 1.0 {
                player.playImmediately(atRate: targetRate)
            } else {
                player.play()
            }
        }
    }

    private func ensureEngineScheduled() {
        guard backend == .engine, !isEngineScheduled else { return }
        guard let file = audioFile, let node = playerNode else { return }

        let safeCurrent = max(0, min(currentFrame, totalFrames))
        let remaining = totalFrames - safeCurrent
        guard remaining > 0 else {
            notifyListeners("ended", data: [:])
            emitStatus()
            return
        }

        currentFrame = safeCurrent
        anchorFrame = safeCurrent
        isEngineScheduled = true
        scheduledChunkStart = safeCurrent
        let maxChunkFrames = AVAudioFramePosition(UInt32.max - 1)
        let chunk = min(remaining, maxChunkFrames)
        scheduledChunkCount = AVAudioFrameCount(chunk)
        node.scheduleSegment(
            file,
            startingFrame: safeCurrent,
            frameCount: scheduledChunkCount,
            at: nil
        ) { [weak self] in
            self?.withMain {
                self?.handleEngineChunkCompleted()
            }
        }
    }

    private func handleEngineChunkCompleted() {
        guard backend == .engine else { return }
        if !playing {
            isEngineScheduled = false
            return
        }

        currentFrame = max(0, min(scheduledChunkStart + AVAudioFramePosition(scheduledChunkCount), totalFrames))
        anchorFrame = currentFrame
        anchorHostTime = CACurrentMediaTime()
        isEngineScheduled = false

        if currentFrame >= totalFrames {
            playing = false
            notifyListeners("ended", data: [:])
            emitStatus()
            return
        }

        ensureEngineScheduled()
        playerNode?.play()
        emitStatus()
    }

    private func computedCurrentFrame() -> AVAudioFramePosition {
        guard backend == .engine else { return 0 }
        if !playing || sampleRate <= 0 {
            return max(0, min(currentFrame, totalFrames))
        }
        let elapsed = max(0, CACurrentMediaTime() - anchorHostTime)
        let advanced = Double(targetRate) * sampleRate * elapsed
        let frame = anchorFrame + AVAudioFramePosition(advanced.rounded(.down))
        return max(0, min(frame, totalFrames))
    }

    private func playEngine(_ call: CAPPluginCall) {
        guard backend == .engine, let engine = audioEngine, let node = playerNode else {
            call.reject("Player not prepared")
            return
        }

        if playing {
            call.resolve(statusPayload())
            return
        }

        if !engine.isRunning {
            do {
                try engine.start()
            } catch {
                call.reject("Failed to start audio engine: \(error.localizedDescription)")
                return
            }
        }

        ensureEngineScheduled()
        if totalFrames > 0 && currentFrame >= totalFrames {
            currentFrame = 0
            anchorFrame = 0
            isEngineScheduled = false
            ensureEngineScheduled()
        }

        varispeedNode?.rate = targetRate
        anchorFrame = currentFrame
        anchorHostTime = CACurrentMediaTime()
        node.play()
        playing = true
        emitStatus()
        call.resolve(statusPayload())
    }

    private func pauseEngine(_ call: CAPPluginCall) {
        guard backend == .engine, let node = playerNode else {
            call.reject("Player not prepared")
            return
        }

        if playing {
            currentFrame = computedCurrentFrame()
        }
        anchorFrame = currentFrame
        playing = false
        node.pause()
        node.stop()
        isEngineScheduled = false
        emitStatus()
        call.resolve(statusPayload())
    }

    private func seekEngine(to seconds: Double, call: CAPPluginCall) {
        guard backend == .engine, let node = playerNode else {
            call.reject("Player not prepared")
            return
        }
        guard sampleRate > 0 else {
            call.reject("Invalid audio sample rate")
            return
        }

        let target = AVAudioFramePosition((seconds * sampleRate).rounded(.down))
        currentFrame = max(0, min(target, totalFrames))
        anchorFrame = currentFrame

        if playing {
            node.stop()
            isEngineScheduled = false
            ensureEngineScheduled()
            anchorHostTime = CACurrentMediaTime()
            node.play()
        } else {
            node.stop()
            isEngineScheduled = false
        }

        emitStatus()
        call.resolve(statusPayload())
    }

    private func playStreamPlayer(_ call: CAPPluginCall) {
        guard let player else {
            call.reject("Player not prepared")
            return
        }
        if targetRate != 1.0 {
            player.playImmediately(atRate: targetRate)
        } else {
            player.play()
        }
        playing = true
        emitStatus()
        call.resolve(statusPayload())
    }

    private func pauseStreamPlayer(_ call: CAPPluginCall) {
        guard let player else {
            call.reject("Player not prepared")
            return
        }
        player.pause()
        playing = false
        emitStatus()
        call.resolve(statusPayload())
    }

    private func seekStreamPlayer(to seconds: Double, call: CAPPluginCall) {
        guard let player else {
            call.reject("Player not prepared")
            return
        }
        let target = CMTime(seconds: seconds, preferredTimescale: 600)
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            self?.emitStatus()
            call.resolve(self?.statusPayload() ?? [:])
        }
    }

    private func startStatusLoop() {
        stopStatusLoop()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(250))
        timer.setEventHandler { [weak self] in
            self?.emitStatus()
        }
        statusTimer = timer
        timer.resume()
    }

    private func stopStatusLoop() {
        statusTimer?.cancel()
        statusTimer = nil
    }

    private func withMain(_ block: @escaping () -> Void) {
        if Thread.isMainThread {
            block()
            return
        }
        DispatchQueue.main.async(execute: block)
    }

    @objc public func runAutotestMatrix() {
        withMain {
            self.runAutotestMatrixInternal()
        }
    }

    private func runAutotestMatrixInternal() {
        do {
            let sourceURL = try createAutotestToneFile()
            autotestAudioURL = sourceURL

            unloadInternal()
            configureAudioSession()
            targetRate = 1.0
            try prepareEngine(url: sourceURL)

            autotestRates = [1.0, 2.0, 4.0, 8.0, 16.0]
            autotestIndex = 0
            autotestResults = []
            writeAutotestReport(state: "running", reason: nil)
            NSLog("SPEED_AUTOTEST_NATIVE_AUDIO start rates=\(autotestRates)")
            print("SPEED_AUTOTEST_NATIVE_AUDIO start rates=\(autotestRates)")
            runNextAutotestStep()
        } catch {
            NSLog("SPEED_AUTOTEST_NATIVE_AUDIO fail prepare=\(error.localizedDescription)")
            print("SPEED_AUTOTEST_NATIVE_AUDIO fail prepare=\(error.localizedDescription)")
            writeAutotestReport(state: "fail", reason: "prepare_error")
            finishAutotestCleanup()
        }
    }

    private func runNextAutotestStep() {
        if autotestIndex >= autotestRates.count {
            NSLog("SPEED_AUTOTEST_NATIVE_AUDIO pass")
            print("SPEED_AUTOTEST_NATIVE_AUDIO pass")
            writeAutotestReport(state: "pass", reason: nil)
            finishAutotestCleanup()
            return
        }
        guard backend == .engine else {
            NSLog("SPEED_AUTOTEST_NATIVE_AUDIO fail backend=not_engine")
            print("SPEED_AUTOTEST_NATIVE_AUDIO fail backend=not_engine")
            writeAutotestReport(state: "fail", reason: "backend_not_engine")
            finishAutotestCleanup()
            return
        }
        guard let node = playerNode else {
            NSLog("SPEED_AUTOTEST_NATIVE_AUDIO fail node=missing")
            print("SPEED_AUTOTEST_NATIVE_AUDIO fail node=missing")
            writeAutotestReport(state: "fail", reason: "node_missing")
            finishAutotestCleanup()
            return
        }

        let rate = autotestRates[autotestIndex]
        targetRate = rate
        applyEngineRate()

        currentFrame = 0
        anchorFrame = 0
        node.stop()
        isEngineScheduled = false
        ensureEngineScheduled()
        varispeedNode?.rate = targetRate
        anchorFrame = currentFrame
        anchorHostTime = CACurrentMediaTime()
        node.play()
        playing = true

        let startPos = statusPositionSeconds()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self else { return }
            let endPos = self.statusPositionSeconds()
            let delta = endPos - startPos
            let monotonic = delta > 0.02
            let minimumExpected = Double(rate) * 0.25
            let speedOk = delta >= minimumExpected
            self.autotestResults.append([
                "rate": Double(rate),
                "delta": delta,
                "monotonic": monotonic,
                "speedOk": speedOk
            ])
            self.writeAutotestReport(state: "running", reason: nil)
            NSLog(
                "SPEED_AUTOTEST_NATIVE_AUDIO rate=\(rate) delta=\(String(format: "%.3f", delta)) monotonic=\(monotonic) speedOk=\(speedOk)"
            )
            print(
                "SPEED_AUTOTEST_NATIVE_AUDIO rate=\(rate) delta=\(String(format: "%.3f", delta)) monotonic=\(monotonic) speedOk=\(speedOk)"
            )

            self.playing = false
            self.playerNode?.pause()
            self.playerNode?.stop()
            self.isEngineScheduled = false
            self.currentFrame = 0
            self.anchorFrame = 0

            if !monotonic || !speedOk {
                NSLog("SPEED_AUTOTEST_NATIVE_AUDIO fail rate=\(rate)")
                print("SPEED_AUTOTEST_NATIVE_AUDIO fail rate=\(rate)")
                self.writeAutotestReport(state: "fail", reason: "rate_\(rate)_failed")
                self.finishAutotestCleanup()
                return
            }

            self.autotestIndex += 1
            self.runNextAutotestStep()
        }
    }

    private func finishAutotestCleanup() {
        unloadInternal()
        if let url = autotestAudioURL {
            try? FileManager.default.removeItem(at: url)
            autotestAudioURL = nil
        }
        autotestRates = []
        autotestIndex = 0
        autotestResults = []
    }

    private func statusPositionSeconds() -> Double {
        if backend == .engine, sampleRate > 0 {
            return Double(computedCurrentFrame()) / sampleRate
        }
        if backend == .player, let player {
            let value = player.currentTime().seconds
            return value.isFinite ? max(0, value) : 0
        }
        return 0
    }

    private func createAutotestToneFile() throws -> URL {
        let sampleRate = 44_100.0
        let durationSeconds = 24.0
        let totalFrames = AVAudioFrameCount(sampleRate * durationSeconds)
        let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("speed-native-audio-autotest-\(UUID().uuidString)")
            .appendingPathExtension("caf")
        let file = try AVAudioFile(forWriting: tmp, settings: format.settings)
        var written: AVAudioFrameCount = 0
        let chunk: AVAudioFrameCount = 4096
        while written < totalFrames {
            let frameCount = min(chunk, totalFrames - written)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
                throw NSError(domain: "NativeAudio", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to allocate PCM buffer"])
            }
            buffer.frameLength = frameCount
            if let channel = buffer.floatChannelData?.pointee {
                for i in 0..<Int(frameCount) {
                    let frame = Float(Int(written) + i)
                    channel[i] = 0.08 * sinf((2 * Float.pi * 440 * frame) / Float(sampleRate))
                }
            }
            try file.write(from: buffer)
            written += frameCount
        }
        return tmp
    }

    private func writeAutotestReport(state: String, reason: String?) {
        var payload: [String: Any] = [
            "state": state,
            "results": autotestResults
        ]
        if let reason {
            payload["reason"] = reason
        }
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
           let json = String(data: data, encoding: .utf8) {
            UserDefaults.standard.set(json, forKey: "SpeedAutotestReportJson")
            UserDefaults.standard.synchronize()
        }
    }

    private func resolveSourceUrl(_ src: String) -> URL? {
        if src.hasPrefix("/") {
            return URL(fileURLWithPath: src)
        }

        if src.hasPrefix("file://") {
            if let parsed = URL(string: src), parsed.isFileURL {
                return parsed.standardizedFileURL
            }
            let rawPath = src.replacingOccurrences(of: "file://", with: "")
            let decodedPath = rawPath.removingPercentEncoding ?? rawPath
            return URL(fileURLWithPath: decodedPath)
        }

        // Capacitor webview playback URLs are not directly playable by AVPlayer.
        // Convert:
        // - http://localhost/_capacitor_file_/var/mobile/... -> file:///var/mobile/...
        // - capacitor://localhost/_capacitor_file_/var/mobile/... -> file:///var/mobile/...
        if let range = src.range(of: "/_capacitor_file_/") {
            let rawPath = String(src[range.upperBound...])
            let decodedPath = rawPath.removingPercentEncoding ?? rawPath
            if decodedPath.hasPrefix("/") {
                return URL(fileURLWithPath: decodedPath)
            }
            return URL(fileURLWithPath: "/\(decodedPath)")
        }

        // Network URLs can be used as-is.
        return URL(string: src)
    }
}
