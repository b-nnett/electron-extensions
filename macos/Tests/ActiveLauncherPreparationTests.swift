import Foundation
import RuntimeCatalog
import XCTest
@testable import ExtensionsAnywhere

final class ActiveLauncherPreparationTests: XCTestCase {
    private struct Fixture {
        let root: URL
        let helper: URL
        let alias: URL
        let library: URL
        let broker: URL
        let app: InstalledApp
        let configuration: URL
    }

    private func withFixture(_ body: (Fixture) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ActiveLauncherPreparation-\(UUID().uuidString)")
            .standardizedFileURL.resolvingSymlinksInPath()
        defer { try? FileManager.default.removeItem(at: root) }
        let helper = root.appendingPathComponent("Style Lab Launcher.app")
        let broker = helper.appendingPathComponent("Contents/Resources/Runtime/scripts/dock-fixture-session.mjs")
        try FileManager.default.createDirectory(at: broker.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("// stored legacy resource".utf8).write(to: broker)
        let alias = root.appendingPathComponent("Style Lab.app")
        let bookmark = try helper.bookmarkData(options: .suitableForBookmarkFile, includingResourceValuesForKeys: nil, relativeTo: nil)
        try URL.writeBookmarkData(bookmark, to: alias)
        let library = root.appendingPathComponent("library.json")
        let app = InstalledApp(id: ElectronLaunchProfile.fixtureURL.path, name: "Style Lab",
            bundleIdentifier: ElectronLaunchProfile.fixtureKey, url: ElectronLaunchProfile.fixtureURL)
        let configuration = root.appendingPathComponent("configuration.json")
        let values: [String: Any] = ["schemaVersion": 1, "profile": "stylelab", "targetBundlePath": app.url.path,
            "targetBundleIdentifier": app.bundleIdentifier!, "libraryPath": library.path,
            "nodePath": "/old-build-host/node", "brokerPath": broker.path,
            "sessionsPath": root.appendingPathComponent("Sessions").path]
        try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]).write(to: configuration)
        try body(Fixture(root: root, helper: helper, alias: alias, library: library, broker: broker, app: app, configuration: configuration))
    }

    private func preserve(_ f: Fixture, deferred: Bool = false, active: () throws -> Bool = { true },
                          records: [ExtensionRecord] = []) throws -> Bool {
        try ActiveLauncherPreparation.preserveIfNeeded(deferred: deferred, isActive: active,
            launcher: f.helper, alias: f.alias, app: f.app, profile: .stylelab,
            libraryURL: f.library, brokerURL: f.broker, records: records)
    }

    func testActiveLegacyHelperPreservesConfigurationAndAliasWithoutBundledNode() throws {
        try withFixture { f in
            let config = try Data(contentsOf: f.configuration), alias = try Data(contentsOf: f.alias)
            XCTAssertTrue(try preserve(f))
            XCTAssertEqual(try Data(contentsOf: f.configuration), config)
            XCTAssertEqual(try Data(contentsOf: f.alias), alias)
            XCTAssertFalse(FileManager.default.fileExists(atPath: f.helper.appendingPathComponent("Contents/Resources/Runtime/native/node").path))
        }
    }

    func testDeferredReplacementPreservesExistingShortcutEvenIfHelperThenExits() throws {
        try withFixture { f in
            let config = try Data(contentsOf: f.configuration)
            XCTAssertTrue(try preserve(f, deferred: true, active: { false }))
            XCTAssertEqual(try Data(contentsOf: f.configuration), config)
        }
    }

    func testStoppedHelperContinuesMigrationWithoutRequiringLegacyConfiguration() throws {
        try withFixture { f in
            try FileManager.default.removeItem(at: f.configuration)
            XCTAssertFalse(try preserve(f, active: { false }))
        }
    }

    func testConfigurationForAnotherAppOrLibraryIsRejectedWithoutWrites() throws {
        try withFixture { f in
            let original = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: f.configuration)) as? [String: Any])
            for key in ["profile", "targetBundlePath", "targetBundleIdentifier", "libraryPath", "brokerPath", "sessionsPath"] {
                var changed = original
                changed[key] = "/unexpected"
                let bytes = try JSONSerialization.data(withJSONObject: changed)
                try bytes.write(to: f.configuration)
                XCTAssertThrowsError(try preserve(f), key)
                XCTAssertEqual(try Data(contentsOf: f.configuration), bytes)
            }
        }
    }

    func testChangedAliasAndUnresolvedActivityAreRejectedWithoutWrites() throws {
        try withFixture { f in
            let other = f.root.appendingPathComponent("Other.app")
            try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
            let bookmark = try other.bookmarkData(options: .suitableForBookmarkFile, includingResourceValuesForKeys: nil, relativeTo: nil)
            try URL.writeBookmarkData(bookmark, to: f.alias)
            let bytes = try Data(contentsOf: f.alias)
            XCTAssertThrowsError(try preserve(f))
            XCTAssertEqual(try Data(contentsOf: f.alias), bytes)
            XCTAssertThrowsError(try preserve(f, active: { throw CocoaError(.fileReadNoPermission) }))
        }
    }

    private func scriptRecord(enabled: Bool = true, mixed: Bool = false) -> ExtensionRecord {
        let sources: [StoredExtensionSource] = mixed
            ? [.init(fileName: "main.css", type: .css, text: "button {}"), .init(fileName: "main.js", type: .js, text: "console.log(1)")]
            : [.init(fileName: "main.js", type: .js, text: "console.log(1)")]
        let first = sources[0]
        return ExtensionRecord(id: UUID(), appKey: ElectronLaunchProfile.fixtureKey, name: "Example", description: "Example",
            sourceFileName: first.fileName, sourceType: first.type, sourceText: first.text,
            isEnabled: enabled, createdAt: Date(), sourceFiles: sources)
    }

    func testActiveLegacyHelperRefusesJSBeforeSharedLibraryOrAliasChanges() throws {
        try withFixture { f in
            let original = Data(#"{"records":[],"schemaVersion":1}"#.utf8)
            try original.write(to: f.library)
            let configuration = try Data(contentsOf: f.configuration), alias = try Data(contentsOf: f.alias)
            for mixed in [false, true] {
                XCTAssertThrowsError(try preserve(f, records: [scriptRecord(mixed: mixed)])) { error in
                    guard let launcherError = error as? ElectronLaunchError,
                          case .runtimeUpgradeRequired(let appName) = launcherError else {
                        return XCTFail("Expected an actionable runtime upgrade error, got \(error)")
                    }
                    XCTAssertEqual(appName, "Style Lab")
                }
                XCTAssertEqual(try Data(contentsOf: f.library), original)
                XCTAssertEqual(try Data(contentsOf: f.configuration), configuration)
                XCTAssertEqual(try Data(contentsOf: f.alias), alias)
            }
            XCTAssertTrue(try preserve(f, records: [scriptRecord(enabled: false)]))
            let css = ExtensionRecord(id: UUID(), appKey: ElectronLaunchProfile.fixtureKey, name: "CSS", description: "CSS",
                sourceFileName: "main.css", sourceType: .css, sourceText: "button {}", isEnabled: true, createdAt: Date())
            XCTAssertTrue(try preserve(f, records: [css]))
            XCTAssertThrowsError(try preserve(f, deferred: true, active: { false }, records: [scriptRecord()]))
        }
    }

    func testActiveCapableHelperCanApplyJSAndStoppedLegacyHelperCanUpdate() throws {
        try withFixture { f in
            var info: [String: Any] = ["CFBundleIdentifier": "dev.extensionsanywhere.launcher.stylelab",
                                       "CFBundleExecutable": "ExtensionLauncher"]
            info.merge(RuntimeHelperCapabilities.metadata(profile: "stylelab", targetIdentifier: "dev.extensionsanywhere.stylelab")) { _, marker in marker }
            let metadata = f.helper.appendingPathComponent("Contents/Info.plist")
            try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: metadata)
            XCTAssertTrue(try preserve(f, records: [scriptRecord(), scriptRecord(mixed: true)]))
            try FileManager.default.removeItem(at: metadata)
            XCTAssertFalse(try preserve(f, active: { false }, records: [scriptRecord()]))
        }
    }

    func testReadOnlyRestartInspectionHandlesUnmarkedHelperWithAlreadySavedJSWithoutWrites() throws {
        try withFixture { f in
            let records = [scriptRecord(), scriptRecord(mixed: true)]
            let original = try JSONEncoder().encode(records)
            try original.write(to: f.library)
            let configuration = try Data(contentsOf: f.configuration), alias = try Data(contentsOf: f.alias)
            XCTAssertThrowsError(try preserve(f, records: records))
            let inspected = ActiveLauncherPreparation.readOnlyRestartRecords(records)
            XCTAssertEqual(inspected.map(\.isEnabled), [false, false])
            XCTAssertEqual(records.map(\.isEnabled), [true, true])
            for (original, disabled) in zip(records, inspected) {
                var restored = disabled
                restored.isEnabled = original.isEnabled
                XCTAssertEqual(restored, original)
            }
            // Even an empty enabled inspection selection only checks identity;
            // it neither writes preferences nor creates/opens an ordinary alias.
            XCTAssertTrue(try preserve(f, deferred: true, active: { false }, records: inspected))
            XCTAssertEqual(try Data(contentsOf: f.library), original)
            XCTAssertEqual(try Data(contentsOf: f.configuration), configuration)
            XCTAssertEqual(try Data(contentsOf: f.alias), alias)
        }
    }
}
