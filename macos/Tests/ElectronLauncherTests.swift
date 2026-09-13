import Foundation
import XCTest
@testable import ExtensionsAnywhere

@MainActor
final class ElectronLauncherTests: XCTestCase {
    @MainActor
    private final class DockState {
        var pins: [DockShortcutEngine.Tile] = []
        var writes = 0
        var refreshes = 0
        var opened: [URL] = []
        var preferences: DockPreferencesAccess {
            DockPreferencesAccess(read: { self.pins }, write: { pins in
                self.pins = pins; self.writes += 1
            }, refresh: {})
        }
    }

    private func withDirectory(_ body: (URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ElectronLauncherTests-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root)
    }

    private func makeApp(in root: URL, name: String = "Example", identifier: String = "test.example", electron: Bool = true) throws -> InstalledApp {
        let url = root.appendingPathComponent("Applications/\(name).app")
        let contents = url.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at: contents.appendingPathComponent("Resources"), withIntermediateDirectories: true)
        let info = ["CFBundleIdentifier": identifier, "CFBundleName": name, "CFBundleExecutable": name, "CFBundlePackageType": "APPL"]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
        try Data("Original app content".utf8).write(to: contents.appendingPathComponent("Resources/marker.txt"))
        if electron {
            try FileManager.default.createDirectory(at: contents.appendingPathComponent("Frameworks/Electron Framework.framework"), withIntermediateDirectories: true)
        }
        return try XCTUnwrap(ElectronAppDiscovery.scan(in: url.deletingLastPathComponent()).first {
            $0.url.path == url.standardizedFileURL.resolvingSymlinksInPath().path
        })
    }

    private func launcher(in root: URL, state: DockState) -> ElectronLauncher {
        ElectronLauncher(supportDirectory: root.appendingPathComponent("Support/Launchers"),
                         dock: DockShortcutManager(receiptDirectory: root.appendingPathComponent("Support/Receipts"), preferences: state.preferences),
                         refreshDock: { state.refreshes += 1 }, openURL: { state.opened.append($0); return true })
    }

    private func resolved(_ alias: URL) throws -> URL {
        try URL(resolvingAliasFileAt: alias, options: [.withoutUI, .withoutMounting])
            .standardizedFileURL.resolvingSymlinksInPath()
    }

    func testGenericPreparationCreatesOnlyRealAliasWithoutRuntimeResourcesOrTargetChanges() throws {
        try withDirectory { root in
            let app = try makeApp(in: root)
            let state = DockState(), launcher = launcher(in: root, state: state)
            let info = app.url.appendingPathComponent("Contents/Info.plist")
            let marker = app.url.appendingPathComponent("Contents/Resources/marker.txt")
            let originalInfo = try Data(contentsOf: info), originalMarker = try Data(contentsOf: marker)
            let js = ExtensionRecord(id: UUID(), appKey: app.bundleIdentifier!, name: "Stored JS", description: "Storage only",
                                     sourceFileName: "main.js", sourceType: .js, sourceText: "console.log('stored only')",
                                     isEnabled: true, createdAt: Date(), manifestVersion: nil, sourceFiles: nil)
            // Neither the library nor runtime resources need to exist for an ordinary alias.
            try launcher.prepare(app: app, libraryURL: root.appendingPathComponent("Missing/library.json"), records: [js])
            let alias = launcher.shortcut(for: app)
            XCTAssertEqual(try alias.resourceValues(forKeys: [.isAliasFileKey]).isAliasFile, true)
            XCTAssertEqual(try resolved(alias), app.url)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: launcher.directory(for: app).path), [alias.lastPathComponent])
            XCTAssertEqual(try Data(contentsOf: info), originalInfo)
            XCTAssertEqual(try Data(contentsOf: marker), originalMarker)
            XCTAssertEqual(state.writes, 0)
            XCTAssertTrue(state.opened.isEmpty)
            XCTAssertFalse(ElectronLaunchProfile.supports(app))
        }
    }

    func testChatGPTIdentityAtAnotherPathKeepsOrdinaryAliasAndOpenUsesIt() throws {
        try withDirectory { root in
            let app = try makeApp(in: root, name: "ChatGPT", identifier: "com.openai.codex", electron: false)
            let state = DockState(), launcher = launcher(in: root, state: state)
            try launcher.prepare(app: app, libraryURL: root.appendingPathComponent("Missing.json"), records: [])
            try launcher.open(app: app)
            XCTAssertEqual(state.opened, [launcher.shortcut(for: app)])
            XCTAssertEqual(try resolved(launcher.shortcut(for: app)), app.url)
            XCTAssertFalse(ElectronLaunchProfile.supports(app))
            XCTAssertTrue(launcher.status(app: app).contains("isn’t implemented yet"))
            XCTAssertEqual(state.writes, 0)
        }
    }

    func testRepeatedPreparationDoesNotRewriteExistingAlias() throws {
        try withDirectory { root in
            let app = try makeApp(in: root)
            let state = DockState(), launcher = launcher(in: root, state: state)
            try launcher.prepare(app: app, libraryURL: root.appendingPathComponent("Missing.json"), records: [])
            let alias = launcher.shortcut(for: app)
            let original = try Data(contentsOf: alias)
            let attributes = try FileManager.default.attributesOfItem(atPath: alias.path)
            try launcher.prepare(app: app, libraryURL: root.appendingPathComponent("Missing.json"), records: [])
            XCTAssertEqual(try Data(contentsOf: alias), original)
            XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: alias.path)[.modificationDate] as? Date,
                           attributes[.modificationDate] as? Date)
        }
    }

    func testChangedTargetAliasIsRejectedAndPreservedForPrepareOpenAndInstall() throws {
        try withDirectory { root in
            let app = try makeApp(in: root)
            let other = try makeApp(in: root, name: "Other", identifier: "test.other")
            let state = DockState(), launcher = launcher(in: root, state: state)
            let alias = launcher.shortcut(for: app)
            try FileManager.default.createDirectory(at: alias.deletingLastPathComponent(), withIntermediateDirectories: true)
            let bookmark = try other.url.bookmarkData(options: .suitableForBookmarkFile, includingResourceValuesForKeys: nil, relativeTo: nil)
            try URL.writeBookmarkData(bookmark, to: alias)
            let original = try Data(contentsOf: alias)
            XCTAssertThrowsError(try launcher.prepare(app: app, libraryURL: root.appendingPathComponent("Missing.json"), records: []))
            XCTAssertThrowsError(try launcher.open(app: app))
            XCTAssertThrowsError(try launcher.installShortcut(app: app))
            XCTAssertEqual(try Data(contentsOf: alias), original)
            XCTAssertEqual(try resolved(alias), other.url)
            XCTAssertTrue(state.opened.isEmpty)
            XCTAssertEqual(state.writes, 0)
        }
    }

    func testChangedInstalledIdentifierAndForgedSelectionAreRejectedBeforeWriting() throws {
        try withDirectory { root in
            let app = try makeApp(in: root)
            let state = DockState(), launcher = launcher(in: root, state: state)
            let forged = InstalledApp(id: app.id, name: "Different Name", bundleIdentifier: app.bundleIdentifier, url: app.url)
            XCTAssertThrowsError(try launcher.prepare(app: forged, libraryURL: root.appendingPathComponent("Missing.json"), records: []))
            let infoURL = app.url.appendingPathComponent("Contents/Info.plist")
            var info = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: infoURL), options: [], format: nil) as? [String: Any])
            info["CFBundleIdentifier"] = "test.replaced"
            try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: infoURL)
            XCTAssertThrowsError(try launcher.prepare(app: app, libraryURL: root.appendingPathComponent("Missing.json"), records: []))
            XCTAssertThrowsError(try launcher.open(app: app))
            XCTAssertThrowsError(try launcher.installShortcut(app: app))
            XCTAssertFalse(FileManager.default.fileExists(atPath: launcher.directory(for: app).path))
            XCTAssertTrue(state.opened.isEmpty)
            XCTAssertEqual(state.writes, 0)
        }
    }

    func testExplicitDockInstallWithoutEnabledExtensionsIsIdempotentAndDisableRestores() throws {
        try withDirectory { root in
            let app = try makeApp(in: root)
            let state = DockState(), launcher = launcher(in: root, state: state)
            try launcher.prepare(app: app, libraryURL: root.appendingPathComponent("Missing.json"), records: [])
            XCTAssertEqual(try launcher.installShortcut(app: app), .added)
            XCTAssertEqual(try launcher.installShortcut(app: app), .alreadyReplaced)
            XCTAssertEqual(state.pins.count, 1)
            XCTAssertEqual(try DockShortcutEngine.appURL(state.pins[0]), launcher.shortcut(for: app))
            XCTAssertEqual(state.refreshes, 1)
            XCTAssertEqual(try launcher.reconcile(app: app, hasEnabledExtensions: false), .removed)
            XCTAssertTrue(state.pins.isEmpty)
            XCTAssertEqual(state.refreshes, 2)
            XCTAssertEqual(try launcher.reconcile(app: app, hasEnabledExtensions: false), .notPinned)
            XCTAssertEqual(state.refreshes, 2)
        }
    }

    func testEnabledReconcileUsesOrdinaryAliasAndPreservesUnrelatedDockChangesOnDisable() throws {
        try withDirectory { root in
            let app = try makeApp(in: root)
            let state = DockState(), launcher = launcher(in: root, state: state)
            XCTAssertEqual(try launcher.reconcile(app: app, hasEnabledExtensions: true), .added)
            XCTAssertEqual(try resolved(launcher.shortcut(for: app)), app.url)
            let unrelated: DockShortcutEngine.Tile = ["tile-type": "spacer-tile", "custom": "preserved"]
            state.pins.insert(unrelated, at: 0)
            XCTAssertEqual(try launcher.reconcile(app: app, hasEnabledExtensions: false), .removed)
            XCTAssertTrue(DockShortcutEngine.equal(state.pins, [unrelated]))
            XCTAssertTrue(state.opened.isEmpty)
        }
    }

    func testRuntimeAliasMigrationPreservesPathDockReceiptAndOriginalApp() throws {
        try withDirectory { root in
            let original = try makeApp(in: root, name: "ChatGPT", identifier: "com.openai.codex", electron: false)
            let helper = try makeApp(in: root, name: "Generated Helper", identifier: "test.generated.helper")
            let state = DockState(), launcher = launcher(in: root, state: state)
            XCTAssertEqual(try launcher.installShortcut(app: original), .added)
            let alias = launcher.shortcut(for: original)
            let oldAlias = try Data(contentsOf: alias)
            let originalInfo = try Data(contentsOf: original.url.appendingPathComponent("Contents/Info.plist"))
            let pins = try PropertyListSerialization.data(fromPropertyList: state.pins, format: .binary, options: 0)
            let receipts = root.appendingPathComponent("Support/Receipts")
            let receipt = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: receipts, includingPropertiesForKeys: nil).first)
            let receiptBytes = try Data(contentsOf: receipt)
            let backup = try XCTUnwrap(RuntimeLauncherAlias.prepare(at: alias, target: helper.url, allowedPreviousTarget: original.url))
            XCTAssertEqual(try resolved(alias).path, helper.url.path)
            XCTAssertEqual(try resolved(backup).path, original.url.path)
            XCTAssertEqual(try Data(contentsOf: backup), oldAlias)
            XCTAssertEqual(try Data(contentsOf: original.url.appendingPathComponent("Contents/Info.plist")), originalInfo)
            XCTAssertEqual(try Data(contentsOf: receipt), receiptBytes)
            XCTAssertEqual(try PropertyListSerialization.data(fromPropertyList: state.pins, format: .binary, options: 0), pins)
            let migrated = try Data(contentsOf: alias)
            XCTAssertNil(try RuntimeLauncherAlias.prepare(at: alias, target: helper.url, allowedPreviousTarget: original.url))
            XCTAssertEqual(try Data(contentsOf: alias), migrated)
            let dock = DockShortcutManager(receiptDirectory: receipts, preferences: state.preferences)
            XCTAssertTrue(try dock.isReplaced(target: original.url))
            XCTAssertTrue(state.opened.isEmpty)
        }
    }

    func testRuntimeAliasMigrationRejectsUnexpectedTargetAndNonAlias() throws {
        try withDirectory { root in
            let original = try makeApp(in: root)
            let unexpected = try makeApp(in: root, name: "Unexpected", identifier: "test.unexpected")
            let helper = try makeApp(in: root, name: "Generated Helper", identifier: "test.helper")
            let folder = root.appendingPathComponent("Support/Aliases")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let alias = folder.appendingPathComponent("Example.app")
            let data = try unexpected.url.bookmarkData(options: .suitableForBookmarkFile, includingResourceValuesForKeys: nil, relativeTo: nil)
            try URL.writeBookmarkData(data, to: alias)
            let originalAlias = try Data(contentsOf: alias)
            XCTAssertThrowsError(try RuntimeLauncherAlias.prepare(at: alias, target: helper.url, allowedPreviousTarget: original.url))
            XCTAssertEqual(try Data(contentsOf: alias), originalAlias)
            XCTAssertEqual(try resolved(alias).path, unexpected.url.path)
            try FileManager.default.removeItem(at: alias)
            try Data("Not an alias".utf8).write(to: alias)
            XCTAssertThrowsError(try RuntimeLauncherAlias.prepare(at: alias, target: helper.url, allowedPreviousTarget: original.url))
            XCTAssertEqual(try String(contentsOf: alias, encoding: .utf8), "Not an alias")
        }
    }

    func testChatGPTProfileDoesNotClaimAnActiveConnectionWithoutSessionEvidence() throws {
        try withDirectory { root in
            let state = DockState(), launcher = launcher(in: root, state: state)
            let app = InstalledApp(id: ElectronLaunchProfile.chatgptURL.path, name: "ChatGPT",
                                   bundleIdentifier: ElectronLaunchProfile.chatgptKey, url: ElectronLaunchProfile.chatgptURL)
            let status = launcher.status(app: app)
            XCTAssertTrue(status.contains("not active"))
            XCTAssertTrue(status.contains("Quit ChatGPT normally"))
            XCTAssertFalse(status.contains("Connected."))
            XCTAssertTrue(state.opened.isEmpty)
        }
    }
}
