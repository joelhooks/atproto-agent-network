import SwiftUI

// Dense, terminal-ish "TUI" feed view.
// Goal: max information density + full-screen usage on iPhone.

struct FeedView: View {
    @EnvironmentObject private var settings: SettingsStore
    @EnvironmentObject private var feed: FeedStore

    @State private var sheet: ActiveSheet?

    var body: some View {
        // No outer NavigationStack: iOS can add "card-ish" chrome and insets.
        // This view wants full-bleed terminal vibes.
        ZStack {
            TUITheme.bg.ignoresSafeArea()

            EventList(
                events: feed.events,
                wsStatus: feed.wsStatus,
                apiBase: settings.apiBase,
                wsDebugLines: feed.wsDebugLines,
                onSelect: { sheet = .event($0) }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .layoutPriority(1)
        }
        // Put header/footer inside the safe area so we don't get clipped by the home indicator.
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                HeaderBar(
                    apiBase: settings.apiBase,
                    wsStatus: feed.wsStatus,
                    eventCount: feed.events.count,
                    lastEventAt: feed.events.last?.timestamp
                )
                ThinDivider()
            }
            .background(TUITheme.bg)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                ThinDivider()
                FooterBar(
                    wsStatus: feed.wsStatus,
                    onReconnect: { feed.restart(settings: settings) },
                    onClear: { feed.clearEvents() },
                    onSettings: { sheet = .settings }
                )
            }
            .background(TUITheme.bg)
        }
        .sheet(item: $sheet) { route in
            switch route {
            case .event(let ev):
                EventDetailView(event: ev)
            case .settings:
                SettingsSheet()
                    .environmentObject(settings)
            }
        }
    }
}

private enum ActiveSheet: Identifiable {
    case event(FeedEvent)
    case settings

    var id: String {
        switch self {
        case .event(let ev): return "event:\(ev.id)"
        case .settings: return "settings"
        }
    }
}

private struct HeaderBar: View {
    let apiBase: String
    let wsStatus: WSConnectionStatus
    let eventCount: Int
    let lastEventAt: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("HIGHSwarm")
                    .font(TUITheme.titleFont)
                    .foregroundStyle(TUITheme.fg)

                Text("firehose")
                    .font(TUITheme.microFont)
                    .foregroundStyle(TUITheme.dim)

                Spacer(minLength: 8)

                StatusBadge(status: wsStatus)

                Text("events=\(eventCount)")
                    .font(TUITheme.microFont)
                    .foregroundStyle(TUITheme.dim)
            }

            HStack(spacing: 8) {
                Text("relay=\(Self.apiHost(apiBase))")
                    .font(TUITheme.microFont)
                    .foregroundStyle(TUITheme.dim)
                    .lineLimit(1)

                Text("last=\(Self.relativeTime(lastEventAt))")
                    .font(TUITheme.microFont)
                    .foregroundStyle(TUITheme.dim)

                Spacer(minLength: 8)

                Text("stream=all")
                    .font(TUITheme.microFont)
                    .foregroundStyle(TUITheme.ok)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(TUITheme.bg)
    }

    private static func relativeTime(_ d: Date?) -> String {
        guard let d else { return "-" }
        let delta = max(0, Date().timeIntervalSince(d))
        if delta < 1 { return "<1s" }
        if delta < 60 { return "\(Int(delta.rounded()))s" }
        let mins = Int((delta / 60).rounded(.down))
        let secs = Int(delta) % 60
        return "\(mins)m\(secs)s"
    }

    private static func apiHost(_ apiBase: String) -> String {
        guard let url = URL(string: apiBase) else { return apiBase }
        return url.host ?? apiBase
    }
}

private struct FooterBar: View {
    let wsStatus: WSConnectionStatus
    let onReconnect: () -> Void
    let onClear: () -> Void
    let onSettings: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            FooterButton(title: "settings", fg: TUITheme.dim, action: onSettings)

            if wsStatus == .live {
                FooterButton(title: "clear", fg: TUITheme.info, action: onClear)
            } else {
                FooterButton(title: "reconnect", fg: TUITheme.accent, action: onReconnect)
            }

            Text("ws=/firehose")
                .font(TUITheme.microFont)
                .foregroundStyle(TUITheme.dim)

            Spacer(minLength: 8)

            if let url = URL(string: "https://github.com/joelhooks/atproto-agent-network") {
                Link("github", destination: url)
                    .font(TUITheme.microFontBold)
                    .foregroundStyle(TUITheme.teal)
            }

            Text("iOS 26")
                .font(TUITheme.microFont)
                .foregroundStyle(TUITheme.dim)
        }
        .padding(.horizontal, 8)
        .padding(.top, 6)
        .padding(.bottom, 10)
        .background(TUITheme.bg)
    }
}

private struct FooterButton: View {
    let title: String
    let fg: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(TUITheme.microFontBold)
                .foregroundStyle(fg)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .padding(.vertical, 2)
        }
        .buttonStyle(.plain)
    }
}

private struct SettingsSheet: View {
    @EnvironmentObject private var settings: SettingsStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SettingsView()
                .navigationTitle("settings")
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(TUITheme.bg, for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("done") { dismiss() }
                            .font(TUITheme.microFontBold)
                            .foregroundStyle(TUITheme.accent)
                    }
                }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct EventList: View {
    let events: [FeedEvent]
    let wsStatus: WSConnectionStatus
    let apiBase: String
    let wsDebugLines: [String]
    let onSelect: (FeedEvent) -> Void

    @State private var renderedEvents: [FeedEvent] = []
    @State private var latestIncomingEvents: [FeedEvent] = []
    @State private var isPinnedToHead = true
    @State private var queuedCount = 0
    @State private var bootstrapped = false

    var body: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .topTrailing) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        Color.clear
                            .frame(height: 1)
                            .id(Self.headID)
                            .background(
                                GeometryReader { geo in
                                    Color.clear.preference(
                                        key: FeedHeadOffsetPreferenceKey.self,
                                        value: geo.frame(in: .named(Self.scrollSpace)).minY
                                    )
                                }
                            )

                        if renderedEvents.isEmpty {
                            EmptyFeedState(wsStatus: wsStatus, apiBase: apiBase, wsDebugLines: wsDebugLines)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 6)
                        } else {
                            if wsStatus != .live {
                                VStack(alignment: .leading, spacing: 2) {
                                    SpinnerLine(
                                        label: wsStatus == .reconnecting ? "reconnecting" : wsStatus.rawValue,
                                        color: wsStatus == .error ? TUITheme.err : TUITheme.warn
                                    )
                                    DebugLines(lines: wsDebugLines)
                                }
                                .padding(.horizontal, 6)
                                .padding(.vertical, 4)

                                Rectangle()
                                    .fill(TUITheme.grid.opacity(0.25))
                                    .frame(height: 1)
                            }

                            // Render newest-first while keeping the store append-only for cheap ingestion.
                            ForEach(renderedEvents.reversed()) { ev in
                                Button {
                                    onSelect(ev)
                                } label: {
                                    EventRow(event: ev)
                                }
                                .buttonStyle(.plain)

                                Rectangle()
                                    .fill(TUITheme.grid.opacity(0.25))
                                    .frame(height: 1)
                            }
                        }
                    }
                }
                .coordinateSpace(name: Self.scrollSpace)
                .onAppear {
                    latestIncomingEvents = events
                    renderedEvents = events
                    bootstrapped = true
                    queueScrollToHead(proxy, animated: false)
                }
                .onChange(of: events) { _, incoming in
                    latestIncomingEvents = incoming
                    applyIncomingEvents(incoming, proxy: proxy)
                }
                .onPreferenceChange(FeedHeadOffsetPreferenceKey.self) { minY in
                    let atHead = minY >= -8
                    if atHead == isPinnedToHead { return }
                    isPinnedToHead = atHead
                    if atHead {
                        renderedEvents = latestIncomingEvents
                        queuedCount = 0
                    }
                }
                .scrollIndicators(.hidden)
                .background(TUITheme.bg)

                if !isPinnedToHead {
                    Button {
                        isPinnedToHead = true
                        renderedEvents = latestIncomingEvents
                        queuedCount = 0
                        queueScrollToHead(proxy, animated: true)
                    } label: {
                        HStack(spacing: 6) {
                            Text("jump head")
                            if queuedCount > 0 {
                                Text("+\(queuedCount)")
                            }
                        }
                        .font(TUITheme.microFontBold)
                        .foregroundStyle(TUITheme.bg)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(TUITheme.info, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 4)
                    .padding(.trailing, 8)
                }
            }
        }
    }

    private static let headID = "feed-head-anchor"
    private static let scrollSpace = "feed-scroll-space"

    private func applyIncomingEvents(_ incoming: [FeedEvent], proxy: ScrollViewProxy) {
        if !bootstrapped {
            renderedEvents = incoming
            queuedCount = 0
            return
        }

        if isPinnedToHead {
            renderedEvents = incoming
            queuedCount = 0
            queueScrollToHead(proxy, animated: false)
            return
        }

        queuedCount = queuedEventCount(incoming: incoming)
    }

    private func queuedEventCount(incoming: [FeedEvent]) -> Int {
        guard let tailID = renderedEvents.last?.id else { return incoming.count }
        guard let idx = incoming.firstIndex(where: { $0.id == tailID }) else { return incoming.count }
        return max(0, incoming.count - (idx + 1))
    }

    private func queueScrollToHead(_ proxy: ScrollViewProxy, animated: Bool) {
        DispatchQueue.main.async {
            if animated {
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo(Self.headID, anchor: .top)
                }
            } else {
                proxy.scrollTo(Self.headID, anchor: .top)
            }
        }
    }
}

private struct FeedHeadOffsetPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private struct EmptyFeedState: View {
    let wsStatus: WSConnectionStatus
    let apiBase: String
    let wsDebugLines: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            switch wsStatus {
            case .live:
                Text("connected. waiting for events...")
                    .font(TUITheme.monoFontBold)
                    .foregroundStyle(TUITheme.ok)
                Text("ws=/firehose relay=\(Self.apiHost(apiBase))")
                    .font(TUITheme.monoFont)
                    .foregroundStyle(TUITheme.dim)
            case .connecting, .reconnecting:
                SpinnerLine(
                    label: wsStatus == .connecting ? "connecting" : "reconnecting",
                    color: wsStatus == .connecting ? TUITheme.warn : TUITheme.warn
                )
                Text("ws=/firehose relay=\(Self.apiHost(apiBase))")
                    .font(TUITheme.monoFont)
                    .foregroundStyle(TUITheme.dim)
                DebugLines(lines: wsDebugLines)
            case .disconnected:
                Text("disconnected.")
                    .font(TUITheme.monoFontBold)
                    .foregroundStyle(TUITheme.dim)
                Text("ws=/firehose relay=\(Self.apiHost(apiBase))  (tap reconnect)")
                    .font(TUITheme.monoFont)
                    .foregroundStyle(TUITheme.dim)
                DebugLines(lines: wsDebugLines)
            case .error:
                Text("connection error.")
                    .font(TUITheme.monoFontBold)
                    .foregroundStyle(TUITheme.err)
                Text("ws=/firehose relay=\(Self.apiHost(apiBase))  (tap reconnect)")
                    .font(TUITheme.monoFont)
                    .foregroundStyle(TUITheme.dim)
                DebugLines(lines: wsDebugLines)
            }
        }
    }

    private static func apiHost(_ apiBase: String) -> String {
        guard let url = URL(string: apiBase) else { return apiBase }
        return url.host ?? apiBase
    }
}

private struct DebugLines: View {
    let lines: [String]

    var body: some View {
        let tail = Array(lines.suffix(5))
        if !tail.isEmpty {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(Array(tail.enumerated()), id: \.offset) { entry in
                    Text(entry.element)
                        .font(TUITheme.microFont)
                        .foregroundStyle(TUITheme.dim)
                        .lineLimit(3)
                        .truncationMode(.middle)
                }
            }
            .padding(.top, 2)
        }
    }
}

private struct SpinnerLine: View {
    let label: String
    let color: Color

    private let frames = ["|", "/", "-", "\\"]

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.12)) { ctx in
            let idx = Int(ctx.date.timeIntervalSince1970 / 0.12) % frames.count
            HStack(spacing: 6) {
                Text(frames[idx])
                    .font(TUITheme.monoFontBold)
                    .foregroundStyle(color)
                Text(label + "...")
                    .font(TUITheme.monoFontBold)
                    .foregroundStyle(color)
            }
        }
    }
}

private struct EventRow: View {
    let event: FeedEvent

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Rectangle()
                .fill(Self.kindColor(event.kind))
                .frame(width: 2)

            VStack(alignment: .leading, spacing: 1) {
                // line 1: timestamp agent kind
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(Self.timeFmt.string(from: event.timestamp))
                        .font(TUITheme.monoFont)
                        .foregroundStyle(TUITheme.dim)
                        .frame(width: 58, alignment: .leading)

                    Text(event.agent)
                        .font(TUITheme.monoFontBold)
                        .foregroundStyle(TUITheme.fg)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    Text(event.kind.rawValue)
                        .font(TUITheme.monoFontBold)
                        .foregroundStyle(Self.kindColor(event.kind))
                        .lineLimit(1)

                    Spacer(minLength: 0)
                }

                // line 2: type (wrap)
                Text(event.type)
                    .font(TUITheme.monoFont)
                    .foregroundStyle(TUITheme.dim)
                    .lineLimit(8)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)

                // line 3: summary (wrap)
                Text(event.summary)
                    .font(TUITheme.monoFontBold)
                    .foregroundStyle(TUITheme.fg)
                    .lineLimit(28)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)

                if let text = event.text, !text.isEmpty, text != event.summary {
                    Text(text)
                        .font(TUITheme.monoFont)
                        .foregroundStyle(TUITheme.dim)
                        .lineLimit(28)
                        .truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .background(TUITheme.bg)
    }

    private static let timeFmt: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    private static func kindColor(_ kind: FeedEventKind) -> Color {
        switch kind {
        case .error: return TUITheme.err
        case .tool: return TUITheme.warn
        case .loop: return TUITheme.info
        case .thinkAloud: return TUITheme.purple
        case .memory: return TUITheme.ok
        case .message: return TUITheme.teal
        default: return TUITheme.dim
        }
    }
}

private struct StatusBadge: View {
    let status: WSConnectionStatus

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(status.rawValue)
                .font(TUITheme.microFontBold)
                .foregroundStyle(color)
        }
    }

    private var color: Color {
        switch status {
        case .live: return TUITheme.ok
        case .connecting, .reconnecting: return TUITheme.warn
        case .error: return TUITheme.err
        case .disconnected: return TUITheme.dim
        }
    }
}

private struct EventDetailView: View {
    let event: FeedEvent
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                TUITheme.bg.ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(event.summary)
                            .font(FontBook.pixelFontBold(size: 14))
                            .foregroundStyle(TUITheme.fg)

                        Text("agent=\(event.agent)")
                            .font(TUITheme.monoFont)
                            .foregroundStyle(TUITheme.dim)

                        Text("type=\(event.type) kind=\(event.kind.rawValue)")
                            .font(TUITheme.monoFont)
                            .foregroundStyle(TUITheme.dim)

                        Text("ts=\(event.timestamp.formatted())")
                            .font(TUITheme.monoFont)
                            .foregroundStyle(TUITheme.dim)

                        Divider().overlay(TUITheme.grid.opacity(0.35))

                        Text("raw json")
                            .font(TUITheme.monoFontBold)
                            .foregroundStyle(TUITheme.fg)

                        Text(event.rawJSON)
                            .font(FontBook.pixelFont(size: 10))
                            .foregroundStyle(TUITheme.fg)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                            .background(TUITheme.bg)
                            .overlay(
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .stroke(TUITheme.grid.opacity(0.35), lineWidth: 1)
                            )
                    }
                    .padding(12)
                }
            }
            .navigationTitle("event")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(TUITheme.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("done") { dismiss() }
                        .font(TUITheme.microFontBold)
                        .foregroundStyle(TUITheme.accent)
                }
            }
        }
    }
}

#Preview {
    FeedView()
        .environmentObject(SettingsStore())
        .environmentObject(FeedStore())
}
