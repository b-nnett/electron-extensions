import Foundation
import XCTest
@testable import ExtensionsAnywhere

@MainActor
final class AppPreferencesTests: XCTestCase {
    private func withDefaults(_ body: (UserDefaults, String) throws -> Void) throws {
        let suiteName = "ExtensionsAnywhere-AppPreferencesTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }
        try body(defaults, suiteName)
    }

    private func app(_ name: String, identity: String? = nil,
                     bundleIdentifier: String = "test.example") -> InstalledApp {
        let url = URL(fileURLWithPath: "/AppPreferencesTests/\(identity ?? name).app")
        return InstalledApp(id: url.path, name: name, bundleIdentifier: bundleIdentifier, url: url)
    }

    func testRestartPromptDefaultsOnAndEmptyMenuContainsNoApps() throws {
        try withDefaults { defaults, _ in
            let preferences = AppPreferences(defaults: defaults)
            XCTAssertTrue(preferences.promptToRestartAppsWithoutExtensions)
            XCTAssertTrue(preferences.mostUsedApps(from: []).isEmpty)
            let layout = preferences.menuLayout(for: [])
            XCTAssertFalse(layout.usesSubmenu)
            XCTAssertTrue(layout.directApps.isEmpty)
            XCTAssertTrue(layout.mostUsedApps.isEmpty)
            XCTAssertTrue(layout.allApps.isEmpty)
        }
    }

    func testRestartPromptPersistsBothFalseAndTrueAcrossInstances() throws {
        try withDefaults { defaults, suiteName in
            let first = AppPreferences(defaults: defaults)
            first.promptToRestartAppsWithoutExtensions = false
            let second = AppPreferences(defaults: try XCTUnwrap(UserDefaults(suiteName: suiteName)))
            XCTAssertFalse(second.promptToRestartAppsWithoutExtensions)

            second.promptToRestartAppsWithoutExtensions = true
            let third = AppPreferences(defaults: try XCTUnwrap(UserDefaults(suiteName: suiteName)))
            XCTAssertTrue(third.promptToRestartAppsWithoutExtensions)
        }
    }

    func testUsageCountThenRecencySurviveReloadAndContinueAccumulating() throws {
        try withDefaults { defaults, suiteName in
            var date = Date(timeIntervalSince1970: 1_000)
            let preferences = AppPreferences(defaults: defaults, now: { date })
            let frequent = app("Zulu"), older = app("Alpha"), recent = app("Zebra"), unused = app("Beta")
            preferences.recordUse(of: frequent)
            preferences.recordUse(of: frequent)
            date = Date(timeIntervalSince1970: 2_000)
            preferences.recordUse(of: older)
            date = Date(timeIntervalSince1970: 3_000)
            preferences.recordUse(of: recent)
            let supplied = [unused, older, frequent, recent]

            let reloaded = AppPreferences(
                defaults: try XCTUnwrap(UserDefaults(suiteName: suiteName)), now: { date }
            )
            XCTAssertEqual(reloaded.mostUsedApps(from: supplied), [frequent, recent, older, unused])

            date = Date(timeIntervalSince1970: 4_000)
            reloaded.recordUse(of: older)
            XCTAssertEqual(reloaded.mostUsedApps(from: supplied), [older, frequent, recent, unused])
        }
    }

    func testEqualUsageSortsByLocalizedNameThenInstalledID() throws {
        try withDefaults { defaults, _ in
            let preferences = AppPreferences(defaults: defaults, now: { Date(timeIntervalSince1970: 1_000) })
            let second = app("App 2"), tenth = app("App 10")
            let echoA = app("Echo", identity: "A/Echo"), echoB = app("Echo", identity: "B/Echo")
            let supplied = [echoB, tenth, echoA, second]
            let expected = [second, tenth, echoA, echoB]
            XCTAssertEqual(preferences.mostUsedApps(from: supplied), expected)
            for app in supplied { preferences.recordUse(of: app) }
            XCTAssertEqual(preferences.mostUsedApps(from: supplied), expected)
        }
    }

    func testUsageFollowsInstalledIdentityAcrossRenameWithoutMergingBundleIDs() throws {
        try withDefaults { defaults, suiteName in
            let preferences = AppPreferences(defaults: defaults, now: { Date(timeIntervalSince1970: 1_000) })
            let original = app("Original", identity: "First/Example")
            let renamed = app("Zulu", identity: "First/Example")
            let anotherInstallation = app("Aardvark", identity: "Second/Example")
            let middle = app("Middle", bundleIdentifier: "test.middle")
            preferences.recordUse(of: original)
            preferences.recordUse(of: original)
            preferences.recordUse(of: middle)

            let reloaded = AppPreferences(defaults: try XCTUnwrap(UserDefaults(suiteName: suiteName)))
            XCTAssertEqual(
                reloaded.mostUsedApps(from: [anotherInstallation, middle, renamed]),
                [renamed, middle, anotherInstallation]
            )
        }
    }

    func testExactlyFiveAppsRemainDirectAndAlphabeticalRegardlessOfUsage() throws {
        try withDefaults { defaults, _ in
            let preferences = AppPreferences(defaults: defaults)
            let apps = ["Zulu", "Echo", "Charlie", "Bravo", "Alpha"].map { app($0) }
            preferences.recordUse(of: apps[0])
            let layout = preferences.menuLayout(for: apps)
            XCTAssertFalse(layout.usesSubmenu)
            XCTAssertEqual(layout.directApps.map(\.name), ["Alpha", "Bravo", "Charlie", "Echo", "Zulu"])
            XCTAssertTrue(layout.mostUsedApps.isEmpty)
            XCTAssertTrue(layout.allApps.isEmpty)
        }
    }

    func testExactlySixAppsHaveFiveRankedEntriesAndAllAppsAlphabetically() throws {
        try withDefaults { defaults, _ in
            let preferences = AppPreferences(defaults: defaults)
            let apps = ["Zulu", "Echo", "Delta", "Charlie", "Bravo", "Alpha"].map { app($0) }
            preferences.recordUse(of: apps[0])
            preferences.recordUse(of: apps[0])
            preferences.recordUse(of: apps[1])
            let layout = preferences.menuLayout(for: apps)
            XCTAssertTrue(layout.usesSubmenu)
            XCTAssertTrue(layout.directApps.isEmpty)
            XCTAssertEqual(layout.mostUsedApps.map(\.name), ["Zulu", "Echo", "Alpha", "Bravo", "Charlie"])
            XCTAssertEqual(layout.allApps.map(\.name), ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Zulu"])
            XCTAssertEqual(preferences.mostUsedApps(from: apps).count, 6)
        }
    }

    func testFilteredInputExcludesStaleUsageAndControlsMenuThreshold() throws {
        try withDefaults { defaults, _ in
            let preferences = AppPreferences(defaults: defaults)
            let stale = app("Previously Installed")
            for _ in 0..<3 { preferences.recordUse(of: stale) }
            let current = ["Foxtrot", "Echo", "Delta", "Charlie", "Bravo", "Alpha"].map { app($0) }
            preferences.recordUse(of: current[0])

            let six = preferences.menuLayout(for: current)
            XCTAssertTrue(six.usesSubmenu)
            XCTAssertEqual(six.mostUsedApps.map(\.name), ["Foxtrot", "Alpha", "Bravo", "Charlie", "Delta"])
            XCTAssertEqual(Set(six.allApps.map(\.id)), Set(current.map(\.id)))
            XCTAssertEqual(Set(preferences.mostUsedApps(from: current).map(\.id)), Set(current.map(\.id)))

            let five = preferences.menuLayout(for: Array(current.dropFirst()))
            XCTAssertFalse(five.usesSubmenu)
            XCTAssertEqual(five.directApps.map(\.name), ["Alpha", "Bravo", "Charlie", "Delta", "Echo"])
            XCTAssertTrue(five.mostUsedApps.isEmpty)
            XCTAssertTrue(five.allApps.isEmpty)
        }
    }
}
