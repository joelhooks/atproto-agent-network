import XCTest
@testable import HighswarmFeed

final class EventNormalizerTests: XCTestCase {
    func testNormalizeThinkAloudUsesMessageAsSummary() {
        let json = """
        {
          "event_type": "agent.think_aloud",
          "timestamp": "2026-02-10T12:34:56Z",
          "agent_did": "did:cf:abc",
          "agent_name": "grimlock",
          "span_id": "0123456789abcdef",
          "context": { "message": "hello from the swarm" }
        }
        """
        let ev = EventNormalizer.normalize(jsonString: json, agentNameHint: nil)
        XCTAssertNotNil(ev)
        XCTAssertEqual(ev?.kind, .thinkAloud)
        XCTAssertEqual(ev?.summary, "hello from the swarm")
        XCTAssertEqual(ev?.agent, "grimlock")
    }

    func testNormalizeLoopSleepBuildsHumanSummary() {
        let json = """
        {
          "event_type": "loop.sleep",
          "timestamp": "2026-02-10T12:34:56Z",
          "agent_did": "did:cf:abc",
          "span_id": "0123456789abcdef",
          "context": { "intervalMs": 5000, "nextAlarmAt": 1760000000000 }
        }
        """
        let ev = EventNormalizer.normalize(jsonString: json, agentNameHint: "swoop")
        XCTAssertNotNil(ev)
        XCTAssertEqual(ev?.kind, .loop)
        XCTAssertTrue(ev?.summary.hasPrefix("Sleep") ?? false)
    }

    func testNormalizeToolEventExtractsToolNameFromContext() {
        let json = """
        {
          "event_type": "agent.tool.call",
          "timestamp": "2026-02-10T12:34:56Z",
          "span_id": "0123456789abcdef",
          "context": { "toolName": "read" }
        }
        """
        let ev = EventNormalizer.normalize(jsonString: json, agentNameHint: "sludge")
        XCTAssertNotNil(ev)
        XCTAssertEqual(ev?.kind, .tool)
        XCTAssertEqual(ev?.summary, "Tool: read")
    }

    func testInvalidJsonFallsBackToRawPacket() {
        let ev = EventNormalizer.normalize(jsonString: "{nope", agentNameHint: "grimlock")
        XCTAssertNotNil(ev)
        XCTAssertEqual(ev?.type, "raw.packet")
        XCTAssertEqual(ev?.agent, "grimlock")
        XCTAssertEqual(ev?.kind, .system)
    }

    func testMissingEventTypeFallsBackToRawPacketType() {
        let json = """
        {
          "timestamp": "2026-02-10T12:34:56Z",
          "context": { "message": "hello from weird payload" }
        }
        """
        let ev = EventNormalizer.normalize(jsonString: json, agentNameHint: "swoop")
        XCTAssertNotNil(ev)
        XCTAssertEqual(ev?.type, "raw.packet")
        XCTAssertEqual(ev?.agent, "swoop")
    }

    func testMissingTimestampUsesNowInsteadOfDroppingEvent() {
        let json = """
        {
          "event_type": "agent.weird",
          "agent_name": "snarl"
        }
        """
        let ev = EventNormalizer.normalize(jsonString: json, agentNameHint: nil)
        XCTAssertNotNil(ev)
        XCTAssertEqual(ev?.type, "agent.weird")
        XCTAssertEqual(ev?.agent, "snarl")
    }
}
