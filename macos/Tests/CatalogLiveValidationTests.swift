import AppKit
import Foundation
import RuntimeCatalog
import XCTest
@testable import ExtensionsAnywhere

/// Opt-in adapter for one supervised action through the production manager.
/// Default test runs skip before reading live library, app, or Dock state.
@MainActor
final class CatalogLiveValidationTests: XCTestCase {
    private enum Action: String { case add, open, disable, enable, remove, inspect; case prepareVoice = "prepare-voice", restoreVoice = "restore-voice" }

    private struct Target {
        let slug: String
        let bundleURL: URL
        let bundleIdentifier: String
        let selector: String
        var marker: String { "Extensions Anywhere E2E — \(slug)" }
        var proofKind: String { slug == "chatgpt" ? "hidden-sidebar-voice" : "green-control" }
        var css: String {
            if slug == "chatgpt" { return "\(selector) { display: none !important; }\n" }
            return "\(selector) { background-color: #16a34a !important; color: #ffffff !important; background-image: none !important; }\n"
        }
    }

    func testOptInCatalogAction() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let rawAction = environment["EA_E2E_ACTION"], !rawAction.isEmpty,
              let slug = environment["EA_E2E_APP"], !slug.isEmpty else {
            throw XCTSkip("Set EA_E2E_ACTION and EA_E2E_APP explicitly for one supervised live action.")
        }
        let output = try outputURL(environment["EA_E2E_OUTPUT"])
        let startedAt = Date()
        var result: [String: Any] = [
            "schemaVersion": 1, "action": rawAction, "slug": slug,
            "startedAt": iso(startedAt), "passed": false,
            "scope": "Explicit opt-in test adapter using the production manager and live library. An action result is not CSS, prompt, menu, or signing E2E acceptance."
        ]
        var operationError: Error?
        do {
            guard let action = Action(rawValue: rawAction) else { throw failure("Unknown E2E action.") }
            let target = try target(for: slug)
            let app = try installedApp(for: target)
            let resources = repositoryRoot.appendingPathComponent("dist/Extensions Anywhere.app/Contents/Resources", isDirectory: true)
            let launcher = ElectronLauncher(
                supportDirectory: ElectronLauncher.supportDirectory, dock: DockShortcutManager(),
                refreshDock: DockShortcutManager.restartDock,
                openURL: { NSWorkspace.shared.open($0) }, runtimeResources: resources
            )
            let manager = ExtensionManager(launcher: launcher)
            manager.reload()
            guard !manager.loadFailed else { throw failure(manager.errorMessage ?? "The live extension library could not be read.") }
            let before = manager.library.records
            result["before"] = observation(app: app, manager: manager)
            result["app"] = ["bundlePath": app.url.path, "bundleIdentifier": target.bundleIdentifier,
                             "name": app.name, "selector": target.selector, "recordMarker": target.marker,
                             "proofKind": target.proofKind,
                             "version": Bundle(url: app.url)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown",
                             "build": Bundle(url: app.url)?.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "Unknown"]
            var ownedID: UUID?
            var preserveBefore = before
            do {
                switch action {
                case .prepareVoice, .restoreVoice:
                    guard slug == "chatgpt", environment["EA_E2E_RECORD_ID"] == ChatGPTVoicePreferenceProof.hideID.uuidString else {
                        throw failure("Voice preparation is limited to the exact original ChatGPT record.")
                    }
                    let snapshotURL = output.deletingLastPathComponent().appendingPathComponent("original-library.json")
                    let values = try snapshotURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
                    guard snapshotURL.standardizedFileURL.resolvingSymlinksInPath().path == snapshotURL.path,
                          values.isRegularFile == true, values.isSymbolicLink != true,
                          let bytes = values.fileSize, bytes <= 64 * 1024 * 1024 else { throw failure("Use a contained regular original-library snapshot.") }
                    let snapshot = try ExtensionLibrary.load(from: snapshotURL)
                    let change = try ChatGPTVoicePreferenceProof.change(records: before, snapshot: snapshot.records, restoring: action == .restoreVoice)
                    ownedID = change.record.id
                    preserveBefore = before.filter { $0.id != change.record.id }
                    if change.record.isEnabled != change.enabled { manager.setEnabled(change.enabled, record: change.record, app: app) }
                case .add:
                    guard environment["EA_E2E_RECORD_ID"]?.isEmpty != false else {
                        throw failure("Add generates a fresh record ID; omit EA_E2E_RECORD_ID.")
                    }
                    guard before.filter({ $0.name == target.marker && $0.appKey == target.bundleIdentifier }).isEmpty else {
                        throw failure("This app already has an E2E marker record. Reuse its exact ID or remove it before adding another.")
                    }
                    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ExtensionsAnywhereE2E-\(UUID().uuidString)", isDirectory: true)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    defer { try? FileManager.default.removeItem(at: folder) }
                    let manifest = ExtensionManifest(name: target.marker,
                        description: "Owned E2E validation record. Fixed cosmetic CSS on one known control.",
                        version: "1.0.0", css: ["e2e.css"])
                    let file = folder.appendingPathComponent("manifest.json")
                    try JSONEncoder().encode(manifest).write(to: file)
                    try Data(target.css.utf8).write(to: folder.appendingPathComponent("e2e.css"))
                    try manager.add(package: ImportedExtensionPackage.load(from: file), app: app)
                    let oldIDs = Set(before.map(\.id))
                    let added = manager.library.records.filter { !oldIDs.contains($0.id) }
                    guard added.count == 1 else { throw failure("Add did not create exactly one new record.") }
                    ownedID = added[0].id
                    _ = try ownedRecord(id: added[0].id, target: target, in: manager.library.records)
                    guard added[0].isEnabled else { throw failure("The newly imported E2E record is not enabled.") }
                case .open, .disable, .enable, .remove:
                    guard let rawID = environment["EA_E2E_RECORD_ID"], let id = UUID(uuidString: rawID) else {
                        throw failure("This action requires EA_E2E_RECORD_ID from the add result.")
                    }
                    let record = try ownedRecord(id: id, target: target, in: before)
                    ownedID = id
                    if action != .open { preserveBefore = before.filter { $0.id != id } }
                    switch action {
                    case .open: manager.open(app)
                    case .disable: manager.setEnabled(false, record: record, app: app)
                    case .enable: manager.setEnabled(true, record: record, app: app)
                    case .remove: try manager.remove(record, app: app)
                    default: break
                    }
                case .inspect:
                    if let rawID = environment["EA_E2E_RECORD_ID"], !rawID.isEmpty {
                        guard let id = UUID(uuidString: rawID) else { throw failure("EA_E2E_RECORD_ID is not a UUID.") }
                        _ = try ownedRecord(id: id, target: target, in: before)
                        ownedID = id
                    }
                }
                let reportedError = manager.errorMessage
                manager.reload()
                guard !manager.loadFailed else { throw failure("The live library could not be re-read after the action.") }
                let after = manager.library.records
                let preservedAfter = action == .add || [.disable, .enable, .remove, .prepareVoice, .restoreVoice].contains(action)
                    ? after.filter { $0.id != ownedID } : after
                guard preservedAfter == preserveBefore else {
                    throw failure("An unrelated record or its ordering changed. No broad rollback was attempted.")
                }
                result["unrelatedRecordsPreserved"] = true
                if let ownedID {
                    result["recordID"] = ownedID.uuidString
                    if action == .prepareVoice || action == .restoreVoice {
                        let snapshot = try ExtensionLibrary.load(from: output.deletingLastPathComponent().appendingPathComponent("original-library.json"))
                        guard var expected = snapshot.records.first(where: { $0.id == ownedID }) else { throw failure("Original Voice snapshot missing.") }
                        expected.isEnabled = action == .restoreVoice
                        guard after.filter({ $0.id == ownedID }) == [expected] else { throw failure("Voice preference did not match the exact expected record.") }
                        result["recordEnabled"] = expected.isEnabled
                        result["originalVoiceRestored"] = action == .restoreVoice
                    } else if action == .remove {
                        guard !after.contains(where: { $0.id == ownedID }) else { throw failure("The owned record remains after removal.") }
                    } else {
                        let current = try ownedRecord(id: ownedID, target: target, in: after)
                        if action == .enable || action == .disable {
                            guard let original = before.first(where: { $0.id == ownedID }) else { throw failure("The original E2E record disappeared.") }
                            var expected = original
                            expected.isEnabled = action == .enable
                            guard current == expected else { throw failure("The E2E toggle changed fields other than its enabled state.") }
                        }
                        result["recordEnabled"] = current.isEnabled
                    }
                }
                if let reportedError { throw failure(reportedError) }
                result["passed"] = true
            } catch {
                // Preserve the generated ID if a post-save Dock operation failed,
                // so the supervisor can inspect/remove that exact owned record.
                manager.reload()
                if ownedID == nil && action == .add {
                    let oldIDs = Set(before.map(\.id))
                    let added = manager.library.records.filter {
                        !oldIDs.contains($0.id) && $0.appKey == target.bundleIdentifier && $0.name == target.marker
                    }
                    if added.count == 1 { ownedID = added[0].id }
                }
                if let ownedID { result["recordID"] = ownedID.uuidString }
                operationError = error
            }
            result["after"] = observation(app: app, manager: manager)
        } catch { operationError = error }
        if let operationError { result["error"] = operationError.localizedDescription }
        result["finishedAt"] = iso(Date())
        let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        try (data + Data([0x0a])).write(to: output, options: .withoutOverwriting)
        if let operationError { throw operationError }
    }

    private var repositoryRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    private func target(for slug: String) throws -> Target {
        if slug == "stylelab" {
            return Target(slug: slug, bundleURL: ElectronLaunchProfile.fixtureURL,
                          bundleIdentifier: ElectronLaunchProfile.fixtureKey, selector: "#signal-button")
        }
        if slug == "chatgpt" {
            return Target(slug: slug, bundleURL: ElectronLaunchProfile.chatgptURL,
                          bundleIdentifier: ElectronLaunchProfile.chatgptKey,
                          selector: ".h-toolbar button[aria-label=\"Start new voice chat\"]")
        }
        guard let definition = RuntimeAppCatalog.entries.first(where: { $0.slug == slug }) else {
            throw failure("The app is not in the fixed ordinary runtime catalog.")
        }
        return Target(slug: slug, bundleURL: URL(fileURLWithPath: definition.bundlePath),
                      bundleIdentifier: definition.bundleIdentifier, selector: definition.target.selector)
    }

    private func installedApp(for target: Target) throws -> InstalledApp {
        guard let app = try ElectronAppDiscovery.scan().first(where: {
            $0.url.path == target.bundleURL.path && $0.bundleIdentifier == target.bundleIdentifier
        }), ElectronLaunchProfile.supports(app) else {
            throw failure("The exact catalog app is not installed or lacks its expected runtime profile.")
        }
        return app
    }

    private func ownedRecord(id: UUID, target: Target, in records: [ExtensionRecord]) throws -> ExtensionRecord {
        let marked = records.filter { $0.appKey == target.bundleIdentifier && $0.name == target.marker }
        guard marked.count == 1, let record = marked.first, record.id == id,
              record.sourceType == .css, record.sourceFileName == "e2e.css",
              record.sourceFiles?.count == 1,
              record.sourceFiles?.first?.type == .css else {
            throw failure("The requested ID does not uniquely identify this app's owned E2E CSS record.")
        }
        return record
    }

    private func observation(app: InstalledApp, manager: ExtensionManager) -> [String: Any] {
        let profile = ElectronLaunchProfile.profile(for: app)
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: app.bundleIdentifier ?? "").filter {
            !$0.isTerminated && $0.bundleURL?.standardizedFileURL.resolvingSymlinksInPath().path == app.url.path
        }
        var result: [String: Any] = [
            "recordIDs": manager.library.records.map { $0.id.uuidString },
            "recordCount": manager.library.records.count,
            "appRecordIDs": manager.records(for: app).map { $0.id.uuidString },
            "enabledAppRecordIDs": manager.records(for: app).filter(\.isEnabled).map { $0.id.uuidString },
            "profile": nullable(profile?.rawValue),
            "libraryPath": manager.storageFileURL.path,
            "shortcutPath": manager.launcher.shortcut(for: app).path,
            "launcherDirectory": manager.launcher.directory(for: app).path,
            "status": manager.launcher.status(app: app),
            "running": running.map { process -> [String: Any] in
                let start = RunningApplicationIdentity.startDate(of: process)
                return ["pid": process.processIdentifier,
                        "kernelStartDate": nullable(start.map { iso($0) }),
                        "kernelStartEpoch": nullable(start.map { String(format: "%.6f", $0.timeIntervalSince1970) })]
            }
        ]
        if let snapshot = manager.launcher.runtimeSession(app: app) {
            result["runtime"] = [
                "phase": snapshot.phase.rawValue, "healthy": snapshot.isHealthy,
                "starting": snapshot.isStarting, "pid": nullable(snapshot.pid),
                "brokerPid": snapshot.brokerPid, "updatedAt": iso(snapshot.updatedAt),
                "processStartedAt": nullable(snapshot.processStartedAt.map { iso($0) }),
                "sessionDirectory": snapshot.sessionDirectory.path
            ]
        } else { result["runtime"] = NSNull() }
        if let message = manager.errorMessage { result["managerError"] = message }
        if let notice = manager.dockNotice[app.id] { result["dockNotice"] = notice }
        return result
    }

    private func outputURL(_ raw: String?) throws -> URL {
        guard let raw, (raw as NSString).isAbsolutePath,
              !raw.contains(where: { $0.isNewline || $0 == "\0" }) else {
            throw failure("EA_E2E_OUTPUT must be an absolute path to a new JSON evidence file.")
        }
        let url = URL(fileURLWithPath: raw).standardizedFileURL.resolvingSymlinksInPath()
        guard url.pathExtension.lowercased() == "json",
              !url.pathComponents.contains(where: { $0.lowercased().hasSuffix(".app") }),
              url.path != ExtensionLibrary.defaultURL.standardizedFileURL.resolvingSymlinksInPath().path,
              !FileManager.default.fileExists(atPath: url.path) else {
            throw failure("Use a new JSON evidence file outside app bundles and the live library.")
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        return url
    }

    private func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
    private func nullable<T>(_ value: T?) -> Any { value.map { $0 as Any } ?? NSNull() }
    private func failure(_ message: String) -> NSError {
        NSError(domain: "ExtensionsAnywhere.CatalogLiveValidation", code: 1,
                userInfo: [NSLocalizedDescriptionKey: message])
    }
}

/// Test-adapter policy only: compare the complete saved record before changing
/// its enabled preference. Never restore a whole library over current records.
enum ChatGPTVoicePreferenceProof {
    static let hideID = UUID(uuidString: "8C12BB85-B94C-4FDE-8517-16A0470A6FAD")!
    static let originalIDs: Set<UUID> = [hideID,
        UUID(uuidString: "B670E42B-83D6-4C04-82FC-26B45043F03A")!,
        UUID(uuidString: "0215A2E4-50D5-4FB3-8645-E7692DB3B9C2")!]

    static func change(records: [ExtensionRecord], snapshot: [ExtensionRecord], restoring: Bool) throws -> (record: ExtensionRecord, enabled: Bool) {
        let error = NSError(domain: "ExtensionsAnywhere.VoiceProof", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "The original Voice record changed or the three-record snapshot is invalid. No preference was overwritten."])
        guard snapshot.count == 3, Set(snapshot.map(\.id)) == originalIDs,
              let original = snapshot.first(where: { $0.id == hideID }),
              original.appKey == "com.openai.codex", original.name == "Hide Sidebar Voice Button",
              original.sourceType == .css, original.isEnabled,
              records.filter({ $0.id == hideID }).count == 1,
              let current = records.first(where: { $0.id == hideID }) else { throw error }
        var disabled = original; disabled.isEnabled = false
        if restoring {
            guard current == disabled || current == original else { throw error }
            return (current, original.isEnabled)
        }
        guard records == snapshot, current == original else { throw error }
        return (current, false)
    }
}

final class ChatGPTVoicePreferenceProofTests: XCTestCase {
    private func snapshot() -> [ExtensionRecord] {
        ChatGPTVoicePreferenceProof.originalIDs.sorted { $0.uuidString < $1.uuidString }.map { id in
            ExtensionRecord(id: id, appKey: id == ChatGPTVoicePreferenceProof.hideID ? "com.openai.codex" : "test.other",
                name: id == ChatGPTVoicePreferenceProof.hideID ? "Hide Sidebar Voice Button" : "Other original",
                description: "Original metadata", sourceFileName: "styles.css", sourceType: .css,
                sourceText: "button { display: none; }", isEnabled: true, createdAt: Date(timeIntervalSince1970: 1))
        }
    }

    func testPrepareAndRestoreChangeOnlyExactSavedEnabledPreference() throws {
        let original = snapshot()
        let change = try ChatGPTVoicePreferenceProof.change(records: original, snapshot: original, restoring: false)
        XCTAssertEqual(change.record.id, ChatGPTVoicePreferenceProof.hideID); XCTAssertFalse(change.enabled)
        var disabled = original
        disabled[disabled.firstIndex(where: { $0.id == change.record.id })!].isEnabled = false
        let restored = try ChatGPTVoicePreferenceProof.change(records: disabled, snapshot: original, restoring: true)
        XCTAssertTrue(restored.enabled)
        XCTAssertTrue(try ChatGPTVoicePreferenceProof.change(records: original, snapshot: original, restoring: true).enabled)
    }

    func testRestoreRejectsEditedOrMissingRecordButPreservesUnrelatedChanges() throws {
        let original = snapshot(); let index = original.firstIndex { $0.id == ChatGPTVoicePreferenceProof.hideID }!
        var current = original; current[index].isEnabled = false; current[index].manifestVersion = "user edit"
        XCTAssertThrowsError(try ChatGPTVoicePreferenceProof.change(records: current, snapshot: original, restoring: true))
        XCTAssertThrowsError(try ChatGPTVoicePreferenceProof.change(records: original.filter { $0.id != ChatGPTVoicePreferenceProof.hideID }, snapshot: original, restoring: true))
        XCTAssertThrowsError(try ChatGPTVoicePreferenceProof.change(records: original + [original[index]], snapshot: original, restoring: true))
        current = original; current[index].isEnabled = false
        let other = current.indices.first { $0 != index }!; current[other].manifestVersion = "unrelated user edit"
        XCTAssertTrue(try ChatGPTVoicePreferenceProof.change(records: current, snapshot: original, restoring: true).enabled)
        XCTAssertThrowsError(try ChatGPTVoicePreferenceProof.change(records: current, snapshot: original, restoring: false))
    }
}
