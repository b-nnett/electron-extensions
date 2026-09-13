import Foundation
import RuntimeCatalog
import XCTest
@testable import ExtensionsAnywhere

final class RuntimeCatalogTests: XCTestCase {
    private func entry(_ overrides: [String: Any] = [:]) -> [String: Any] {
        var value: [String: Any] = ["slug": "sample", "name": "Sample", "bundlePath": "/Applications/Sample.app",
            "bundleIdentifier": "example.sample", "executable": "/Applications/Sample.app/Contents/MacOS/Sample",
            "transport": "pipe", "arguments": [], "target": ["urlPattern": "^app://main/$", "selector": "button#sample"]]
        value.merge(overrides) { _, new in new }
        return value
    }

    func testCatalogRejectsAmbiguousOrEscapingIdentitiesAndInvalidPatterns() throws {
        let invalid: [[String: Any]] = [
            ["slug": "../sample"], ["slug": "chatgpt"], ["bundlePath": "/tmp/Sample.app"],
            ["bundlePath": "/Applications/../tmp/Sample.app"], ["executable": "/bin/sh"],
            ["executable": "/Applications/Sample.app/Contents/MacOS/../Resources/Sample"],
            ["transport": "inspector-bypass"], ["arguments": ["--foo\n--bar"]],
            ["arguments": ["--no-sandbox"]], ["arguments": ["--user-data-dir=/tmp/profile"]],
            ["arguments": ["--remote-debugging-pipe", "--remote-debugging-pipe"]],
            ["arguments": ["--remote-debugging-port=0"]],
            ["arguments": ["--ignoreAdditionalCommandLineFlags"]],
            ["target": ["urlPattern": "^[$", "selector": "button"]]
        ]
        for overrides in invalid {
            XCTAssertThrowsError(try RuntimeAppCatalog.decode(JSONSerialization.data(withJSONObject: [entry(overrides)])))
        }
        XCTAssertThrowsError(try RuntimeAppCatalog.decode(JSONSerialization.data(withJSONObject: [entry(), entry()])))
        XCTAssertThrowsError(try RuntimeAppCatalog.decode(Data(repeating: 0x20, count: 256 * 1024 + 1)))
        XCTAssertNoThrow(try RuntimeAppCatalog.decode(JSONSerialization.data(withJSONObject: [entry(["arguments": ["--remote-debugging-pipe"]])])))
        XCTAssertNoThrow(try RuntimeAppCatalog.decode(JSONSerialization.data(withJSONObject: [entry(["slug": "compass", "arguments": ["--ignoreAdditionalCommandLineFlags"]])])))
        XCTAssertNoThrow(try RuntimeAppCatalog.decode(JSONSerialization.data(withJSONObject: [entry(["transport": "tcp", "arguments": ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"]])])))
    }

    func testPackagedProfilesRequireBothExactBundleAndIdentifier() throws {
        XCTAssertFalse(RuntimeAppCatalog.entries.isEmpty)
        for definition in RuntimeAppCatalog.entries {
            let url = URL(fileURLWithPath: definition.bundlePath)
            let app = InstalledApp(id: url.path, name: definition.name, bundleIdentifier: definition.bundleIdentifier, url: url)
            XCTAssertEqual(ElectronLaunchProfile.profile(for: app)?.rawValue, definition.slug)
            XCTAssertEqual(ElectronLaunchProfile.profile(for: app)?.executable, definition.executable)
            XCTAssertNil(ElectronLaunchProfile.profile(for: .init(id: url.path, name: app.name, bundleIdentifier: "wrong.id", url: url)))
            let copy = URL(fileURLWithPath: "/tmp/\(url.lastPathComponent)")
            XCTAssertNil(ElectronLaunchProfile.profile(for: .init(id: copy.path, name: app.name, bundleIdentifier: definition.bundleIdentifier, url: copy)))
        }
    }

    func testOwnedLocalServiceIsPreservedOnlyForItsFixedAntigravityRoute() throws {
        let service = ["executableRelativePath": "Contents/Resources/bin/language_server"]
        let candidate = entry(["slug": "antigravity", "name": "Antigravity",
            "bundlePath": "/Applications/Antigravity.app", "bundleIdentifier": "com.google.antigravity",
            "executable": "/Applications/Antigravity.app/Contents/MacOS/Antigravity",
            "ownedLocalService": service,
            "target": ["urlPattern": #"^https://127\.0\.0\.1:[1-9][0-9]{3,4}/$"#,
                       "selector": #"button[aria-label="Toggle Sidebar"][data-testid="sidebar-toggle"]"#]])
        let decoded = try RuntimeAppCatalog.decode(JSONSerialization.data(withJSONObject: [candidate]))
        XCTAssertEqual(decoded[0].ownedLocalService?.executableRelativePath, service["executableRelativePath"])
        XCTAssertEqual(try RuntimeAppCatalog.decode(JSONEncoder().encode(decoded)), decoded)
        for override in [["bundleIdentifier": "example.other"], ["transport": "tcp"],
                         ["ownedLocalService": ["executableRelativePath": "../outside"]],
                         ["ownedLocalService": ["executableRelativePath": service["executableRelativePath"]!, "port": 9222]],
                         ["target": ["urlPattern": "^https://127.*$", "selector": "button"]]] as [[String: Any]] {
            var invalid = candidate
            invalid.merge(override) { _, new in new }
            XCTAssertThrowsError(try RuntimeAppCatalog.decode(JSONSerialization.data(withJSONObject: [invalid])))
        }
        XCTAssertThrowsError(try RuntimeAppCatalog.decode(JSONSerialization.data(withJSONObject: [entry(["ownedLocalService": service])])))
    }
}

final class RuntimeLauncherConfigurationTests: XCTestCase {
    private func temporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory.resolvingSymlinksInPath()
    }

    func testOnlyTheCanonicalSiblingSessionsDirectoryCanBeWritten() throws {
        let parent = try temporaryDirectory()
        let sessions = parent.appendingPathComponent("Sessions")
        XCTAssertEqual(try RuntimeLauncherConfigurationFiles.sessionsDirectory(sessions.path, launcherDirectory: parent).path, sessions.path)
        XCTAssertFalse(FileManager.default.fileExists(atPath: sessions.path))
        for wrong in ["relative", "/Applications/Figma.app/Contents/Sessions", parent.appendingPathComponent("Other").path,
                      parent.path + "/../Sessions", parent.path + "/./Sessions"] {
            XCTAssertThrowsError(try RuntimeLauncherConfigurationFiles.sessionsDirectory(wrong, launcherDirectory: parent))
        }
        let outside = try temporaryDirectory()
        try FileManager.default.createSymbolicLink(at: sessions, withDestinationURL: outside)
        XCTAssertThrowsError(try RuntimeLauncherConfigurationFiles.sessionsDirectory(sessions.path, launcherDirectory: parent))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: outside.path).isEmpty)
        let nestedApp = parent.appendingPathComponent("OwnedTest.app/Launchers")
        XCTAssertThrowsError(try RuntimeLauncherConfigurationFiles.sessionsDirectory(nestedApp.appendingPathComponent("Sessions").path, launcherDirectory: nestedApp))
    }

    func testConfigurationReadIsBoundedRegularAndDoesNotFollowSubstitutedSymlinks() throws {
        let parent = try temporaryDirectory()
        let config = parent.appendingPathComponent("configuration.json")
        let expected = Data(#"{"schemaVersion":1}"#.utf8)
        try expected.write(to: config)
        XCTAssertEqual(try RuntimeLauncherConfigurationFiles.read(in: parent), expected)
        try Data(repeating: 0x20, count: RuntimeLauncherConfigurationFiles.maximumBytes + 1).write(to: config)
        XCTAssertThrowsError(try RuntimeLauncherConfigurationFiles.read(in: parent))
        try FileManager.default.removeItem(at: config)
        let external = try temporaryDirectory().appendingPathComponent("configuration.json")
        try expected.write(to: external)
        try FileManager.default.createSymbolicLink(at: config, withDestinationURL: external)
        XCTAssertThrowsError(try RuntimeLauncherConfigurationFiles.read(in: parent))
        XCTAssertEqual(try Data(contentsOf: external), expected)
    }
}

@MainActor
final class RuntimeEventJournalTests: XCTestCase {
    func testJournalPersistsOnlyBoundedMetadataWithPrivatePermissions() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appendingPathComponent("events.json")
        let appURL = URL(fileURLWithPath: "/Applications/Sample.app")
        let app = InstalledApp(id: appURL.path, name: "Sample", bundleIdentifier: "example.sample", url: appURL)
        let journal = RuntimeEventJournal(url: url)
        for index in 0...RuntimeEventJournal.maximumEvents {
            journal.record("event-\(index)", app: app, processIdentifier: 42, processStartedAt: Date(timeIntervalSince1970: 123))
        }
        let saved = try JSONDecoder().decode([RuntimeEventJournal.Event].self, from: Data(contentsOf: url))
        XCTAssertEqual(saved.count, RuntimeEventJournal.maximumEvents)
        XCTAssertEqual(saved.first?.event, "event-1")
        XCTAssertEqual(saved.last?.processIdentifier, 42)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber, 0o600)
        RuntimeEventJournal(url: url).record("restored", app: app)
        let restored = try JSONDecoder().decode([RuntimeEventJournal.Event].self, from: Data(contentsOf: url))
        XCTAssertEqual(restored.count, RuntimeEventJournal.maximumEvents)
        XCTAssertEqual(restored.last?.event, "restored")
    }
}
