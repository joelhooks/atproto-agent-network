import Foundation
import SwiftUI

@MainActor
final class FeedStore: ObservableObject {
    @Published private(set) var events: [FeedEvent] = []
    @Published private(set) var wsStatus: WSConnectionStatus = .disconnected
    @Published private(set) var wsDebugLines: [String] = []

    private var client: WebSocketAgentClient?
    private var activeFingerprint: String?

    // Bounded list: keep newest-first without re-sorting the whole array every event.
    private let maxEvents = 750
    private let trimTo = 500
    private let maxDebugLines = 24

    func start(settings: SettingsStore) {
        restart(settings: settings)
    }

    func restart(settings: SettingsStore) {
        let fp = settings.effectiveConfigFingerprint
        if activeFingerprint == fp { return }
        activeFingerprint = fp

        stopAll()
        events.removeAll()
        wsDebugLines.removeAll()

        guard let wsBase = settings.wsBaseURL else {
            wsStatus = .error
            appendDebug("invalid relay base url: \(settings.apiBase)")
            return
        }

        // Single socket: wss://.../firehose (server rewrites to relay public firehose).
        let wsURL = wsBase
            .appendingPathComponent("firehose")
        appendDebug("boot ws=\(wsURL.absoluteString)")

        let c = WebSocketAgentClient(
            session: WebSocketSessions.feed,
            agentName: "firehose",
            wsURL: wsURL,
            onEvent: { [weak self] raw, _ in
                guard let self else { return }
                self.ingest(raw: raw, settings: settings)
            },
            onStatus: { [weak self] update, _ in
                guard let self else { return }
                self.wsStatus = update.status
                self.appendDebug(
                    "\(Self.tsFmt.string(from: update.timestamp)) \(update.status.rawValue) " +
                    "attempt=\(update.attempt) \(update.detail)"
                )
            }
        )

        client = c
        c.start()
    }

    func stopAll() {
        client?.stop()
        client = nil
        wsStatus = .disconnected
    }

    func clearEvents() {
        events.removeAll()
    }

    private func ingest(raw: String, settings _: SettingsStore) {
        guard let ev = EventNormalizer.normalize(jsonString: raw, agentNameHint: nil) else { return }

        // Append in arrival order (oldest -> newest) to avoid O(n) shifting on every event.
        // UI renders reversed for "latest at top".
        events.append(ev)

        // Keep memory bounded.
        if events.count > maxEvents {
            events.removeFirst(events.count - trimTo)
        }
    }

    private func appendDebug(_ line: String) {
        wsDebugLines.append(line)
        if wsDebugLines.count > maxDebugLines {
            wsDebugLines.removeFirst(wsDebugLines.count - maxDebugLines)
        }
    }

    private static let tsFmt: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm:ss"
        return f
    }()
}
