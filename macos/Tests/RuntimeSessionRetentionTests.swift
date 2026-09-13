import Darwin
import Foundation
import XCTest
@testable import RuntimeCatalog

@MainActor
final class RuntimeSessionRetentionTests: XCTestCase {
    private let owner = "dev.extensionsanywhere.launcher.stylelab"
    private let clock = Date(timeIntervalSince1970: 2_000_000_000)

    private final class State {
        var date = Date(timeIntervalSince1970: 2_000_000_000)
        var observations: [Int32: RuntimeSessionRetention.Observation] = [:]
        var onObserve: ((Int32) -> Void)?
        var retention: RuntimeSessionRetention {
            RuntimeSessionRetention(environment: .init(uid: { getuid() }, now: { self.date }, observe: { pid in
                self.onObserve?(pid)
                return self.observations[pid] ?? .unknown
            }))
        }
        func running(_ pid: Int32, started: String = "1700000000.000001") {
            observations[pid] = .running(pid: pid, uid: getuid(), started: started)
        }
        func stopped() { for pid in observations.keys { observations[pid] = .absent } }
    }

    private func withRoot(_ body: (URL, URL, State) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("EA-retention-tests-\(UUID().uuidString)")
            .standardizedFileURL.resolvingSymlinksInPath()
        let sessions = root.appendingPathComponent("Sessions")
        try FileManager.default.createDirectory(at: sessions, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let current = sessions.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: current, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try body(sessions, current, State())
    }

    private func session(in root: URL, state: State, broker: Int32, age: TimeInterval, closed: Bool = true) throws -> URL {
        let session = root.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: session, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        state.date = clock.addingTimeInterval(-age)
        state.running(getpid()); state.running(broker)
        try state.retention.markCreated(session, launcherIdentifier: owner)
        try state.retention.markBroker(session, launcherIdentifier: owner, brokerPID: broker)
        if closed { try state.retention.markClosed(session, launcherIdentifier: owner) }
        try Data("owned metadata".utf8).write(to: session.appendingPathComponent("report.json"))
        try Data().write(to: session.appendingPathComponent("launcher.log"))
        state.date = clock
        return session
    }

    func testNewMarkerRecordsOwnersAndCannotAdoptExistingDirectory() throws {
        try withRoot { root, current, state in
            state.running(getpid())
            try state.retention.markCreated(current, launcherIdentifier: owner)
            let marker = current.appendingPathComponent(RuntimeSessionRetention.markerName)
            let data = try Data(contentsOf: marker)
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(json["schemaVersion"] as? Int, 1)
            XCTAssertEqual(json["owner"] as? String, "dev.extensions-anywhere.session")
            XCTAssertEqual(json["sessionID"] as? String, current.lastPathComponent)
            XCTAssertNotNil(json["directoryInode"])
            XCTAssertEqual((json["launcher"] as? [String: Any])?["pid"] as? Int32, getpid())
            let mode = try FileManager.default.attributesOfItem(atPath: marker.path)[.posixPermissions] as? NSNumber
            XCTAssertEqual(mode?.intValue, 0o600)
            XCTAssertThrowsError(try state.retention.markCreated(current, launcherIdentifier: owner))
            XCTAssertEqual(try Data(contentsOf: marker), data)
            let legacy = root.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: false)
            try Data("legacy".utf8).write(to: legacy.appendingPathComponent("report.json"))
            XCTAssertThrowsError(try state.retention.markCreated(legacy, launcherIdentifier: owner))
            XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.appendingPathComponent(RuntimeSessionRetention.markerName).path))
        }
    }

    func testKeepsTenNewestInactiveSessionsAndAlwaysExcludesCurrent() throws {
        try withRoot { root, current, state in
            var sessions: [URL] = []
            for index in 0..<12 { sessions.append(try session(in: root, state: state, broker: Int32(1000 + index), age: Double(12 - index) * 3600)) }
            state.stopped()
            let result = try state.retention.prune(in: root, launcherIdentifier: owner, excluding: current)
            XCTAssertEqual(Set(result.removed), Set(sessions.prefix(2).map(\.lastPathComponent)))
            for url in sessions.dropFirst(2) { XCTAssertTrue(FileManager.default.fileExists(atPath: url.path)) }
            XCTAssertTrue(FileManager.default.fileExists(atPath: current.path))
        }
    }

    func testAgeLimitPrunesInactiveSessionEvenInsideNewestTen() throws {
        try withRoot { root, current, state in
            let old = try session(in: root, state: state, broker: 1001, age: 15 * 86400)
            let recent = try session(in: root, state: state, broker: 1002, age: 86400)
            state.stopped()
            let result = try state.retention.prune(in: root, launcherIdentifier: owner, excluding: current)
            XCTAssertEqual(result.removed, [old.lastPathComponent])
            XCTAssertTrue(FileManager.default.fileExists(atPath: recent.path))
        }
    }

    func testActiveUnknownAndUntrackedOwnersArePreservedAndPIDReuseEndsOnlyOldIdentity() throws {
        try withRoot { root, current, state in
            let active = try session(in: root, state: state, broker: 1001, age: 15 * 86400)
            let unknown = try session(in: root, state: state, broker: 1002, age: 15 * 86400)
            let recycled = try session(in: root, state: state, broker: 1003, age: 15 * 86400, closed: false)
            let incomplete = root.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: incomplete, withIntermediateDirectories: false)
            state.date = clock.addingTimeInterval(-15 * 86400)
            try state.retention.markCreated(incomplete, launcherIdentifier: owner)
            try state.retention.markClosed(incomplete, launcherIdentifier: owner)
            state.date = clock; state.stopped()
            state.running(1001); state.observations[1002] = .unknown
            state.running(1003, started: "1700000001.000001")
            let result = try state.retention.prune(in: root, launcherIdentifier: owner, excluding: current)
            XCTAssertEqual(result.removed, [recycled.lastPathComponent])
            for url in [active, unknown, incomplete] { XCTAssertTrue(FileManager.default.fileExists(atPath: url.path)) }
        }
    }

    func testAnUnknownOrRunningLauncherPreventsDeletionDespiteClosedMarker() throws {
        try withRoot { root, current, state in
            let old = try session(in: root, state: state, broker: 1001, age: 15 * 86400)
            state.observations[1001] = .absent
            XCTAssertTrue(try state.retention.prune(in: root, launcherIdentifier: owner, excluding: current).removed.isEmpty)
            state.observations[getpid()] = .unknown
            XCTAssertTrue(try state.retention.prune(in: root, launcherIdentifier: owner, excluding: current).removed.isEmpty)
            XCTAssertTrue(FileManager.default.fileExists(atPath: old.path))
        }
    }

    func testLegacyMalformedCopiedAndOversizedMarkersArePreserved() throws {
        try withRoot { root, current, state in
            let source = try session(in: root, state: state, broker: 1001, age: 15 * 86400)
            let marker = try Data(contentsOf: source.appendingPathComponent(RuntimeSessionRetention.markerName))
            let copied = root.appendingPathComponent(UUID().uuidString)
            let legacy = root.appendingPathComponent(UUID().uuidString)
            let oversized = root.appendingPathComponent(UUID().uuidString)
            for url in [copied, legacy, oversized] { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false) }
            try marker.write(to: copied.appendingPathComponent(RuntimeSessionRetention.markerName))
            try Data(repeating: 32, count: 8193).write(to: oversized.appendingPathComponent(RuntimeSessionRetention.markerName))
            try Data("not JSON".utf8).write(to: source.appendingPathComponent(RuntimeSessionRetention.markerName))
            state.stopped()
            XCTAssertTrue(try state.retention.prune(in: root, launcherIdentifier: owner, excluding: current).removed.isEmpty)
            for url in [source, copied, legacy, oversized] { XCTAssertTrue(FileManager.default.fileExists(atPath: url.path)) }
        }
    }

    func testUnexpectedFilesSymlinksHardlinksAndDirectoriesPreventAnyDeletion() throws {
        try withRoot { root, current, state in
            var protected: [URL] = []
            for index in 0..<4 { protected.append(try session(in: root, state: state, broker: Int32(1000 + index), age: 15 * 86400)) }
            try Data("user file".utf8).write(to: protected[0].appendingPathComponent("notes.txt"))
            try FileManager.default.createSymbolicLink(at: protected[1].appendingPathComponent("status.json"), withDestinationURL: protected[0].appendingPathComponent("notes.txt"))
            try FileManager.default.linkItem(at: protected[2].appendingPathComponent("report.json"), to: protected[2].appendingPathComponent("status.json"))
            try FileManager.default.createDirectory(at: protected[3].appendingPathComponent("unknown-folder"), withIntermediateDirectories: false)
            state.stopped()
            XCTAssertTrue(try state.retention.prune(in: root, launcherIdentifier: owner, excluding: current).removed.isEmpty)
            for url in protected { XCTAssertTrue(FileManager.default.fileExists(atPath: url.appendingPathComponent("report.json").path)) }
        }
    }

    func testKnownFixtureEvidenceIsRemovedWithOwnedInactiveSession() throws {
        try withRoot { root, current, state in
            let old = try session(in: root, state: state, broker: 1001, age: 15 * 86400)
            let evidence = old.appendingPathComponent("evidence/2026-09-13T13-00-00.000Z-1")
            try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
            for name in ["before.png", "styled.png", "restored.png"] { try Data("synthetic".utf8).write(to: evidence.appendingPathComponent(name)) }
            state.stopped()
            XCTAssertEqual(try state.retention.prune(in: root, launcherIdentifier: owner, excluding: current).removed, [old.lastPathComponent])
            XCTAssertFalse(FileManager.default.fileExists(atPath: old.path))
        }
    }

    func testDirectoryReplacementDuringProcessRecheckIsPreservedWithoutFollowingSymlink() throws {
        try withRoot { root, current, state in
            let old = try session(in: root, state: state, broker: 1001, age: 15 * 86400)
            let moved = root.appendingPathComponent("preserved-original")
            state.stopped()
            var probes = 0
            state.onObserve = { pid in
                guard pid == 1001 else { return }
                probes += 1
                if probes == 2 {
                    try! FileManager.default.moveItem(at: old, to: moved)
                    try! FileManager.default.createSymbolicLink(at: old, withDestinationURL: current)
                }
            }
            XCTAssertTrue(try state.retention.prune(in: root, launcherIdentifier: owner, excluding: current).removed.isEmpty)
            XCTAssertTrue(FileManager.default.fileExists(atPath: moved.appendingPathComponent("report.json").path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: current.path))
        }
    }

    func testFileMutationDuringProcessRecheckPreventsAllRemoval() throws {
        try withRoot { root, current, state in
            let old = try session(in: root, state: state, broker: 1001, age: 15 * 86400)
            state.stopped()
            var probes = 0
            state.onObserve = { pid in
                guard pid == 1001 else { return }
                probes += 1
                if probes == 2 { try! Data("changed".utf8).write(to: old.appendingPathComponent("report.json")) }
            }
            XCTAssertTrue(try state.retention.prune(in: root, launcherIdentifier: owner, excluding: current).removed.isEmpty)
            XCTAssertEqual(try String(contentsOf: old.appendingPathComponent("report.json"), encoding: .utf8), "changed")
            XCTAssertTrue(FileManager.default.fileExists(atPath: old.appendingPathComponent(RuntimeSessionRetention.markerName).path))
        }
    }

    func testBoundedScanAbortsBeforeDeletingAnySession() throws {
        try withRoot { root, current, state in
            let old = try session(in: root, state: state, broker: 1001, age: 15 * 86400)
            for index in 0..<RuntimeSessionRetention.maximumSessions { try Data().write(to: root.appendingPathComponent("legacy-\(index)")) }
            state.stopped()
            let result = try state.retention.prune(in: root, launcherIdentifier: owner, excluding: current)
            XCTAssertTrue(result.scanLimitReached)
            XCTAssertTrue(result.removed.isEmpty)
            XCTAssertTrue(FileManager.default.fileExists(atPath: old.path))
        }
    }

    func testSymlinkedSessionsRootIsRejected() throws {
        try withRoot { root, current, state in
            let alias = root.deletingLastPathComponent().appendingPathComponent("alias/Sessions")
            try FileManager.default.createDirectory(at: alias.deletingLastPathComponent(), withIntermediateDirectories: false)
            try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: root)
            XCTAssertThrowsError(try state.retention.prune(in: alias, launcherIdentifier: owner, excluding: alias.appendingPathComponent(current.lastPathComponent)))
            XCTAssertTrue(FileManager.default.fileExists(atPath: current.path))
        }
    }
}
