import Foundation

enum EventNormalizer {
    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()

    static func normalize(jsonString: String, agentNameHint: String?) -> FeedEvent? {
        guard let data = jsonString.data(using: .utf8) else {
            return fallbackRawEvent(rawJSON: jsonString, agentNameHint: agentNameHint)
        }
        return normalize(data: data, rawJSON: jsonString, agentNameHint: agentNameHint)
    }

    static func normalize(data: Data, rawJSON: String, agentNameHint: String?) -> FeedEvent? {
        guard let payload = try? decoder.decode(AgentEventPayload.self, from: data) else {
            return fallbackRawEvent(rawJSON: rawJSON, agentNameHint: agentNameHint)
        }

        let type = nonEmpty(payload.event_type) ?? "raw.packet"
        let timestamp = payload.timestamp.flatMap(DateParsers.parseAny) ?? Date()

        let agent =
            payload.agent_name ??
            agentNameHint ??
            payload.agent_did ??
            payload.did ??
            payload.repo ??
            "unknown"

        let context = payload.context ?? [:]

        let kind: FeedEventKind = nonEmpty(payload.event_type) == nil
            ? .system
            : classifyKind(type: type, outcome: payload.outcome, hasError: payload.error != nil)
        let summary =
            nonEmpty(payload.event_type) == nil
            ? fallbackSummary(from: context, rawJSON: rawJSON)
            : summarize(
                kind: kind,
                type: type,
                context: context,
                error: payload.error
            )

        let text: String? = {
            if type == "agent.think_aloud" {
                return context["message"]?.asString
            }
            // Best-effort: pull a human-ish string out of common keys.
            return extractHumanText(from: context)
        }()

        let stableId =
            payload.span_id ??
            payload.id ??
            fallbackId(agent: agent, type: type, timestamp: timestamp, rawJSON: rawJSON)

        return FeedEvent(
            id: stableId,
            kind: kind,
            type: type,
            agent: agent,
            summary: summary,
            timestamp: timestamp,
            text: text,
            rawJSON: rawJSON
        )
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let v = value?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty else { return nil }
        return v
    }

    private static func fallbackRawEvent(rawJSON: String, agentNameHint: String?) -> FeedEvent {
        let timestamp = Date()
        let agent = agentNameHint ?? "unknown"
        let type = "raw.packet"
        return FeedEvent(
            id: fallbackId(agent: agent, type: type, timestamp: timestamp, rawJSON: rawJSON),
            kind: .system,
            type: type,
            agent: agent,
            summary: fallbackSummary(from: [:], rawJSON: rawJSON),
            timestamp: timestamp,
            text: nil,
            rawJSON: rawJSON
        )
    }

    private static func fallbackSummary(from context: [String: JSONValue], rawJSON: String) -> String {
        if let text = extractHumanText(from: context), !text.isEmpty {
            return truncate(text, max: 220)
        }
        let flattened = rawJSON
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if flattened.isEmpty { return "raw event" }
        return truncate(flattened, max: 220)
    }

    private static func fallbackId(agent: String, type: String, timestamp: Date, rawJSON: String) -> String {
        let digest = String(rawJSON.hashValue, radix: 16)
        let millis = Int((timestamp.timeIntervalSince1970 * 1000).rounded())
        return "\(agent)|\(type)|\(millis)|\(digest)"
    }

    private static func classifyKind(type: String, outcome: String?, hasError: Bool) -> FeedEventKind {
        let lower = type.lowercased()

        let isTool =
            lower.contains(".tool.") ||
            lower.contains("tool.") ||
            lower.contains(".tool") ||
            lower.contains("tool_") ||
            lower.contains("toolcall") ||
            lower.contains("tool_call")

        if type == "agent.think_aloud" { return .thinkAloud }
        if isTool { return .tool }
        if type == "loop.error" { return .error }
        if lower.hasPrefix("loop.") { return .loop }
        if lower.contains("memory") { return .memory }
        if lower.contains("message") { return .message }
        if lower.contains("identity") { return .identity }
        if lower.contains("prompt") { return .prompt }
        if (outcome?.lowercased() == "error") || hasError { return .error }
        return .system
    }

    private static func summarize(
        kind: FeedEventKind,
        type: String,
        context: [String: JSONValue],
        error: AgentEventError?
    ) -> String {
        if type == "agent.think_aloud" {
            return context["message"]?.asString ?? type
        }

        if type == "agent.comms.message" {
            // On the public firehose we canonicalize message events into context.message.
            if let msg = context["message"]?.asString, !msg.isEmpty {
                return truncate(msg)
            }
            return "Message"
        }

        if type == "loop.sleep" {
            var parts: [String] = ["Sleep"]
            if let interval = context["intervalMs"]?.asNumber {
                parts.append("\(Int((interval / 1000.0).rounded()))s")
            }
            if let nextAlarm = context["nextAlarmAt"]?.asNumber {
                let d = Date(timeIntervalSince1970: nextAlarm / 1000.0)
                let f = DateFormatter()
                f.locale = Locale(identifier: "en_US_POSIX")
                f.dateFormat = "HH:mm:ss"
                parts.append("next=\(f.string(from: d))")
            }
            return parts.joined(separator: " ")
        }

        if type == "loop.error" {
            let phase = context["phase"]?.asString
            let msg = error?.message
            if let phase, let msg { return "Loop error (\(phase)): \(msg)" }
            if let phase { return "Loop error (\(phase))" }
            if let msg { return "Loop error: \(msg)" }
            return "Loop error"
        }

        if type.hasPrefix("loop.") {
            return "Loop \(type.dropFirst("loop.".count))"
        }

        if kind == .tool {
            if let toolName = context["toolName"]?.asString { return "Tool: \(toolName)" }
            if let tool = context["tool"]?.asObject {
                if let name = tool["name"]?.asString { return "Tool: \(name)" }
                if let name = tool["tool"]?.asString { return "Tool: \(name)" }
            }
            return type
        }

        if kind == .memory {
            if let s = context["summary"]?.asString { return truncate(s) }
            if let s = context["note"]?.asString { return truncate(s) }
            if let s = context["message"]?.asString { return truncate(s) }
            return "Memory: \(type)"
        }

        if type.hasPrefix("game.") {
            // Lightweight env events; often have a useful context.message.
            if let msg = context["message"]?.asString, !msg.isEmpty { return truncate(msg) }
            return "Game \(type.dropFirst("game.".count))"
        }

        return type
    }

    private static func extractHumanText(from obj: [String: JSONValue]) -> String? {
        let keys = ["note", "decision", "message", "description", "summary", "reason", "text", "rationale", "detail", "comment", "observation"]
        for k in keys {
            if let s = obj[k]?.asString, !s.isEmpty { return s }
        }
        return nil
    }

    private static func truncate(_ s: String, max: Int = 120) -> String {
        if s.count <= max { return s }
        let idx = s.index(s.startIndex, offsetBy: max)
        return String(s[..<idx]) + "..."
    }
}

private enum DateParsers {
    // Handles typical ISO8601 variants (with/without fractional seconds).
    static func parseISO8601(_ s: String) -> Date? {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // Swift 6 strict concurrency hates shared ISO8601DateFormatter instances (not Sendable).
        // For this app's event volume, per-call formatters are fine.
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFraction.date(from: trimmed) { return d }

        let noFraction = ISO8601DateFormatter()
        noFraction.formatOptions = [.withInternetDateTime]
        if let d = noFraction.date(from: trimmed) { return d }

        // Some payloads may be epoch ms in a string. Be tolerant.
        if let ms = Double(trimmed), ms.isFinite {
            // Heuristic: if it's too big, treat as ms.
            if ms > 10_000_000_000 { return Date(timeIntervalSince1970: ms / 1000.0) }
            return Date(timeIntervalSince1970: ms)
        }

        return nil
    }

    static func parseAny(_ ts: FlexibleTimestamp) -> Date? {
        switch ts {
        case .string(let s):
            return parseISO8601(s)
        case .number(let n):
            if !n.isFinite { return nil }
            // Heuristic: if it's too big, treat as ms.
            if n > 10_000_000_000 { return Date(timeIntervalSince1970: n / 1000.0) }
            return Date(timeIntervalSince1970: n)
        }
    }
}

// JSONValue accessors live in Models.swift.
