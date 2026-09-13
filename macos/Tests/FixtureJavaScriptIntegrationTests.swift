import AppKit
import CryptoKit
import Foundation
import RuntimeCatalog
import XCTest
@testable import ExtensionsAnywhere

/// Real manager → generated helper → packaged broker → owned renderer proof.
/// Ordinary unit-test runs skip before touching installed apps or any library.
@MainActor
final class FixtureJavaScriptIntegrationTests: XCTestCase {
    private var probeNumber = 0
    private var checks: [String] = []
    private var report: [String: Any] = [:]
    private let fixtureID = "dev.extensionsanywhere.stylelab"
    private let helperID = "dev.extensionsanywhere.launcher.stylelab"

    private var repository: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    private final class MemoryDock {
        var pins: [DockShortcutEngine.Tile] = []
        var writes = 0
        var refreshes = 0
        var opened: [URL] = []
        var installerRequests = 0
    }

    func testOptInNativeImportedFixturePackageLifecycle() async throws {
        guard ProcessInfo.processInfo.environment["EA_RUN_NATIVE_FIXTURE_PACKAGE_E2E"] == "1" else {
            throw XCTSkip("Set EA_RUN_NATIVE_FIXTURE_PACKAGE_E2E=1 explicitly for the isolated owned Style Lab product proof.")
        }
        guard NSRunningApplication.runningApplications(withBundleIdentifier: fixtureID).isEmpty,
              NSRunningApplication.runningApplications(withBundleIdentifier: helperID).isEmpty else {
            throw failure("Style Lab or its launcher is already running. This proof will not quit an existing instance.")
        }
        let app = try XCTUnwrap(ElectronAppDiscovery.scan(in: URL(fileURLWithPath: "/Applications"))
            .first { $0.url.path == "/Applications/Style Lab.app" && $0.bundleIdentifier == fixtureID })
        let packagedManager = repository.appendingPathComponent("dist/Extensions Anywhere.app")
        let resources = packagedManager.appendingPathComponent("Contents/Resources")
        let node = resources.appendingPathComponent("Runtime/native/node")
        let proof = repository.appendingPathComponent("output/release-review/2026-09-13/native-fixture-package-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: proof, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let live = try prepareLiveDirectory(proof: proof, appKey: fixtureID)
        let reportURL = proof.appendingPathComponent("native-report.json")
        print("Native fixture package evidence: \(reportURL.path)")
        report = ["schema": 1, "passed": false, "startedAt": timestamp(),
                  "scope": "Explicit owned installed Style Lab only; real manager/helper/broker with an isolated library and in-memory Dock. No third-party coverage or GUI-interaction claim.",
                  "managerBundle": packagedManager.path, "fixtureBundle": app.url.path,
                  "library": live.appendingPathComponent("library.json").path,
                  "liveArtifactsDirectory": live.path, "artifactsReceipt": proof.appendingPathComponent("live-artifacts-receipt.json").path]
        let dock = MemoryDock()
        let launcher = ElectronLauncher(supportDirectory: live.appendingPathComponent("Launchers"),
            dock: DockShortcutManager(receiptDirectory: live.appendingPathComponent("Receipts"),
                preferences: DockPreferencesAccess(read: { dock.pins }, write: { dock.pins = $0; dock.writes += 1 }, refresh: {})),
            refreshDock: { dock.refreshes += 1 },
            openURL: { url in dock.opened.append(url); return NSWorkspace.shared.open(url) }, runtimeResources: resources)
        let manager = ExtensionManager(storageURL: live.appendingPathComponent("library.json"), launcher: launcher,
            presentDockInstaller: { _, _ in dock.installerRequests += 1; return false })
        let helper = launcher.directory(for: app).appendingPathComponent("Style Lab Launcher.app")
        var session: URL?
        var operationError: Error?
        do {
            _ = try command("/usr/bin/codesign", ["--verify", "--strict", packagedManager.path], proof: proof)
            let info = try jsonPropertyList(packagedManager.appendingPathComponent("Contents/Info.plist"))
            report["managerVersion"] = info["CFBundleShortVersionString"]
            report["managerBuild"] = info["CFBundleVersion"]
            let before = try probe("integrity", node: node, proof: proof)
            report["before"] = before

            let packageFolder = live.appendingPathComponent("Package")
            try FileManager.default.copyItem(at: repository.appendingPathComponent("examples/stylelab-script-button"), to: packageFolder)
            let stylesheet = packageFolder.appendingPathComponent("styles.css")
            let originalCSS = try String(contentsOf: stylesheet, encoding: .utf8)
            // An independent existing control also measures actual CSS unload.
            try (originalCSS + "\n#signal-button { background-color: rgb(22, 163, 74) !important; }\n").write(to: stylesheet, atomically: true, encoding: .utf8)
            let manifestURL = packageFolder.appendingPathComponent("manifest.json")
            let package = try ImportedExtensionPackage.load(from: manifestURL)
            try ExtensionLibrary().save(to: manager.storageFileURL)
            manager.reload()
            try manager.add(package: package, app: app, isEnabled: false)
            var record = try XCTUnwrap(manager.records(for: app).first)
            try require(!record.isEnabled && record.sourceFiles?.map(\.text) == package.sources.map(\.text),
                        "Manifest import preserves mixed source and begins disabled")
            try require(dock.opened.isEmpty && !FileManager.default.fileExists(atPath: helper.path),
                        "Disabled import does not prepare or launch a helper")

            manager.setEnabled(true, record: record, app: app)
            try require(manager.errorMessage == nil, "Enabling the imported package succeeds through the manager")
            record = try XCTUnwrap(manager.record(record.id))
            _ = try command("/usr/bin/codesign", ["--verify", "--strict", helper.path], proof: proof)
            let configuration = try json(launcher.directory(for: app).appendingPathComponent("configuration.json"))
            try require(configuration["libraryPath"] as? String == manager.storageFileURL.path &&
                        configuration["nodePath"] as? String == helper.appendingPathComponent("Contents/Resources/Runtime/native/node").path &&
                        configuration["brokerPath"] as? String == helper.appendingPathComponent("Contents/Resources/Runtime/scripts/dock-fixture-session.mjs").path,
                        "Generated helper uses its sealed runtime and isolated library")
            report["helperRuntimeDigest"] = try RuntimeResourceFiles.digest(in: helper.appendingPathComponent("Contents/Resources/Runtime"))
            report["packageHashes"] = try sourceHashes(in: packageFolder)
            report["initialExtensionID"] = record.id.uuidString
            manager.open(app)
            try require(manager.errorMessage == nil && dock.opened == [launcher.shortcut(for: app)],
                        "Open App dispatches the actual generated alias")
            // Keep the generic poll result nonoptional. Assigning directly to
            // URL? can infer T == URL? and treat a nested nil as completion.
            let directory: URL = try await wait("native session becomes active", timeout: 45) { () throws -> URL? in
                guard let directory = launcher.sessionDirectory(app: app),
                      let status = try? self.json(directory.appendingPathComponent("status.json")) else { return nil }
                if status["phase"] as? String == "error" { throw self.failure(status["error"] as? String ?? "The broker failed.") }
                return status["phase"] as? String == "active" ? directory : nil
            }
            session = directory
            report["session"] = directory.path
            try require(launcher.runtimeSession(app: app)?.isHealthy == true, "Native runtime identity recognizes the owned active session")
            let original = try json(directory.appendingPathComponent("report.json"))["original"] as? [String: Any]
            let baseline = try XCTUnwrap(original?["background"] as? String)
            var observed = try await observation(node: node, proof: proof, session: directory, id: record.id) {
                $0["count"] as? Int == 1 && $0["clickCount"] as? Int == 0 && $0["signalBackground"] as? String == "rgb(22, 163, 74)"
            }
            // The pointer may remain over this location from an earlier proof;
            // both authored normal and hover colors are valid CSS outcomes.
            try require(["rgb(22, 163, 74)", "rgb(21, 128, 61)"].contains(observed["background"] as? String ?? ""),
                        "Real imported CSS and JS create one styled authored button")
            observed = try probe("click", node: node, proof: proof, session: directory, id: record.id)
            try require(observed["clickCount"] as? Int == 1, "Pointer click executes the imported JavaScript handler")
            var events = try await clickLogs(record: record, session: directory, minimum: 1)
            let firstRevision = try XCTUnwrap(events.first?.revision)
            try require(events.count == 1 && events[0].fileName == "main.js" && events[0].level == .log,
                        "Native runtime-log reader receives the selected file's attributed click")

            manager.setEnabled(false, record: record, app: app)
            try require(manager.errorMessage == nil, "Disabling persists through the manager")
            try await waitPhase("disabled", session: directory)
            observed = try probe("observe", node: node, proof: proof, session: directory, id: record.id)
            try require(observed["count"] as? Int == 0 && observed["signalBackground"] as? String == baseline,
                        "Disable removes authored DOM and restores independent CSS baseline")
            record = try XCTUnwrap(manager.record(record.id))
            manager.setEnabled(true, record: record, app: app)
            try require(manager.errorMessage == nil, "Re-enable persists through the manager")
            try await waitPhase("active", session: directory)
            _ = try await observation(node: node, proof: proof, session: directory, id: record.id) {
                $0["count"] as? Int == 1 && $0["clickCount"] as? Int == 0
            }
            observed = try probe("click", node: node, proof: proof, session: directory, id: record.id)
            events = try await clickLogs(record: record, session: directory, minimum: 2)
            try require(observed["clickCount"] as? Int == 1 && events.count == 2,
                        "Re-enable creates fresh state and a single handler")

            // Public product source replacement currently means re-import and
            // remove the old record; no unsupported in-place update is faked.
            try (originalCSS + "\n#signal-button { background-color: rgb(126, 34, 206) !important; }\n").write(to: stylesheet, atomically: true, encoding: .utf8)
            let scriptURL = packageFolder.appendingPathComponent("main.js")
            let script = try String(contentsOf: scriptURL, encoding: .utf8)
            try (script + "\nconsole.info('Style Lab replacement revision ready');\n").write(to: scriptURL, atomically: true, encoding: .utf8)
            let replacementPackage = try ImportedExtensionPackage.load(from: manifestURL)
            try manager.add(package: replacementPackage, app: app, isEnabled: false)
            let oldID = record.id
            let replacement = try XCTUnwrap(manager.records(for: app).first { $0.id != oldID })
            try manager.remove(try XCTUnwrap(manager.record(oldID)), app: app)
            manager.setEnabled(true, record: replacement, app: app)
            try require(manager.errorMessage == nil, "Changed source is re-imported and replaces the old record through manager APIs")
            record = try XCTUnwrap(manager.record(replacement.id))
            _ = try await observation(node: node, proof: proof, session: directory, id: record.id) {
                $0["count"] as? Int == 1 && $0["clickCount"] as? Int == 0 && $0["signalBackground"] as? String == "rgb(126, 34, 206)"
            }
            observed = try probe("observe", node: node, proof: proof, session: directory, id: oldID)
            try require(observed["count"] as? Int == 0, "Source replacement leaves no old extension button")
            _ = try probe("click", node: node, proof: proof, session: directory, id: record.id)
            events = try await clickLogs(record: record, session: directory, minimum: 1)
            try require(events.count == 1 && events[0].revision != firstRevision, "Replacement logs identify the new source revision and record")

            _ = try probe("reload", node: node, proof: proof, session: directory, id: record.id)
            _ = try await observation(node: node, proof: proof, session: directory, id: record.id) {
                $0["count"] as? Int == 1 && $0["clickCount"] as? Int == 0 && $0["signalBackground"] as? String == "rgb(126, 34, 206)"
            }
            observed = try probe("click", node: node, proof: proof, session: directory, id: record.id)
            events = try await clickLogs(record: record, session: directory, minimum: 2)
            try require(observed["clickCount"] as? Int == 1 && events.count == 2 && events[1].sequence > events[0].sequence,
                        "Reload automatically reapplies CSS/JS once and retains monotonic attributed logs")
            report["finalExtensionID"] = record.id.uuidString
            report["clickEvents"] = events.map { ["sequence": $0.sequence, "extensionID": $0.extensionID.uuidString,
                                                  "fileName": $0.fileName, "revision": $0.revision,
                                                  "level": $0.level.rawValue, "message": $0.message] as [String: Any] }
            try manager.remove(record, app: app)
            try await waitPhase("disabled", session: directory)
            observed = try probe("observe", node: node, proof: proof, session: directory, id: record.id)
            try require(manager.library.records.isEmpty && observed["count"] as? Int == 0 && observed["signalBackground"] as? String == baseline,
                        "Removing the final record clears runtime DOM/CSS and the isolated library")
        } catch { operationError = error }

        do {
            try await stopOwnedHelper(at: helper)
            if let session {
                try await waitPhase("stopped", session: session)
                let brokerReport = try json(session.appendingPathComponent("report.json"), limit: 1024 * 1024)
                report["brokerReport"] = brokerReport
                let cleanup = try XCTUnwrap(brokerReport["cleanup"] as? [String: Any])
                try require(cleanup["forcedKill"] as? Bool == false && cleanup["temporaryProfileRemoved"] as? Bool == true &&
                            cleanup["jsCleanupVerified"] as? Bool == true && cleanup["processExited"] as? Bool == true,
                            "Broker completes script cleanup and removes its temporary profile without forced termination")
                let launchArguments = try XCTUnwrap(brokerReport["launchArguments"] as? [String])
                try require(launchArguments.contains { $0.hasPrefix("--user-data-dir=") && $0.contains("extensions-anywhere-") },
                            "Owned launch uses a separate temporary app profile")
            }
            let after = try probe("integrity", node: node, proof: proof)
            report["after"] = after
            if let before = report["before"] as? [String: Any] {
                try require(before["cdhash"] as? String == after["cdhash"] as? String && before["sha256"] as? String == after["sha256"] as? String,
                            "Owned fixture bundle contents and signing remain unchanged")
            }
            try require(NSRunningApplication.runningApplications(withBundleIdentifier: fixtureID).isEmpty,
                        "Normal helper shutdown stops its owned fixture")
        } catch { if operationError == nil { operationError = error } else { report["cleanupError"] = error.localizedDescription } }
        report["checks"] = checks
        report["dock"] = ["backend": "memory-only", "writes": dock.writes, "refreshes": dock.refreshes, "remainingPins": dock.pins.count]
        report["passed"] = operationError == nil
        report["finishedAt"] = timestamp()
        if let operationError { report["error"] = operationError.localizedDescription }
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: reportURL, options: .atomic)
        if let operationError { throw operationError }
    }

    func testOptInNativeVSCodePackageLifecycle() async throws {
        guard ProcessInfo.processInfo.environment["EA_RUN_NATIVE_VSCODE_PACKAGE_E2E"] == "1" else {
            throw XCTSkip("Set EA_RUN_NATIVE_VSCODE_PACKAGE_E2E=1 explicitly for the fixed VS Code product proof.")
        }
        guard ProcessInfo.processInfo.environment["EA_NATIVE_PROOF_MANUAL_RELOAD"] == "1" else {
            throw XCTSkip("VS Code proof requires EA_NATIVE_PROOF_MANUAL_RELOAD=1 and its native Developer: Reload Window checkpoint to preserve restored work.")
        }
        let appKey = "com.microsoft.VSCode", launcherID = "dev.extensionsanywhere.launcher.vscode"
        guard NSRunningApplication.runningApplications(withBundleIdentifier: appKey).isEmpty,
              NSRunningApplication.runningApplications(withBundleIdentifier: launcherID).isEmpty else {
            throw failure("VS Code or its launcher is already running. No existing process will be quit.")
        }
        let app = try XCTUnwrap(ElectronAppDiscovery.scan(in: URL(fileURLWithPath: "/Applications"))
            .first { $0.url.path == "/Applications/Visual Studio Code.app" && $0.bundleIdentifier == appKey })
        let packagedManager = repository.appendingPathComponent("dist/Extensions Anywhere.app")
        let resources = packagedManager.appendingPathComponent("Contents/Resources")
        let node = resources.appendingPathComponent("Runtime/native/node")
        let proof = repository.appendingPathComponent("output/release-review/2026-09-13/native-vscode-package-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: proof, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let live = try prepareLiveDirectory(proof: proof, appKey: appKey)
        let reportURL = proof.appendingPathComponent("native-report.json")
        print("Native VS Code package evidence: \(reportURL.path)")
        report = ["schema": 1, "passed": false, "startedAt": timestamp(), "managerBundle": packagedManager.path,
                  "targetBundle": app.url.path, "library": live.appendingPathComponent("library.json").path,
                  "liveArtifactsDirectory": live.path, "artifactsReceipt": proof.appendingPathComponent("live-artifacts-receipt.json").path,
                  "scope": "Exact installed VS Code and verified packaged workbench only. Real manager/helper/broker, isolated extension library and in-memory Dock. Normal app profile may restore existing UI. This test opens/edits no files, sends no data and quits no pre-existing app. Helper cleanup leaves the newly launched VS Code running."]
        let dock = MemoryDock()
        let launcher = ElectronLauncher(supportDirectory: live.appendingPathComponent("Launchers"),
            dock: DockShortcutManager(receiptDirectory: live.appendingPathComponent("Receipts"),
                preferences: DockPreferencesAccess(read: { dock.pins }, write: { dock.pins = $0; dock.writes += 1 }, refresh: {})),
            refreshDock: { dock.refreshes += 1 }, openURL: { url in dock.opened.append(url); return NSWorkspace.shared.open(url) }, runtimeResources: resources)
        let manager = ExtensionManager(storageURL: live.appendingPathComponent("library.json"), launcher: launcher,
            presentDockInstaller: { _, _ in dock.installerRequests += 1; return false })
        let helper = launcher.directory(for: app).appendingPathComponent("Visual Studio Code Launcher.app")
        let diagnostic = ProcessInfo.processInfo.environment["EA_NATIVE_PROOF_DIAGNOSTICS"] == "1"
        var session: URL?, operationError: Error?
        do {
            _ = try command("/usr/bin/codesign", ["--verify", "--strict", packagedManager.path], proof: proof)
            let info = try jsonPropertyList(packagedManager.appendingPathComponent("Contents/Info.plist"))
            report["managerVersion"] = info["CFBundleShortVersionString"]; report["managerBuild"] = info["CFBundleVersion"]
            report["before"] = try probe("integrity", node: node, proof: proof, app: "vscode")
            let folder = live.appendingPathComponent("Package")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try makeVSCodePackage(in: folder, replacement: false)
            let manifest = folder.appendingPathComponent("manifest.json")
            let package = try ImportedExtensionPackage.load(from: manifest)
            try ExtensionLibrary().save(to: manager.storageFileURL)
            manager.reload()
            try manager.add(package: package, app: app, isEnabled: false)
            var record = try XCTUnwrap(manager.records(for: app).first)
            try require(!record.isEnabled && record.sourceFiles?.map(\.text) == package.sources.map(\.text) && dock.opened.isEmpty,
                        "VS Code mixed package imports disabled with all source preserved")
            manager.setEnabled(true, record: record, app: app)
            try require(manager.errorMessage == nil, "Native VS Code capability enables the imported package")
            record = try XCTUnwrap(manager.record(record.id))
            let configuration = try json(launcher.directory(for: app).appendingPathComponent("configuration.json"))
            try require(configuration["targetBundlePath"] as? String == app.url.path &&
                        configuration["libraryPath"] as? String == manager.storageFileURL.path &&
                        configuration["brokerPath"] as? String == helper.appendingPathComponent("Contents/Resources/Runtime/scripts/dock-catalog-session.mjs").path,
                        "Generated VS Code helper selects the exact app, isolated library and packaged broker")
            _ = try command("/usr/bin/codesign", ["--verify", "--strict", helper.path], proof: proof)
            report["helperRuntimeDigest"] = try RuntimeResourceFiles.digest(in: helper.appendingPathComponent("Contents/Resources/Runtime"))
            report["packageHashes"] = try sourceHashes(in: folder)
            manager.open(app)
            try require(manager.errorMessage == nil && dock.opened == [launcher.shortcut(for: app)], "Native Open App opens the real VS Code launcher alias")
            let directory: URL = try await wait("VS Code session becomes active", timeout: 60) { () throws -> URL? in
                guard let candidate = launcher.sessionDirectory(app: app), let status = try? self.json(candidate.appendingPathComponent("status.json")) else { return nil }
                if status["phase"] as? String == "error" { throw self.failure(status["error"] as? String ?? "VS Code broker failed.") }
                return status["phase"] as? String == "active" ? candidate : nil
            }
            session = directory; report["session"] = directory.path
            let firstReport = try json(directory.appendingPathComponent("report.json"), limit: 1024 * 1024)
            report["processIdentity"] = firstReport["processIdentity"]
            try require(launcher.runtimeSession(app: app)?.isHealthy == true, "Native status verifies the newly launched VS Code identity")
            var observed = try await observation(node: node, proof: proof, session: directory, id: record.id, app: "vscode") {
                $0["count"] as? Int == 1 && $0["clickCount"] as? Int == 0 && $0["documentOutlineOffset"] as? String == "3px"
            }
            try require(observed["background"] as? String == "rgb(22, 163, 74)", "Real VS Code renderer contains the authored green button")
            if diagnostic {
                _ = try probe("capture-button", node: node, proof: proof, session: directory, id: record.id, app: "vscode", capture: "01-authored-button.png")
            }
            observed = try probe("click", node: node, proof: proof, session: directory, id: record.id, app: "vscode")
            var events = try await clickLogs(record: record, session: directory, minimum: 1, appKey: appKey, message: "VS Code extension proof clicked 1")
            try require(observed["clickCount"] as? Int == 1 && events.count == 1 && events[0].fileName == "main.js",
                        "Actual pointer click runs VS Code JS and reaches attributed native session logs")
            let originalRevision = events[0].revision
            manager.setEnabled(false, record: record, app: app)
            try require(manager.errorMessage == nil, "VS Code disable persists through manager APIs")
            try await waitPhase("disabled", session: directory)
            observed = try probe("observe", node: node, proof: proof, session: directory, id: record.id, app: "vscode")
            // The first disabled observation supplies the baseline. It is not
            // claimed as a prelaunch measurement; later removal must match it.
            let baseline = try XCTUnwrap(observed["documentOutlineOffset"] as? String)
            report["firstDisabledDocumentOutlineOffset"] = baseline
            try require(observed["count"] as? Int == 0 && baseline != "3px" && baseline != "7px",
                        "Disable removes VS Code proof DOM and clears its independent document CSS marker")
            manager.setEnabled(true, record: try XCTUnwrap(manager.record(record.id)), app: app)
            try require(manager.errorMessage == nil, "VS Code re-enable persists through manager APIs")
            _ = try await observation(node: node, proof: proof, session: directory, id: record.id, app: "vscode") {
                $0["count"] as? Int == 1 && $0["clickCount"] as? Int == 0 && $0["documentOutlineOffset"] as? String == "3px"
            }
            observed = try probe("click", node: node, proof: proof, session: directory, id: record.id, app: "vscode")
            events = try await clickLogs(record: record, session: directory, minimum: 2, appKey: appKey, message: "VS Code extension proof clicked 1")
            try require(observed["clickCount"] as? Int == 1 && events.count == 2, "VS Code re-enable creates one fresh handler")

            try makeVSCodePackage(in: folder, replacement: true)
            try manager.add(package: ImportedExtensionPackage.load(from: manifest), app: app, isEnabled: false)
            let oldID = record.id
            let replacement = try XCTUnwrap(manager.records(for: app).first { $0.id != oldID })
            try manager.remove(try XCTUnwrap(manager.record(oldID)), app: app)
            manager.setEnabled(true, record: replacement, app: app)
            try require(manager.errorMessage == nil, "Changed VS Code source replaces its old imported record")
            record = try XCTUnwrap(manager.record(replacement.id))
            _ = try await observation(node: node, proof: proof, session: directory, id: record.id, app: "vscode") {
                $0["count"] as? Int == 1 && $0["clickCount"] as? Int == 0 && $0["documentOutlineOffset"] as? String == "7px"
            }
            observed = try probe("observe", node: node, proof: proof, session: directory, id: oldID, app: "vscode")
            try require(observed["count"] as? Int == 0, "VS Code source replacement leaves no old proof button")
            _ = try probe("click", node: node, proof: proof, session: directory, id: record.id, app: "vscode")
            events = try await clickLogs(record: record, session: directory, minimum: 1, appKey: appKey, message: "VS Code extension proof clicked 1")
            try require(events.count == 1 && events[0].revision != originalRevision, "VS Code logs identify the replacement source revision")
            // VS Code can restore unsaved editors. Its native command performs
            // the normal backup/shutdown sequence; raw Page.reload does not.
            let request = try probe("request-reload", node: node, proof: proof, session: directory, id: record.id, app: "vscode")
            try require(request["requested"] as? Bool == true, "VS Code reload requests the native Developer: Reload Window checkpoint")
            report["reloadRequest"] = request
            let readyRequest = ExtensionRuntimeLogs.Request(sessionDirectory: directory, appKey: appKey,
                extensionID: record.id, sourceFileNames: ["main.js"])
            let beforeReloadSequence = try XCTUnwrap(events.last?.sequence)
            let _: Bool = try await wait("native VS Code reload and reapplication", timeout: 120) {
                if let status = try? self.json(directory.appendingPathComponent("status.json")),
                   let phase = status["phase"] as? String, phase == "error" || phase == "stopped" {
                    throw self.failure(status["error"] as? String ?? "The VS Code broker stopped during the native reload checkpoint.")
                }
                // The native command briefly destroys the renderer. Failed
                // observations during that interval never authorize an action.
                guard let value = try? self.probe("observe", node: node, proof: proof, session: directory, id: record.id, app: "vscode"),
                      value["count"] as? Int == 1 && value["clickCount"] as? Int == 0 &&
                      value["documentOutlineOffset"] as? String == "7px" else { return nil }
                let snapshot = ExtensionRuntimeLogs.load(readyRequest)
                guard snapshot.issue == nil else { throw self.failure(snapshot.issue!) }
                return snapshot.events.contains { $0.sequence > beforeReloadSequence && $0.message == "VS Code extension proof ready" } ? true : nil
            }
            observed = try probe("click", node: node, proof: proof, session: directory, id: record.id, app: "vscode")
            events = try await clickLogs(record: record, session: directory, minimum: 2, appKey: appKey, message: "VS Code extension proof clicked 1")
            try require(observed["clickCount"] as? Int == 1 && events.count == 2 && events[1].sequence > events[0].sequence,
                        "VS Code reload automatically reapplies CSS and one fresh handler with monotonic logs")
            report["extensionID"] = record.id.uuidString
            report["clickEvents"] = events.map { ["sequence": $0.sequence, "extensionID": $0.extensionID.uuidString,
                                                  "fileName": $0.fileName, "revision": $0.revision, "message": $0.message] as [String: Any] }
            try manager.remove(record, app: app)
            try await waitPhase("disabled", session: directory)
            observed = try probe("observe", node: node, proof: proof, session: directory, id: record.id, app: "vscode")
            try require(manager.library.records.isEmpty && observed["count"] as? Int == 0 && observed["documentOutlineOffset"] as? String == baseline,
                        "Removing the final VS Code extension clears proof DOM/CSS and isolated records")
        } catch { operationError = error }
        do {
            try await stopOwnedHelper(at: helper, identifier: launcherID)
            if let session {
                try await waitPhase("stopped", session: session)
                let broker = try json(session.appendingPathComponent("report.json"), limit: 1024 * 1024)
                report["brokerReport"] = broker
                let cleanup = try XCTUnwrap(broker["cleanup"] as? [String: Any])
                try require(cleanup["jsCleanupVerified"] as? Bool == true && cleanup["stylesheetRemoved"] as? Bool == true &&
                            cleanup["targetTerminationRequested"] as? Bool == false && cleanup["launchedAppLeftRunning"] as? Bool == true,
                            "Catalog helper cleanup removes JS/CSS and leaves its newly launched VS Code running")
            }
            let after = try probe("integrity", node: node, proof: proof, app: "vscode")
            report["after"] = after
            if let before = report["before"] as? [String: Any] {
                try require(before["cdhash"] as? String == after["cdhash"] as? String && before["sha256"] as? String == after["sha256"] as? String,
                            "VS Code bundle contents and signing remain unchanged")
            }
        } catch { if operationError == nil { operationError = error } else { report["cleanupError"] = error.localizedDescription } }
        report["checks"] = checks; report["passed"] = operationError == nil; report["finishedAt"] = timestamp()
        report["dock"] = ["backend": "memory-only", "writes": dock.writes, "remainingPins": dock.pins.count]
        report["diagnostics"] = diagnostic ? "Explicit cropped authored-button image only; no editor-content capture." : "No screenshots."
        if let operationError { report["error"] = operationError.localizedDescription }
        try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys, .prettyPrinted]).write(to: reportURL, options: .atomic)
        if let operationError { throw operationError }
    }

    private func prepareLiveDirectory(proof: URL, appKey: String) throws -> URL {
        // A launched helper reading Documents may wait for a Files & Folders
        // prompt. Keep operational files in the same class of location used by
        // the product, isolated from the user's real library and launchers.
        let prefix: String
        switch appKey {
        case fixtureID: prefix = "native-fixture-package-"
        case "com.microsoft.VSCode": prefix = "native-vscode-package-"
        default: throw failure("Unknown native proof target.")
        }
        guard proof.lastPathComponent.hasPrefix(prefix),
              let runID = UUID(uuidString: String(proof.lastPathComponent.dropFirst(prefix.count))) else {
            throw failure("Invalid native proof directory name.")
        }
        let applicationSupport = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
        let base = applicationSupport.appendingPathComponent("Extensions Anywhere Native E2E", isDirectory: true)
        guard applicationSupport.resolvingSymlinksInPath().path == applicationSupport.path else {
            throw failure("The proof Application Support directory must not contain symlinks.")
        }
        if !FileManager.default.fileExists(atPath: base.path) {
            try FileManager.default.createDirectory(at: base, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
        let values = try base.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink == false,
              base.resolvingSymlinksInPath().path == base.path else {
            throw failure("The isolated native proof base must be a regular directory without symlinks.")
        }
        let live = base.appendingPathComponent(proof.lastPathComponent, isDirectory: true)
        // A fresh UUID directory is required; never reuse or delete a prior run.
        guard !FileManager.default.fileExists(atPath: live.path) else {
            throw failure("The native proof live directory already exists; it will not be reused.")
        }
        try FileManager.default.createDirectory(at: live, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let receipt: [String: Any] = ["schema": 1, "runID": runID.uuidString, "appKey": appKey, "uid": getuid(),
            "evidenceDirectory": proof.path, "liveDirectory": live.path, "createdAt": timestamp(),
            "retention": "Retained for inspection. Only this uniquely named test directory contains its library, source copies, launchers and sessions."]
        let data = try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys])
        for location in [live.appendingPathComponent("test-run-receipt.json"), proof.appendingPathComponent("live-artifacts-receipt.json")] {
            try data.write(to: location, options: .withoutOverwriting)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: location.path)
        }
        return live
    }

    private func makeVSCodePackage(in folder: URL, replacement: Bool) throws {
        let manifest = ExtensionManifest(name: "VS Code native proof", description: "Temporary logging button with complete cleanup", version: replacement ? "1.0.1" : "1.0.0", css: ["styles.css"], js: ["main.js"])
        try JSONEncoder().encode(manifest).write(to: folder.appendingPathComponent("manifest.json"), options: .atomic)
        let outlineOffset = replacement ? "7px" : "3px"
        let css = """
        .ea-vscode-native-proof { position: fixed !important; right: 24px !important; bottom: 36px !important; z-index: 2147483647 !important; padding: 10px 16px !important; background-color: rgb(22, 163, 74) !important; color: white !important; border: 1px solid white !important; border-radius: 8px !important; cursor: pointer; }
        html { outline-offset: \(outlineOffset) !important; }
        """
        let js = #"""
        if (!document.querySelector('.monaco-workbench')) throw new Error('Expected VS Code workbench is missing');
        const id = `ea-vscode-proof-${ea.id}`;
        if (document.getElementById(id)) throw new Error('Duplicate proof button');
        const button = document.createElement('button');
        let count = 0;
        const click = () => { count += 1; button.dataset.clickCount = String(count); button.textContent = `Extension proof (${count})`; console.log('VS Code extension proof clicked', count); };
        ea.onDispose(() => { button.removeEventListener('click', click); button.remove(); console.info('VS Code extension proof removed'); });
        button.id = id; button.type = 'button'; button.className = 'ea-vscode-native-proof';
        button.textContent = 'Extension proof'; button.dataset.clickCount = '0';
        button.addEventListener('click', click, { signal: ea.signal });
        document.body.append(button);
        console.info('VS Code extension proof ready');
        """# + (replacement ? "\nconsole.info('VS Code replacement revision ready');\n" : "\n")
        try css.write(to: folder.appendingPathComponent("styles.css"), atomically: true, encoding: .utf8)
        try js.write(to: folder.appendingPathComponent("main.js"), atomically: true, encoding: .utf8)
    }

    private func clickLogs(record: ExtensionRecord, session: URL, minimum: Int, appKey: String? = nil,
                           message: String = "Style Lab script button clicked 1") async throws -> [ExtensionRuntimeLog] {
        let request = ExtensionRuntimeLogs.Request(sessionDirectory: session, appKey: appKey ?? fixtureID, extensionID: record.id, sourceFileNames: ["main.js"])
        return try await wait("attributed native click logs", timeout: 15) {
            let snapshot = ExtensionRuntimeLogs.load(request)
            guard snapshot.issue == nil else { throw self.failure(snapshot.issue!) }
            let events = snapshot.events.filter { $0.message == message }
            return events.count >= minimum ? events : nil
        }
    }

    private func observation(node: URL, proof: URL, session: URL, id: UUID, app: String = "stylelab",
                             matches: ([String: Any]) -> Bool) async throws -> [String: Any] {
        try await wait("owned renderer observation", timeout: 20) {
            let value = try self.probe("observe", node: node, proof: proof, session: session, id: id, app: app)
            return matches(value) ? value : nil
        }
    }

    private func waitPhase(_ phase: String, session: URL) async throws {
        let _: Bool = try await wait("session phase \(phase)", timeout: 25) {
            let status = try self.json(session.appendingPathComponent("status.json"))
            if status["phase"] as? String == "error" { throw self.failure(status["error"] as? String ?? "The broker reported an error.") }
            return status["phase"] as? String == phase ? true : nil
        }
    }

    private func wait<T>(_ label: String, timeout: TimeInterval, condition: () throws -> T?) async throws -> T {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let result = try condition() { return result }
            try await Task.sleep(for: .milliseconds(250))
        } while Date() < deadline
        throw failure("Timed out waiting for \(label).")
    }

    private func stopOwnedHelper(at url: URL, identifier: String? = nil) async throws {
        let candidates = NSRunningApplication.runningApplications(withBundleIdentifier: identifier ?? helperID)
            .filter { $0.bundleURL?.path == url.path }
        guard candidates.count <= 1 else { throw failure("Multiple proof helpers were found; none was stopped.") }
        guard let helper = candidates.first else { return }
        let pid = helper.processIdentifier
        let initial = RuntimeProcessIdentity.processRecord(processIdentifier: pid)
        guard initial.status == "ok", initial.uid == getuid(), initial.started != nil,
              let executable = Bundle(url: url)?.executableURL,
              initial.executable == executable.path else {
            throw failure("The proof helper's live kernel identity could not be verified; none was stopped.")
        }
        let requestedAt = Date()
        var evidence: [String: Any] = ["pid": pid, "started": initial.started!,
            "executable": executable.path, "requestedAt": timestamp(), "polls": 0]
        defer {
            evidence["finishedAt"] = timestamp()
            evidence["elapsedSeconds"] = Date().timeIntervalSince(requestedAt)
            report["helperExit"] = evidence
        }
        guard helper.terminate() else { throw failure("The proof helper refused normal termination.") }
        let _: Bool = try await wait("proof helper normal exit", timeout: 25) {
            let fresh = RuntimeProcessIdentity.processRecord(processIdentifier: pid)
            evidence["polls"] = (evidence["polls"] as? Int ?? 0) + 1
            evidence["lastKernelRecord"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(fresh))
            // NSRunningApplication can retain isTerminated=false under XCTest.
            // Confirm absence or a stable exited kernel process independently.
            if RuntimeProcessIdentity.hasDefinitelyExited(processIdentifier: pid) {
                evidence["confirmedBy"] = "fresh-kernel-exit"
                return true
            }
            if fresh.status == "ok", let started = fresh.started, started != initial.started {
                // The original process exited and its PID was reused. Never
                // send another termination request to that replacement.
                evidence["confirmedBy"] = "kernel-pid-reused"
                return true
            }
            return nil
        }
    }

    private func probe(_ action: String, node: URL, proof: URL, session: URL? = nil, id: UUID? = nil,
                       app: String = "stylelab", capture: String? = nil) throws -> [String: Any] {
        var args = [repository.appendingPathComponent("scripts/testing/verify-native-fixture-package.mjs").path,
                    "--proof-root", proof.path, "--action", action, "--app", app]
        if let session, let id { args += ["--session", session.path, "--extension-id", id.uuidString] }
        if let capture { args += ["--diagnostic-output", proof.appendingPathComponent(capture).path] }
        let result = try command(node.path, args, proof: proof)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: result) as? [String: Any])
    }

    private func command(_ executable: String, _ arguments: [String], proof: URL) throws -> Data {
        probeNumber += 1
        let output = proof.appendingPathComponent("command-\(probeNumber).log")
        FileManager.default.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let handle = try FileHandle(forWritingTo: output)
        defer { try? handle.close() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "NODE_OPTIONS"); environment.removeValue(forKey: "NODE_PATH")
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = handle; process.standardError = handle
        try process.run()
        let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 40, execute: timeout)
        process.waitUntilExit(); timeout.cancel()
        let data = try RuntimeBoundedFile.read(output, maximumBytes: 1024 * 1024) ?? Data()
        guard process.terminationStatus == 0 else {
            throw failure("Proof command failed: \(String(data: data, encoding: .utf8)?.prefix(2000) ?? "Unreadable output")")
        }
        return data
    }

    private func json(_ file: URL, limit: Int = 64 * 1024) throws -> [String: Any] {
        // Polling a not-yet-created status file is expected. XCTest assertions
        // would remain recorded even when a caller deliberately catches them.
        guard let data = try RuntimeBoundedFile.read(file, maximumBytes: limit) else {
            throw CocoaError(.fileReadNoSuchFile)
        }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw failure("The proof JSON must contain an object: \(file.lastPathComponent)")
        }
        return object
    }

    private func jsonPropertyList(_ file: URL) throws -> [String: Any] {
        try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: file), options: [], format: nil) as? [String: Any])
    }

    private func sourceHashes(in folder: URL) throws -> [String: String] {
        try Dictionary(uniqueKeysWithValues: ["manifest.json", "styles.css", "main.js"].map { name in
            (name, SHA256.hash(data: try Data(contentsOf: folder.appendingPathComponent(name))).map { String(format: "%02x", $0) }.joined())
        })
    }

    private func require(_ condition: @autoclosure () -> Bool, _ name: String) throws {
        guard condition() else { throw failure(name) }
        checks.append(name)
    }

    private func timestamp() -> String { ISO8601DateFormatter().string(from: Date()) }
    private func failure(_ message: String) -> NSError {
        NSError(domain: "ExtensionsAnywhere.NativeFixtureProof", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
