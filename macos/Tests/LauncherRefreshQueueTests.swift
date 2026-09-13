import Foundation
import XCTest
@testable import ExtensionsAnywhere

@MainActor
final class LauncherRefreshQueueTests: XCTestCase {
    private func app(_ name: String) -> InstalledApp {
        let url = URL(fileURLWithPath: "/Applications/\(name).app")
        return InstalledApp(id: url.path, name: name, bundleIdentifier: "test.\(name)", url: url)
    }

    func testOnlyExistingHelpersAreSeededAndAtMostOneIsPreparedPerPoll() {
        let apps = [app("Missing"), app("First"), app("Second")]
        var queue = LauncherRefreshQueue(), refreshed: [String] = [], updated: [String] = []
        for expectedCount in 1...2 {
            queue.poll(apps: apps, exists: { $0.name != "Missing" }, active: { _ in false },
                       refresh: { refreshed.append($0.name); return .updated },
                       didUpdate: { updated.append($0.name) }, failed: { _, _ in XCTFail("Unexpected error") })
            XCTAssertEqual(refreshed.count, expectedCount)
        }
        queue.poll(apps: apps, exists: { $0.name != "Missing" }, active: { _ in false },
                   refresh: { _ in XCTFail("Completed helpers must not repeat"); return .updated },
                   didUpdate: { _ in XCTFail("No repeated event") }, failed: { _, _ in XCTFail("Unexpected error") })
        XCTAssertEqual(refreshed, ["First", "Second"])
        XCTAssertEqual(updated, refreshed)
    }

    func testActiveHelperStaysQueuedWhileAnotherUpdatesThenRefreshesAfterExit() {
        let activeApp = app("Active"), idle = app("Idle")
        var queue = LauncherRefreshQueue(), active = true, refreshed: [String] = []
        func poll() {
            queue.poll(apps: [activeApp, idle], exists: { _ in true },
                       active: { $0.id == activeApp.id && active },
                       refresh: { refreshed.append($0.name); return .updated },
                       didUpdate: { _ in }, failed: { _, _ in XCTFail("Unexpected error") })
        }
        poll()
        XCTAssertEqual(refreshed, ["Idle"])
        poll()
        XCTAssertEqual(refreshed, ["Idle"])
        active = false
        poll()
        XCTAssertEqual(refreshed, ["Idle", "Active"])
    }

    func testHelperThatRacesActiveDuringPreparationIsNotMarkedUpdated() {
        let apps = [app("Race")]
        var queue = LauncherRefreshQueue(), attempts = 0, events = 0
        for _ in 0..<3 {
            queue.poll(apps: apps, exists: { _ in true }, active: { _ in false },
                       refresh: { _ in attempts += 1; return attempts == 1 ? .deferred : .current },
                       didUpdate: { _ in events += 1 }, failed: { _, _ in XCTFail("Unexpected error") })
        }
        XCTAssertEqual(attempts, 2)
        XCTAssertEqual(events, 0)
    }

    func testRealErrorIsReportedOnceWithoutBlockingOtherHelpers() {
        enum Failure: Error { case invalidBundle }
        let apps = [app("Broken"), app("Good")]
        var queue = LauncherRefreshQueue(), errors: [String] = [], updates: [String] = []
        for _ in 0..<4 {
            queue.poll(apps: apps, exists: { _ in true }, active: { _ in false }, refresh: {
                if $0.name == "Broken" { throw Failure.invalidBundle }
                return .updated
            }, didUpdate: { updates.append($0.name) }, failed: { app, _ in errors.append(app.name) })
        }
        XCTAssertEqual(errors, ["Broken"])
        XCTAssertEqual(updates, ["Good"])
    }

    func testRemovedAssignmentAndMissingHelperCannotBePrepared() {
        let first = app("Removed"), second = app("Vanished")
        var queue = LauncherRefreshQueue(), attempts: [String] = []
        queue.poll(apps: [first, second], exists: { _ in true }, active: { _ in true },
                   refresh: { _ in XCTFail("Active helper"); return .updated },
                   didUpdate: { _ in }, failed: { _, _ in XCTFail("Unexpected error") })
        queue.poll(apps: [second], exists: { _ in false }, active: { _ in false },
                   refresh: { attempts.append($0.name); return .missing },
                   didUpdate: { _ in XCTFail("Missing is not updated") }, failed: { _, _ in XCTFail("Unexpected error") })
        queue.poll(apps: [second], exists: { _ in false }, active: { _ in false },
                   refresh: { _ in XCTFail("Missing helper completed"); return .updated },
                   didUpdate: { _ in }, failed: { _, _ in XCTFail("Unexpected error") })
        XCTAssertEqual(attempts, ["Vanished"])
    }

    func testPresenceErrorsAreReportedOnceAndNeverPrepared() {
        enum Failure: Error { case unexpectedIdentity }
        var queue = LauncherRefreshQueue(), errors = 0
        for _ in 0..<3 {
            queue.poll(apps: [app("Conflicting")], exists: { _ in throw Failure.unexpectedIdentity },
                       active: { _ in XCTFail("Invalid bundle"); return false },
                       refresh: { _ in XCTFail("Invalid bundle"); return .updated },
                       didUpdate: { _ in }, failed: { _, _ in errors += 1 })
        }
        XCTAssertEqual(errors, 1)
    }

    func testExistingOnlyPreparationDoesNotCreateGenericAliasOrHelper() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("LauncherRefresh-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        var dockWrites = 0, opens = 0
        let dock = DockShortcutManager(receiptDirectory: root.appendingPathComponent("Receipts"),
            preferences: DockPreferencesAccess(read: { [] }, write: { _ in dockWrites += 1 }, refresh: {}))
        let launcher = ElectronLauncher(supportDirectory: root.appendingPathComponent("Launchers"), dock: dock,
            refreshDock: { dockWrites += 1 }, openURL: { _ in opens += 1; return true }, runtimeResources: nil)
        let unconfigured = app("NotConfigured")
        try launcher.prepare(app: unconfigured, libraryURL: root.appendingPathComponent("library.json"), records: [], existingOnly: true)
        XCTAssertEqual(try launcher.refreshExistingHelper(app: unconfigured, libraryURL: root.appendingPathComponent("library.json"), records: []), .missing)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        XCTAssertEqual(dockWrites, 0)
        XCTAssertEqual(opens, 0)
    }
}
