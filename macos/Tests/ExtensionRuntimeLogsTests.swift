import Darwin
import Foundation
import XCTest
@testable import ExtensionsAnywhere

final class ExtensionRuntimeLogsTests: XCTestCase {
    private let extensionID = UUID(uuidString: "623257AE-C242-4BBF-AC64-D96F34CBAF11")!
    private let otherID = UUID(uuidString: "59AD77E6-27C1-4D9A-96AB-B99FCAD59D82")!
    private let sessionID = UUID(uuidString: "9780C4A9-05E9-47A4-9EEA-03C866AA5971")!
    private let appKey = "dev.extensionsanywhere.stylelab"

    private func request(session: URL? = nil) -> ExtensionRuntimeLogs.Request {
        .init(sessionDirectory: session, appKey: appKey, extensionID: extensionID, sourceFileNames: ["main.js"])
    }

    private func event(id: UUID? = nil, sequence: Int = 1) -> [String: Any] {
        ["sequence": sequence, "extensionID": (id ?? extensionID).uuidString,
         "fileName": "main.js", "revision": "revision-1", "level": "log",
         "message": "Style Lab script button clicked 1", "timestamp": "2026-09-13T17:30:15.125Z"]
    }

    private func envelope(events: [[String: Any]]? = nil) -> [String: Any] {
        ["schema": 1, "appKey": appKey, "sessionID": sessionID.uuidString, "events": events ?? [event()]]
    }

    private func data(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func decode(_ object: [String: Any]) throws -> [ExtensionRuntimeLog] {
        try ExtensionRuntimeLogs.decode(data(object), request: request(), sessionID: sessionID)
    }

    private func withSession(_ operation: (URL) throws -> Void) throws {
        // Foundation normalizes even a resolved /private/var path back to the
        // /var symlink. A no-symlink descriptor reader needs the actual path.
        let actual = try XCTUnwrap(realpath(FileManager.default.temporaryDirectory.path, nil))
        defer { free(actual) }
        let base = URL(fileURLWithPath: String(cString: actual), isDirectory: true)
            .appendingPathComponent("runtime-log-tests-\(UUID().uuidString)")
        let session = base.appendingPathComponent("Sessions/\(sessionID.uuidString)")
        try FileManager.default.createDirectory(at: session, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }
        try operation(session)
    }

    func testValidRuntimeEventsPreserveAttributionAndFilterOtherRecords() throws {
        var other = event(id: otherID, sequence: 1)
        other["fileName"] = "other-extension.js"
        let logs = try decode(envelope(events: [other, event(sequence: 2)]))
        XCTAssertEqual(logs.count, 1)
        let log = try XCTUnwrap(logs.first)
        XCTAssertEqual(log.extensionID, extensionID)
        XCTAssertEqual(log.sequence, 2)
        XCTAssertEqual(log.fileName, "main.js")
        XCTAssertEqual(log.revision, "revision-1")
        XCTAssertEqual(log.level, .log)
        XCTAssertEqual(log.message, "Style Lab script button clicked 1")
        XCTAssertTrue(log.copiedLine.contains("[main.js @ revision-1]"))
        XCTAssertTrue(try decode(envelope(events: [other])).isEmpty)
    }

    func testForeignAppSessionSchemaAndMalformedIDsAreRejected() throws {
        for (key, value) in [("appKey", "example.other" as Any), ("sessionID", UUID().uuidString as Any),
                             ("sessionID", "invalid" as Any), ("schema", 2 as Any), ("schema", true as Any)] {
            var changed = envelope()
            changed[key] = value
            XCTAssertThrowsError(try decode(changed), key)
        }
        var changed = event()
        changed["extensionID"] = "not-a-uuid"
        XCTAssertThrowsError(try decode(envelope(events: [changed])))
        var noSession = envelope()
        noSession.removeValue(forKey: "sessionID")
        XCTAssertThrowsError(try decode(noSession))
    }

    func testSequencesArePositiveStrictlyIncreasingAndMayHaveRetentionGaps() throws {
        XCTAssertEqual(try decode(envelope(events: [event(sequence: 41), event(sequence: 90)])).count, 2)
        for sequence in [0, -1] {
            XCTAssertThrowsError(try decode(envelope(events: [event(sequence: sequence)])))
        }
        XCTAssertThrowsError(try decode(envelope(events: [event(), event()])))
        XCTAssertThrowsError(try decode(envelope(events: [event(sequence: 2), event(sequence: 1)])))
        var changed = event()
        changed["sequence"] = true
        XCTAssertThrowsError(try decode(envelope(events: [changed])))
    }

    func testUnknownLevelsInvalidDatesPathsAndSourceAttributionAreRejected() throws {
        for (key, value) in [("level", "debug"), ("timestamp", "yesterday"),
                             ("fileName", "../main.js"), ("fileName", "/main.js"),
                             ("fileName", "dir/../main.js"), ("fileName", "main.css"),
                             ("fileName", "main.js\n"), ("fileName", "other.js"),
                             ("fileName", String(repeating: "a", count: 254) + ".js"),
                             ("revision", ""), ("revision", "bad revision"), ("revision", "-bad"),
                             ("revision", String(repeating: "a", count: 129))] {
            var changed = event()
            changed[key] = value
            XCTAssertThrowsError(try decode(envelope(events: [changed])), "\(key): \(value)")
        }
        for level in ["log", "info", "warn", "error"] {
            var changed = event()
            changed["level"] = level
            changed["revision"] = "R1._:-"
            XCTAssertEqual(try decode(envelope(events: [changed])).first?.level.rawValue, level)
        }
    }

    func testUTF8MessageBudgetUsesBytesAndAcceptsExactBound() throws {
        var changed = event()
        changed["message"] = String(repeating: "😀", count: 1024)
        XCTAssertEqual(try decode(envelope(events: [changed])).first?.message.utf8.count, 4096)
        changed["message"] = String(repeating: "😀", count: 1025)
        XCTAssertThrowsError(try decode(envelope(events: [changed])))
    }

    func testEventCountAndWholeFileLimitsAreEnforced() throws {
        let maximum = (1...500).map { event(sequence: $0) }
        XCTAssertEqual(try decode(envelope(events: maximum)).count, 500)
        XCTAssertThrowsError(try decode(envelope(events: maximum + [event(sequence: 501)])))
        var bounded = try data(envelope())
        bounded.append(Data(repeating: 32, count: ExtensionRuntimeLogs.maximumBytes - bounded.count))
        XCTAssertEqual(try ExtensionRuntimeLogs.decode(bounded, request: request(), sessionID: sessionID).count, 1)
        bounded.append(32)
        XCTAssertThrowsError(try ExtensionRuntimeLogs.decode(bounded, request: request(), sessionID: sessionID))
    }

    func testMissingSessionAndMissingFileAreEmptyWithoutConnectionClaim() throws {
        XCTAssertEqual(ExtensionRuntimeLogs.load(request()), .empty)
        try withSession { session in
            XCTAssertEqual(ExtensionRuntimeLogs.load(request(session: session)), .empty)
        }
    }

    func testFixedRegularFileRefreshesAndRejectsMalformedOrOversizedContent() throws {
        try withSession { session in
            let file = session.appendingPathComponent(ExtensionRuntimeLogs.fileName)
            try data(envelope()).write(to: file)
            XCTAssertEqual(ExtensionRuntimeLogs.load(request(session: session)).events.count, 1)
            try data(envelope(events: [])).write(to: file, options: .atomic)
            XCTAssertEqual(ExtensionRuntimeLogs.load(request(session: session)), .empty)
            try Data("{broken".utf8).write(to: file)
            XCTAssertEqual(ExtensionRuntimeLogs.load(request(session: session)), .invalid)
            try Data(repeating: 32, count: ExtensionRuntimeLogs.maximumBytes + 1).write(to: file)
            XCTAssertEqual(ExtensionRuntimeLogs.load(request(session: session)), .invalid)
        }
    }

    func testLogSymlinkDirectoryAndFIFOCannotBeReadAsEvents() throws {
        try withSession { session in
            let file = session.appendingPathComponent(ExtensionRuntimeLogs.fileName)
            let source = session.appendingPathComponent("other.json")
            try data(envelope()).write(to: source)
            try FileManager.default.createSymbolicLink(at: file, withDestinationURL: source)
            XCTAssertEqual(ExtensionRuntimeLogs.load(request(session: session)), .invalid)
            try FileManager.default.removeItem(at: file)
            try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
            XCTAssertEqual(ExtensionRuntimeLogs.load(request(session: session)), .invalid)
            try FileManager.default.removeItem(at: file)
            XCTAssertEqual(mkfifo(file.path, 0o600), 0)
            XCTAssertEqual(ExtensionRuntimeLogs.load(request(session: session)), .invalid)
        }
    }

    func testSessionSymlinksAndNonSessionPathsAreRejected() throws {
        try withSession { session in
            try data(envelope()).write(to: session.appendingPathComponent(ExtensionRuntimeLogs.fileName))
            let linkedSessions = session.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Linked")
            try FileManager.default.createSymbolicLink(at: linkedSessions, withDestinationURL: session.deletingLastPathComponent())
            XCTAssertEqual(ExtensionRuntimeLogs.load(request(session: linkedSessions.appendingPathComponent(session.lastPathComponent))), .invalid)
            XCTAssertEqual(ExtensionRuntimeLogs.load(request(session: session.deletingLastPathComponent())), .invalid)
            let otherSession = session.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
            try FileManager.default.createSymbolicLink(at: otherSession, withDestinationURL: session)
            XCTAssertEqual(ExtensionRuntimeLogs.load(request(session: otherSession)), .invalid)
        }
    }

    func testMacOSTemporaryDirectoryAliasIsRejectedWhileActualPathLoads() throws {
        try withSession { session in
            try data(envelope()).write(to: session.appendingPathComponent(ExtensionRuntimeLogs.fileName))
            XCTAssertEqual(ExtensionRuntimeLogs.load(request(session: session)).events.count, 1)
            // The alias is supplied by the OS on macOS; tests also work if a
            // caller's temporary directory is already a direct /Users path.
            if session.path.hasPrefix("/private/var/") {
                let alias = URL(fileURLWithPath: String(session.path.dropFirst("/private".count)), isDirectory: true)
                XCTAssertEqual(ExtensionRuntimeLogs.load(request(session: alias)), .invalid)
            }
        }
    }
}
