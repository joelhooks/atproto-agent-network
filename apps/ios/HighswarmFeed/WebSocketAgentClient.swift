import Foundation
import os.log

enum WSConnectionStatus: String, Equatable {
    case disconnected
    case connecting
    case live
    case reconnecting
    case error
}

struct WSStatusDetail: Equatable {
    let status: WSConnectionStatus
    let detail: String
    let attempt: Int
    let timestamp: Date
}

@MainActor
final class WebSocketAgentClient {
    // Keep this main-actor isolated. It's a UI app, and this avoids Swift 6 "sending" hell.
    // URLSessionWebSocketTask.receive() is async and doesn't block the main thread.
    typealias OnEvent = (_ raw: String, _ agentName: String) -> Void
    typealias OnStatus = (_ update: WSStatusDetail, _ agentName: String) -> Void

    private let log = Logger(subsystem: "com.joelhooks.highswarm.feed", category: "ws")

    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var isStopped = false
    private var didMarkLive = false
    private var pingGeneration = 0
    private var attempt = 0
    private var lastErrorSummary = "-"

    private let agentName: String
    private let wsURL: URL
    private let onEvent: OnEvent
    private let onStatus: OnStatus

    init(
        session: URLSession = .shared,
        agentName: String,
        wsURL: URL,
        onEvent: @escaping OnEvent,
        onStatus: @escaping OnStatus
    ) {
        self.session = session
        self.agentName = agentName
        self.wsURL = wsURL
        self.onEvent = onEvent
        self.onStatus = onStatus
    }

    func start() {
        isStopped = false
        attempt = 0
        lastErrorSummary = "-"
        connect(backoffSeconds: 0)
    }

    func stop() {
        isStopped = true
        pingGeneration &+= 1
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        didMarkLive = false
        emitStatus(.disconnected, "stopped")
    }

    private func connect(backoffSeconds: UInt64) {
        guard !isStopped else { return }

        Task { [weak self] in
            guard let self else { return }
            if backoffSeconds > 0 {
                self.emitStatus(.reconnecting, "retry in \(backoffSeconds)s (last=\(self.lastErrorSummary))")
                try? await Task.sleep(nanoseconds: backoffSeconds * 1_000_000_000)
            }

            guard !self.isStopped else { return }

            self.attempt += 1
            self.emitStatus(.connecting, "attempt \(self.attempt) -> \(self.wsURL.absoluteString)")
            self.didMarkLive = false
            self.pingGeneration &+= 1
            let gen = self.pingGeneration
            let t = self.session.webSocketTask(with: self.wsURL)
            self.task = t
            t.resume()

            // Don't lie: `.resume()` does not mean the WS handshake succeeded.
            // We'll flip to `.live` after the first successful receive or ping.
            self.schedulePing(afterSeconds: 1, generation: gen)
            await self.receiveLoop()
        }
    }

    private func schedulePing(afterSeconds: UInt64, generation: Int) {
        guard !isStopped else { return }
        guard let t = task else { return }
        guard generation == pingGeneration else { return }

        if afterSeconds > 0 {
            Task { [weak self] in
                guard let self else { return }
                try? await Task.sleep(nanoseconds: afterSeconds * 1_000_000_000)
                await MainActor.run { self.schedulePing(afterSeconds: 0, generation: generation) }
            }
            return
        }

        // Lightweight keepalive that also acts as a handshake/connection verifier.
        // If this fails, we transition to `.error` and reconnect.
        t.sendPing { [weak self] error in
            Task { @MainActor in
                guard let self else { return }
                guard !self.isStopped else { return }
                guard generation == self.pingGeneration else { return }
                if let error {
                    let short = Self.shortError(error)
                    self.lastErrorSummary = "ping: \(short)"
                    self.log.error("ws ping error agent=\(self.agentName, privacy: .public) err=\(String(describing: error), privacy: .public)")
                    // If we haven't marked the socket as live yet, be tolerant:
                    // URLSessionWebSocketTask can report transient ping errors during handshake.
                    // Canceling here causes a reconnect loop that looks like "stuck reconnecting".
                    if self.didMarkLive {
                        self.emitStatus(.error, "ping failed: \(short)")
                        // Let receiveLoop observe cancellation and do the reconnect once.
                        t.cancel(with: .goingAway, reason: nil)
                    } else {
                        self.emitStatus(.reconnecting, "handshake pending, ping failed (\(short)); retrying ping in 2s")
                        self.schedulePing(afterSeconds: 2, generation: generation)
                    }
                    return
                }

                if !self.didMarkLive {
                    self.didMarkLive = true
                    self.lastErrorSummary = "-"
                    self.emitStatus(.live, "connected on attempt \(self.attempt)")
                }

                // Keep pinging while live. This avoids idle disconnects without
                // being aggressive (battery).
                self.schedulePing(afterSeconds: 25, generation: generation)
            }
        }
    }

    private func receiveLoop() async {
        var failures = 0
        while !isStopped {
            guard let t = task else { return }
            do {
                let msg = try await t.receive()
                failures = 0
                if !didMarkLive {
                    didMarkLive = true
                    lastErrorSummary = "-"
                    emitStatus(.live, "connected on attempt \(attempt)")
                }
                switch msg {
                case .string(let s):
                    self.onEvent(s, self.agentName)
                case .data(let d):
                    if let s = String(data: d, encoding: .utf8) {
                        self.onEvent(s, self.agentName)
                    }
                @unknown default:
                    break
                }
            } catch {
                if isStopped { return }
                failures += 1
                log.error("ws receive error agent=\(self.agentName, privacy: .public) err=\(String(describing: error), privacy: .public)")
                let short = Self.shortError(error)
                self.lastErrorSummary = "receive: \(short)"
                self.emitStatus(.error, "receive failed: \(short)")

                // Exponential-ish backoff, capped. Good enough for a personal v0 app.
                let delay = min(30, 2 + failures * 2)
                task?.cancel(with: .goingAway, reason: nil)
                task = nil
                didMarkLive = false
                connect(backoffSeconds: UInt64(delay))
                return
            }
        }
    }

    private func emitStatus(_ status: WSConnectionStatus, _ detail: String) {
        onStatus(
            WSStatusDetail(
                status: status,
                detail: detail,
                attempt: attempt,
                timestamp: Date()
            ),
            agentName
        )
    }

    private static func shortError(_ error: Error) -> String {
        var text = String(describing: error)
        text = text.replacingOccurrences(of: "\n", with: " ")
        if text.count <= 140 { return text }
        let idx = text.index(text.startIndex, offsetBy: 140)
        return String(text[..<idx]) + "..."
    }
}
