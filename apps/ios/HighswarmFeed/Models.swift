import Foundation

enum FeedEventKind: String, Codable {
    case memory
    case message
    case identity
    case prompt
    case tool
    case thinkAloud = "think_aloud"
    case goal
    case loop
    case system
    case error
}

struct FeedEvent: Identifiable, Equatable {
    let id: String
    let kind: FeedEventKind
    let type: String
    let agent: String
    let summary: String
    let timestamp: Date
    let text: String?
    let rawJSON: String
}

struct AgentEventPayload: Decodable {
    let id: String?
    let agent_did: String?
    let agent_name: String?
    let did: String?
    let repo: String?
    let session_id: String?

    let event_type: String?
    let outcome: String?
    let timestamp: FlexibleTimestamp?

    let trace_id: String?
    let span_id: String?
    let parent_span_id: String?

    let context: [String: JSONValue]?
    let record: [String: JSONValue]?

    let error: AgentEventError?
}

enum FlexibleTimestamp: Decodable, Equatable {
    case string(String)
    case number(Double)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported timestamp")
    }
}

struct AgentEventError: Decodable {
    let code: String?
    let message: String?
    let stack: String?
    let retryable: Bool?
}

// A pragmatic JSON value representation for debugging + light extraction.
enum JSONValue: Decodable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let v = try? c.decode(Bool.self) { self = .bool(v); return }
        if let v = try? c.decode(Double.self) { self = .number(v); return }
        if let v = try? c.decode(String.self) { self = .string(v); return }
        if let v = try? c.decode([String: JSONValue].self) { self = .object(v); return }
        if let v = try? c.decode([JSONValue].self) { self = .array(v); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
    }
}

extension JSONValue {
    var asString: String? {
        if case let .string(s) = self { return s }
        return nil
    }

    var asNumber: Double? {
        if case let .number(n) = self { return n }
        return nil
    }

    var asBool: Bool? {
        if case let .bool(b) = self { return b }
        return nil
    }

    var asObject: [String: JSONValue]? {
        if case let .object(o) = self { return o }
        return nil
    }

    var asArray: [JSONValue]? {
        if case let .array(a) = self { return a }
        return nil
    }

    var asAny: Any {
        switch self {
        case .string(let s): return s
        case .number(let n): return n
        case .bool(let b): return b
        case .object(let o):
            var out: [String: Any] = [:]
            for (k, v) in o {
                out[k] = v.asAny
            }
            return out
        case .array(let a): return a.map { $0.asAny }
        case .null: return NSNull()
        }
    }
}
