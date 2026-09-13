import Foundation
import XCTest
@testable import ExtensionsAnywhere

@MainActor
final class DockVisibilityTests: XCTestCase {
    private enum Failure: Error { case simulated }

    @MainActor
    private final class Preferences {
        var value: Bool?
        var writes: [Bool?] = []
        var refreshes = 0
        var failWrite = false
        var failRefresh = false
        var beforeWrite: (() throws -> Void)?
        init(_ value: Bool?) { self.value = value }
        var access: DockVisibilityPreferences {
            DockVisibilityPreferences(read: { self.value }, write: { value in
                try self.beforeWrite?()
                if self.failWrite { throw Failure.simulated }
                self.writes.append(value); self.value = value
            }, synchronize: {})
        }
        func refresh() throws {
            if failRefresh { throw Failure.simulated }
            refreshes += 1
        }
    }

    @MainActor
    private final class Clock {
        struct Job {
            let id: UUID
            let date: Date
            let action: DockVisibilityScheduler.Action
        }
        var date = Date(timeIntervalSince1970: 1_000)
        var jobs: [Job] = []
        var cancelled: Set<UUID> = []
        var scheduler: DockVisibilityScheduler {
            DockVisibilityScheduler(now: { self.date }, schedule: { date, action in
                let id = UUID()
                self.jobs.append(Job(id: id, date: date, action: action))
                return { self.cancelled.insert(id) }
            })
        }
        func advance(_ seconds: TimeInterval) {
            date = date.addingTimeInterval(seconds)
            let ready = jobs.filter { $0.date <= date }.sorted { $0.date < $1.date }
            jobs.removeAll { $0.date <= date }
            for job in ready where !cancelled.contains(job.id) { job.action() }
        }
    }

    private func withReceipt(_ body: (URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("DockVisibilityTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root.appendingPathComponent("visibility/receipt.json"))
    }

    private func manager(_ receipt: URL, _ preferences: Preferences, _ clock: Clock,
                         onError: @escaping (Error) -> Void = { _ in }) -> DockVisibilityManager {
        DockVisibilityManager(receiptURL: receipt, preferences: preferences.access,
                              scheduler: clock.scheduler, refreshDock: preferences.refresh, onError: onError)
    }

    func testUnsetAndFalseArePreservedWithoutReceiptOrRefresh() throws {
        for original: Bool? in [nil, false] {
            try withReceipt { receipt in
                let preferences = Preferences(original), clock = Clock()
                let manager = manager(receipt, preferences, clock)
                try manager.beginPresentation(); try manager.dragBegan(); try manager.endPresentation()
                clock.advance(11)
                try manager.restoreOnTermination()
                XCTAssertEqual(preferences.value, original)
                XCTAssertTrue(preferences.writes.isEmpty)
                XCTAssertEqual(preferences.refreshes, 0)
                XCTAssertFalse(FileManager.default.fileExists(atPath: receipt.path))
            }
        }
    }

    func testTimerStartsAtPickupAndMovementDoesNotExtendIt() throws {
        try withReceipt { receipt in
            let preferences = Preferences(true), clock = Clock()
            let manager = manager(receipt, preferences, clock)
            try manager.beginPresentation()
            XCTAssertEqual(preferences.value, false)
            XCTAssertTrue(manager.isTemporarilyVisible)
            clock.advance(30) // Presentation alone has no ten-second expiry.
            try manager.beginPresentation()
            XCTAssertEqual(preferences.refreshes, 1)
            XCTAssertEqual(preferences.writes, [false])
            try manager.dragBegan()
            let deadline = try XCTUnwrap(manager.restoreDeadline)
            clock.advance(4)
            try manager.beginPresentation() // Movement cannot extend a pickup deadline.
            XCTAssertEqual(manager.restoreDeadline, deadline)
            clock.advance(5)
            XCTAssertEqual(preferences.value, false)
            clock.advance(1)
            XCTAssertEqual(preferences.value, true)
            XCTAssertEqual(preferences.writes, [false, true])
            XCTAssertEqual(preferences.refreshes, 2)
            XCTAssertNil(manager.restoreDeadline)
            XCTAssertFalse(manager.isTemporarilyVisible)
            XCTAssertFalse(FileManager.default.fileExists(atPath: receipt.path))
        }
    }

    func testClosingBeforePickupRestoresImmediately() throws {
        try withReceipt { receipt in
            let preferences = Preferences(true), clock = Clock()
            let manager = manager(receipt, preferences, clock)
            try manager.beginPresentation(); try manager.endPresentation()
            XCTAssertEqual(preferences.value, true)
            XCTAssertEqual(preferences.writes, [false, true])
            clock.advance(20)
            XCTAssertEqual(preferences.refreshes, 2)
        }
    }

    func testClosingAfterPickupRestoresImmediatelyAndCancelsOldTimer() throws {
        try withReceipt { receipt in
            let preferences = Preferences(true), clock = Clock()
            let manager = manager(receipt, preferences, clock)
            try manager.beginPresentation(); try manager.dragBegan()
            clock.advance(4)
            try manager.endPresentation()
            XCTAssertEqual(preferences.value, true)
            XCTAssertNil(manager.restoreDeadline)
            XCTAssertFalse(manager.isTemporarilyVisible)
            XCTAssertFalse(FileManager.default.fileExists(atPath: receipt.path))

            // A dismissed popup's timer must not hide Dock under a new popup.
            try manager.beginPresentation()
            clock.advance(20)
            XCTAssertEqual(preferences.value, false)
            XCTAssertEqual(preferences.writes, [false, true, false])
            try manager.endPresentation()
            XCTAssertEqual(preferences.value, true)
            XCTAssertEqual(preferences.writes, [false, true, false, true])
        }
    }

    func testRepeatedDragResetsTenSecondsAndNormalQuitCancelsTimer() throws {
        try withReceipt { receipt in
            let preferences = Preferences(true), clock = Clock()
            let manager = manager(receipt, preferences, clock)
            try manager.beginPresentation(); try manager.dragBegan()
            clock.advance(4)
            try manager.dragBegan()
            XCTAssertEqual(manager.restoreDeadline, clock.date.addingTimeInterval(10))
            clock.advance(6) // Old timer has been cancelled.
            XCTAssertEqual(preferences.value, false)
            try manager.restoreOnTermination()
            XCTAssertEqual(preferences.value, true)
            clock.advance(30)
            XCTAssertEqual(preferences.writes, [false, true])
        }
    }

    func testValidPersistentReceiptRecoversOnNextStartup() throws {
        try withReceipt { receipt in
            let preferences = Preferences(true), clock = Clock()
            let originalManager = manager(receipt, preferences, clock)
            preferences.beforeWrite = {
                let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: receipt)) as? [String: Any])
                XCTAssertEqual(json["state"] as? String, "prepared")
                XCTAssertEqual(json["originalAutohide"] as? Bool, true)
            }
            try originalManager.beginPresentation()
            preferences.beforeWrite = nil
            let recovered = manager(receipt, preferences, Clock())
            try recovered.recoverIfNeeded()
            XCTAssertEqual(preferences.value, true)
            XCTAssertEqual(preferences.writes, [false, true])
            XCTAssertFalse(FileManager.default.fileExists(atPath: receipt.path))
            try recovered.recoverIfNeeded()
            XCTAssertEqual(preferences.refreshes, 2)
        }
    }

    func testExternalUnsetOrEnabledPreferenceIsNotOverwritten() throws {
        for external: Bool? in [nil, true] {
            try withReceipt { receipt in
                let preferences = Preferences(true), clock = Clock()
                let manager = manager(receipt, preferences, clock)
                try manager.beginPresentation(); try manager.dragBegan()
                preferences.value = external
                clock.advance(10)
                XCTAssertEqual(preferences.value, external)
                XCTAssertEqual(preferences.writes, [false])
                XCTAssertEqual(preferences.refreshes, 1)
                XCTAssertFalse(FileManager.default.fileExists(atPath: receipt.path))
            }
        }
    }

    func testCorruptOrForeignReceiptFailsClosedAndIsPreserved() throws {
        try withReceipt { receipt in
            let preferences = Preferences(true), clock = Clock()
            let first = manager(receipt, preferences, clock)
            try first.beginPresentation()
            var json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: receipt)) as? [String: Any])
            json["owner"] = "another.application"
            try JSONSerialization.data(withJSONObject: json).write(to: receipt)
            let recovered = manager(receipt, preferences, Clock())
            XCTAssertThrowsError(try recovered.recoverIfNeeded())
            XCTAssertEqual(preferences.value, false)
            XCTAssertEqual(preferences.writes, [false])
            XCTAssertTrue(FileManager.default.fileExists(atPath: receipt.path))
            try Data("{broken".utf8).write(to: receipt)
            XCTAssertThrowsError(try first.restoreOnTermination())
            XCTAssertEqual(preferences.writes, [false])
        }
    }

    func testMissingOwnedReceiptCannotAuthorizeRestoration() throws {
        try withReceipt { receipt in
            let preferences = Preferences(true), clock = Clock()
            let manager = manager(receipt, preferences, clock)
            try manager.beginPresentation()
            try FileManager.default.removeItem(at: receipt)
            XCTAssertThrowsError(try manager.restoreOnTermination())
            XCTAssertEqual(preferences.value, false)
            XCTAssertEqual(preferences.writes, [false])
        }
    }

    func testTimedWriteFailureReportsErrorAndRetainsRecoveryReceipt() throws {
        try withReceipt { receipt in
            let preferences = Preferences(true), clock = Clock()
            var failures = 0
            let manager = manager(receipt, preferences, clock, onError: { _ in failures += 1 })
            try manager.beginPresentation(); try manager.dragBegan()
            preferences.failWrite = true
            clock.advance(10)
            XCTAssertEqual(failures, 1)
            XCTAssertNotNil(manager.lastError)
            XCTAssertTrue(FileManager.default.fileExists(atPath: receipt.path))
            XCTAssertEqual(preferences.value, false)
            preferences.failWrite = false
            try manager.restoreOnTermination()
            XCTAssertEqual(preferences.value, true)
        }
    }

    func testRefreshFailureAfterRestoreIsRecoverableWithoutAnotherPreferenceWrite() throws {
        try withReceipt { receipt in
            let preferences = Preferences(true), clock = Clock()
            let original = manager(receipt, preferences, clock)
            try original.beginPresentation()
            preferences.failRefresh = true
            XCTAssertThrowsError(try original.endPresentation())
            XCTAssertEqual(preferences.value, true)
            XCTAssertTrue(FileManager.default.fileExists(atPath: receipt.path))
            preferences.failRefresh = false
            let recovered = manager(receipt, preferences, Clock())
            try recovered.recoverIfNeeded()
            XCTAssertEqual(preferences.writes, [false, true])
            XCTAssertFalse(FileManager.default.fileExists(atPath: receipt.path))
        }
    }
}
