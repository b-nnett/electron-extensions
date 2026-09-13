import Foundation
import XCTest
@testable import ExtensionsAnywhere

@MainActor
final class ExtensionManagerTests: XCTestCase {
    private final class DockState {
        var writes = 0
        var opens = 0
        var failDock = false
        var fallbackAttempts = 0
    }

    private func withManager(_ body: (URL, ExtensionManager, InstalledApp, DockState) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ExtensionManagerTests-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let appURL = root.appendingPathComponent("Example.app"), contents = appURL.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at: contents.appendingPathComponent("Frameworks/Electron Framework.framework"), withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": "test.manager", "CFBundleName": "Example", "CFBundleExecutable": "Example", "CFBundlePackageType": "APPL"], format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
        let app = try XCTUnwrap(ElectronAppDiscovery.scan(in: root).first)
        let state = DockState()
        let launcher = ElectronLauncher(supportDirectory: root.appendingPathComponent("Launchers"),
            dock: DockShortcutManager(receiptDirectory: root.appendingPathComponent("Receipts"),
                preferences: DockPreferencesAccess(read: {
                    if state.failDock { throw DockShortcutError.synchronizationFailed }
                    return []
                }, write: { _ in state.writes += 1 }, refresh: {})),
            refreshDock: {}, openURL: { _ in state.opens += 1; return true })
        let file = root.appendingPathComponent("library.json")
        _ = try ExtensionLibrary().adding(source: ImportedExtensionSource(fileName: "style.css", type: .css, text: "button { color: red; }"),
            appKey: "test.manager", name: "Original", description: "Original metadata", to: file)
        let manager = ExtensionManager(storageURL: file, launcher: launcher, presentDockInstaller: { _, _ in
            state.fallbackAttempts += 1; return false
        }); manager.reload()
        try body(file, manager, app, state)
    }

    private func editRecord(in file: URL, _ mutate: (inout [String: Any]) -> Void) throws {
        var library = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        var records = try XCTUnwrap(library["records"] as? [[String: Any]])
        mutate(&records[0]); library["records"] = records
        try JSONSerialization.data(withJSONObject: library, options: [.sortedKeys]).write(to: file, options: .atomic)
    }

    func testStaleSourceEditCannotBeOverwrittenByToggle() throws {
        try withManager { file, manager, app, state in
            let stale = try XCTUnwrap(manager.library.records.first)
            try editRecord(in: file) { $0["sourceText"] = "button { color: blue; }" }
            let changedBytes = try Data(contentsOf: file)
            manager.setEnabled(false, record: stale, app: app)
            XCTAssertTrue(manager.errorMessage?.contains("changed or was removed") == true)
            XCTAssertEqual(try Data(contentsOf: file), changedBytes)
            XCTAssertTrue(try ExtensionLibrary.load(from: file).records[0].isEnabled)
            XCTAssertEqual(state.writes, 0); XCTAssertEqual(state.opens, 0)
        }
    }

    func testStaleEnabledStateIsRejectedAndFreshRecordCanBeDisabled() throws {
        try withManager { file, manager, app, state in
            let stale = try XCTUnwrap(manager.library.records.first)
            try editRecord(in: file) { $0["isEnabled"] = false }
            let changedBytes = try Data(contentsOf: file)
            manager.setEnabled(true, record: stale, app: app)
            XCTAssertTrue(manager.errorMessage?.contains("changed or was removed") == true)
            XCTAssertEqual(try Data(contentsOf: file), changedBytes)
            try editRecord(in: file) { $0["isEnabled"] = true }
            manager.reload(); manager.errorMessage = nil
            manager.setEnabled(false, record: try XCTUnwrap(manager.library.records.first), app: app)
            XCTAssertNil(manager.errorMessage)
            XCTAssertFalse(try ExtensionLibrary.load(from: file).records[0].isEnabled)
            XCTAssertEqual(state.writes, 0); XCTAssertEqual(state.opens, 0)
        }
    }

    func testDisablingLastRecordPreservesExistingHelperConfigurationAndSessionArtifacts() throws {
        try withManager { file, manager, app, state in
            let directory = manager.launcher.directory(for: app)
            let helper = directory.appendingPathComponent("Example Launcher.app/Contents/Resources")
            try FileManager.default.createDirectory(at: helper, withIntermediateDirectories: true)
            let artifacts: [URL: Data] = [
                directory.appendingPathComponent("configuration.json"): Data("existing watcher configuration".utf8),
                directory.appendingPathComponent("latest-session.json"): Data("existing session pointer".utf8),
                helper.appendingPathComponent("owned-runtime-marker"): Data("existing helper".utf8)
            ]
            for (url, bytes) in artifacts { try bytes.write(to: url) }
            manager.setEnabled(false, record: try XCTUnwrap(manager.records(for: app).first), app: app)
            XCTAssertNil(manager.errorMessage)
            XCTAssertFalse(try XCTUnwrap(ExtensionLibrary.load(from: file).records.first).isEnabled)
            for (url, bytes) in artifacts { XCTAssertEqual(try Data(contentsOf: url), bytes) }
            XCTAssertEqual(state.opens, 0)
            XCTAssertEqual(state.fallbackAttempts, 0)
        }
    }

    func testSavedRecordAndDockErrorSurviveUnavailableFallbackUI() throws {
        try withManager { file, manager, app, state in
            let original = try ExtensionLibrary.load(from: file).records
            state.failDock = true
            try manager.add(source: ImportedExtensionSource(fileName: "proof.css", type: .css, text: "button { color: green; }"),
                            app: app, name: "Owned proof", description: "Temporary test")
            let saved = try ExtensionLibrary.load(from: file).records
            XCTAssertEqual(saved.count, original.count + 1)
            XCTAssertEqual(Array(saved.dropLast()), original)
            XCTAssertEqual(saved.last?.name, "Owned proof")
            XCTAssertEqual(manager.library.records.last?.id, saved.last?.id)
            XCTAssertTrue(manager.errorMessage?.contains("preference was saved") == true)
            XCTAssertTrue(manager.errorMessage?.contains("could not be synchronized") == true)
            XCTAssertEqual(state.fallbackAttempts, 1)
            XCTAssertEqual(state.writes, 0); XCTAssertEqual(state.opens, 0)
        }
    }

    func testDisabledMixedPackageKeepsAllOriginalSourceAndDoesNotLaunch() throws {
        try withManager { file, manager, app, state in
            manager.setEnabled(false, record: try XCTUnwrap(manager.library.records.first), app: app)
            let folder = file.deletingLastPathComponent().appendingPathComponent("mixed-package")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let css = "button { color: green; }"
            let js = "console.log('authored source, stored only');"
            try Data(css.utf8).write(to: folder.appendingPathComponent("style.css"))
            try Data(js.utf8).write(to: folder.appendingPathComponent("behavior.js"))
            let manifest = folder.appendingPathComponent("manifest.json")
            try Data(#"{"manifest_version":1,"name":"Stored mixed extension","description":"Kept for future runtime support","version":"1.0.0","css":["style.css"],"js":["behavior.js"]}"#.utf8).write(to: manifest)
            let package = try ImportedExtensionPackage.load(from: manifest)
            try manager.add(package: package, app: app, isEnabled: false)
            let saved = try XCTUnwrap(ExtensionLibrary.load(from: file).records.last)
            XCTAssertFalse(saved.isEnabled)
            XCTAssertEqual(saved.sourceFiles?.map(\.text), [css, js])
            XCTAssertEqual(saved.sourceFiles?.map(\.type), [.css, .js])
            XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("behavior.js"), encoding: .utf8), js)
            XCTAssertEqual(state.opens, 0)
            XCTAssertEqual(state.writes, 0)
            XCTAssertNil(manager.errorMessage)
        }
    }

    func testUnavailableRecordsCanBeDisabledAndRemovedWithoutLaunchingOrDockChanges() throws {
        try withManager { file, manager, app, state in
            let sourceURL = file.deletingLastPathComponent().appendingPathComponent("original.css")
            try Data("button { color: purple; }".utf8).write(to: sourceURL)
            let unrelatedLibrary = try manager.library.adding(source: ImportedExtensionSource.load(from: sourceURL),
                appKey: "test.unrelated", name: "Keep me", description: "Unrelated source", to: file)
            let unrelated = try XCTUnwrap(unrelatedLibrary.records.last)
            manager.reload()
            let original = try XCTUnwrap(manager.records(for: app).first)
            try FileManager.default.removeItem(at: app.url)
            state.failDock = true

            try manager.disableSavedRecord(original)
            let disabled = try XCTUnwrap(manager.record(original.id))
            XCTAssertFalse(disabled.isEnabled)
            XCTAssertEqual(disabled.sourceText, original.sourceText)
            XCTAssertEqual(manager.record(unrelated.id), unrelated)
            try manager.removeSavedRecord(disabled)

            let saved = try ExtensionLibrary.load(from: file)
            XCTAssertEqual(saved.records, [unrelated])
            XCTAssertEqual(try String(contentsOf: sourceURL, encoding: .utf8), "button { color: purple; }")
            XCTAssertFalse(FileManager.default.fileExists(atPath: file.deletingLastPathComponent().appendingPathComponent("Launchers").path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: file.deletingLastPathComponent().appendingPathComponent("Receipts").path))
            XCTAssertEqual(state.writes, 0)
            XCTAssertEqual(state.opens, 0)
            XCTAssertEqual(state.fallbackAttempts, 0)
            XCTAssertNil(manager.errorMessage)
        }
    }

    func testSavedRecordActionsRejectStaleSnapshotsAndPreserveOtherChanges() throws {
        try withManager { file, manager, app, state in
            let stale = try XCTUnwrap(manager.records(for: app).first)
            try FileManager.default.removeItem(at: app.url)
            try editRecord(in: file) { $0["sourceText"] = "button { color: orange; }" }
            let changed = try Data(contentsOf: file)

            XCTAssertThrowsError(try manager.disableSavedRecord(stale))
            XCTAssertThrowsError(try manager.removeSavedRecord(stale))

            XCTAssertEqual(try Data(contentsOf: file), changed)
            XCTAssertEqual(state.writes, 0)
            XCTAssertEqual(state.opens, 0)
        }
    }

    func testSavedRecordRecoveryDoesNotOverwriteCorruptLibrary() throws {
        try withManager { file, manager, _, state in
            let original = try XCTUnwrap(manager.library.records.first)
            let corrupt = Data("{corrupt".utf8)
            try corrupt.write(to: file)
            manager.reload()

            XCTAssertThrowsError(try manager.disableSavedRecord(original))
            XCTAssertThrowsError(try manager.removeSavedRecord(original))

            XCTAssertEqual(try Data(contentsOf: file), corrupt)
            XCTAssertEqual(state.writes, 0)
            XCTAssertEqual(state.opens, 0)
        }
    }
}
