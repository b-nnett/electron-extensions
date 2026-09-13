import AppKit
import CryptoKit
import Foundation
import RuntimeCatalog
import XCTest
@testable import ExtensionsAnywhere

/// Opt-in native manager/helper proof on Figma's login page; files/editor routes are not verified here.
/// Renderer observations come from a fixed imported test extension, never a
/// pipe command endpoint. A supervising user/agent performs the two UI checkpoints.
@MainActor
final class FigmaJavaScriptIntegrationTests: XCTestCase {
    private let appKey = "com.figma.Desktop"
    private let helperID = "dev.extensionsanywhere.launcher.figma"
    private var report: [String: Any] = [:]
    private var checks: [String] = []
    private var commandNumber = 0
    private var repository: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }
    private final class MemoryDock {
        var pins: [DockShortcutEngine.Tile] = []
        var writes = 0
        var refreshes = 0
        var opened: [URL] = []
    }

    func testOptInNativeFigmaLoginImportedPackageLifecycle() async throws {
        guard ProcessInfo.processInfo.environment["EA_RUN_NATIVE_FIGMA_PACKAGE_E2E"] == "1" else {
            throw XCTSkip("Set EA_RUN_NATIVE_FIGMA_PACKAGE_E2E=1 for supervised Figma login-only proof with two native UI checkpoints.")
        }
        guard NSRunningApplication.runningApplications(withBundleIdentifier: appKey).isEmpty,
              NSRunningApplication.runningApplications(withBundleIdentifier: helperID).isEmpty else {
            throw failure("Figma or its launcher is already running. This test will not quit any pre-existing app.")
        }
        let app = try XCTUnwrap(ElectronAppDiscovery.scan(in: URL(fileURLWithPath: "/Applications"))
            .first { $0.url.path == "/Applications/Figma.app" && $0.bundleIdentifier == appKey })
        guard ElectronLaunchProfile.profile(for: app)?.supportsJavaScript == true else { throw failure("The exact Figma login profile is not JS-capable in this test adapter.") }
        let packagedManager = repository.appendingPathComponent("dist/Extensions Anywhere.app")
        let resources = packagedManager.appendingPathComponent("Contents/Resources")
        let runID = UUID()
        let proof = repository.appendingPathComponent("output/release-review/2026-09-13/native-figma-package-\(runID.uuidString)")
        try FileManager.default.createDirectory(at: proof, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let live = try prepareLiveDirectory(proof: proof, runID: runID)
        report = ["schema": 1, "passed": false, "startedAt": timestamp(), "managerBundle": packagedManager.path,
            "targetBundle": app.url.path, "liveArtifactsDirectory": live.path,
            "scope": "Exact Figma login page only. Native manager/importer and generated helper with packaged broker; isolated library and memory Dock. Two supervised native UI checkpoints. Fixed imported observer reads only owned proof DOM/CSS. No files/editor verification, generic pipe evaluator, or manager-GUI-import claim."]
        let dock = MemoryDock()
        let launcher = ElectronLauncher(supportDirectory: live.appendingPathComponent("Launchers"),
            dock: DockShortcutManager(receiptDirectory: live.appendingPathComponent("Receipts"),
                preferences: DockPreferencesAccess(read: { dock.pins }, write: { dock.pins = $0; dock.writes += 1 }, refresh: {})),
            refreshDock: { dock.refreshes += 1 }, openURL: { dock.opened.append($0); return NSWorkspace.shared.open($0) }, runtimeResources: resources)
        let manager = ExtensionManager(storageURL: live.appendingPathComponent("library.json"), launcher: launcher,
            presentDockInstaller: { _, _ in false })
        let helper = launcher.directory(for: app).appendingPathComponent("Figma Launcher.app")
        let subjectFolder = live.appendingPathComponent("Subject")
        let observerFolder = live.appendingPathComponent("Observer")
        let proofClass = "ea-figma-native-proof-\(runID.uuidString.lowercased())"
        var session: URL?, operationError: Error?
        do {
            _ = try command("/usr/bin/codesign", ["--verify", "--strict", packagedManager.path], proof: proof)
            let info = try plist(packagedManager.appendingPathComponent("Contents/Info.plist"))
            try require(info["CFBundleIdentifier"] as? String == "dev.extensions-anywhere.app", "Packaged manager has the expected application identity")
            report["managerVersion"] = info["CFBundleShortVersionString"]; report["managerBuild"] = info["CFBundleVersion"]
            report["before"] = try integrity(app.url, proof: proof)
            try writeSubject(in: subjectFolder, proofClass: proofClass, replacement: false)
            try writeObserver(in: observerFolder, proofClass: proofClass)
            try ExtensionLibrary().save(to: manager.storageFileURL)
            manager.reload()
            try manager.add(package: ImportedExtensionPackage.load(from: subjectFolder.appendingPathComponent("manifest.json")), app: app, isEnabled: false)
            var subject = try XCTUnwrap(manager.records(for: app).first)
            try require(!subject.isEnabled && subject.sourceFiles?.count == 2 && dock.opened.isEmpty && !FileManager.default.fileExists(atPath: helper.path),
                "Mixed package imports disabled without launching or preparing a helper")
            try manager.add(package: ImportedExtensionPackage.load(from: observerFolder.appendingPathComponent("manifest.json")), app: app)
            let observer = try XCTUnwrap(manager.records(for: app).first { $0.id != subject.id })
            report["observerExtensionID"] = observer.id.uuidString; report["initialExtensionID"] = subject.id.uuidString
            _ = try command("/usr/bin/codesign", ["--verify", "--strict", helper.path], proof: proof)
            let configuration = try json(launcher.directory(for: app).appendingPathComponent("configuration.json"))
            try require(configuration["libraryPath"] as? String == manager.storageFileURL.path &&
                configuration["nodePath"] as? String == helper.appendingPathComponent("Contents/Resources/Runtime/native/node").path &&
                configuration["brokerPath"] as? String == helper.appendingPathComponent("Contents/Resources/Runtime/scripts/dock-catalog-session.mjs").path,
                "Generated helper binds its sealed runtime to the isolated library")
            let runtimeDigest = try RuntimeResourceFiles.digest(in: resources.appendingPathComponent("Runtime"))
            try require(try RuntimeResourceFiles.digest(in: helper.appendingPathComponent("Contents/Resources/Runtime")) == runtimeDigest,
                "Helper runtime exactly matches packaged manager runtime")
            report["runtimeDigest"] = runtimeDigest
            report["sourceHashes"] = try sourceHashes(subjectFolder)
            manager.open(app)
            try require(manager.errorMessage == nil && dock.opened == [launcher.shortcut(for: app)], "Open App dispatches the generated alias")
            let directory: URL = try await wait("Figma login session active", timeout: 60) {
                guard let directory = launcher.sessionDirectory(app: app), let value = try? self.json(directory.appendingPathComponent("status.json")) else { return nil }
                if value["phase"] as? String == "error" { throw self.failure(value["error"] as? String ?? "Figma broker failed") }
                return value["phase"] as? String == "active" ? directory : nil
            }
            session = directory; report["session"] = directory.path
            try require(launcher.runtimeSession(app: app)?.isHealthy == true, "Native status identifies the live Figma/helper session")
            let baseline = try await observation(observer: observer, session: directory) { $0["count"] as? Int == 0 }
            let baselineOutline = try XCTUnwrap(baseline["outline"] as? String)
            report["baseline"] = baseline
            manager.setEnabled(true, record: subject, app: app)
            try require(manager.errorMessage == nil, "Native enable persists mixed CSS and JS for the login profile")
            subject = try XCTUnwrap(manager.record(subject.id))
            let initial = try await observation(observer: observer, session: directory) {
                $0["count"] as? Int == 1 && $0["extensionID"] as? String == subject.id.uuidString &&
                $0["background"] as? String == "rgb(22, 163, 74)" && $0["outline"] as? String == "3px"
            }
            let initialDocument = try XCTUnwrap(initial["document"] as? String)
            try require(initial["clicks"] as? Int == 0, "Imported JavaScript creates one button styled by imported CSS")
            try checkpoint(1, action: "Click the green ‘Figma extension proof’ button once in Figma. Do not click the login form.", proof: proof)
            _ = try await observation(observer: observer, session: directory, timeout: 180) {
                $0["document"] as? String == initialDocument && $0["extensionID"] as? String == subject.id.uuidString && $0["clicks"] as? Int == 1
            }
            let clicked = try await subjectLog(subject, session: directory, prefix: "EA_FIGMA_CLICK ")
            try require(clicked.level == .log && clicked.fileName == "main.js", "Supervised real button click executes an extension-attributed JavaScript handler")
            let initialRevision = clicked.revision
            manager.setEnabled(false, record: subject, app: app)
            _ = try await observation(observer: observer, session: directory) { $0["count"] as? Int == 0 && $0["outline"] as? String == baselineOutline }
            try require(manager.errorMessage == nil, "Disable removes owned DOM and restores the independent CSS baseline")
            subject = try XCTUnwrap(manager.record(subject.id))
            manager.setEnabled(true, record: subject, app: app)
            _ = try await observation(observer: observer, session: directory) {
                $0["count"] as? Int == 1 && $0["extensionID"] as? String == subject.id.uuidString && $0["clicks"] as? Int == 0 && $0["outline"] as? String == "3px"
            }
            try require(manager.errorMessage == nil, "Re-enable installs exactly one fresh button")
            subject = try XCTUnwrap(manager.record(subject.id))
            try manager.remove(subject, app: app)
            _ = try await observation(observer: observer, session: directory) { $0["count"] as? Int == 0 && $0["outline"] as? String == baselineOutline }
            try writeSubject(in: subjectFolder, proofClass: proofClass, replacement: true)
            try manager.add(package: ImportedExtensionPackage.load(from: subjectFolder.appendingPathComponent("manifest.json")), app: app)
            subject = try XCTUnwrap(manager.records(for: app).first { $0.id != observer.id })
            report["replacementExtensionID"] = subject.id.uuidString
            let replaced = try await observation(observer: observer, session: directory) {
                $0["count"] as? Int == 1 && $0["extensionID"] as? String == subject.id.uuidString && $0["outline"] as? String == "7px" && $0["clicks"] as? Int == 0
            }
            let ready = try await subjectLog(subject, session: directory, prefix: "EA_FIGMA_READY ")
            try require(ready.revision != initialRevision, "Re-imported replacement has a distinct attributed script revision and updated CSS")
            let beforeReload = try XCTUnwrap(replaced["document"] as? String)
            try checkpoint(2, action: "Use Figma’s native Reload command, wait for the green ‘Figma extension proof’ button to return, then click it once.", proof: proof)
            let reloaded = try await observation(observer: observer, session: directory, timeout: 180) {
                $0["document"] as? String != beforeReload && $0["count"] as? Int == 1 &&
                $0["extensionID"] as? String == subject.id.uuidString && $0["outline"] as? String == "7px" &&
                $0["background"] as? String == "rgb(22, 163, 74)" && $0["clicks"] as? Int == 1
            }
            let postReload = try await subjectLog(subject, session: directory, prefix: "EA_FIGMA_CLICK ")
            try require(postReload.revision == ready.revision && reloaded["document"] as? String != beforeReload,
                "Native reload reapplies one styled button and its real click handler in the fresh document")
            report["reloaded"] = reloaded
            try manager.remove(try XCTUnwrap(manager.record(subject.id)), app: app)
            _ = try await observation(observer: observer, session: directory) { $0["count"] as? Int == 0 && $0["outline"] as? String == baselineOutline }
            try require(manager.record(subject.id) == nil, "Remove deletes the saved subject and cleans its DOM and CSS")
            try manager.remove(try XCTUnwrap(manager.record(observer.id)), app: app)
            let _: Bool = try await wait("all test extensions disabled", timeout: 30) {
                let value = try self.json(directory.appendingPathComponent("status.json"))
                return value["phase"] as? String == "disabled" ? true : nil
            }
            try require(manager.records(for: app).isEmpty, "Observer is removed and all test extensions finish cleanup")
            let disabledReport = try json(directory.appendingPathComponent("report.json"), limit: 1024 * 1024)
            let targetIdentity = try XCTUnwrap(disabledReport["processIdentity"] as? [String: Any])
            let targetPID = try XCTUnwrap(targetIdentity["pid"] as? Int32)
            let disabledTarget = RuntimeProcessIdentity.processRecord(processIdentifier: targetPID)
            let runningHelpers = NSRunningApplication.runningApplications(withBundleIdentifier: helperID).filter { $0.bundleURL?.path == helper.path }
            let runningHelper = try XCTUnwrap(runningHelpers.count == 1 ? runningHelpers.first : nil)
            let disabledHelper = RuntimeProcessIdentity.processRecord(processIdentifier: runningHelper.processIdentifier)
            try require(disabledTarget.status == "ok" && disabledTarget.started == targetIdentity["started"] as? String &&
                disabledTarget.executable == app.url.appendingPathComponent("Contents/MacOS/Figma").path && disabledTarget.uid == getuid() &&
                disabledHelper.status == "ok" && disabledHelper.executable == Bundle(url: helper)?.executableURL?.path && disabledHelper.uid == getuid(),
                "Disabling the last extension preserves the exact running Figma instance and its pipe-owning helper")
            report["disabledTargetIdentity"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(disabledTarget))
            report["disabledHelperIdentity"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(disabledHelper))
            let after = try integrity(app.url, proof: proof)
            try require(NSDictionary(dictionary: try XCTUnwrap(report["before"] as? [String: Any])).isEqual(to: after),
                "Figma signing and checked executable/archive/signature resources are unchanged")
            report["after"] = after
            report["passed"] = true
        } catch { operationError = error }
        // Disabling keeps the watcher alive. Explicitly closing this test helper
        // closes Electron's debugging pipe, which may normally quit Figma.
        for record in manager.records(for: app) where record.isEnabled { manager.setEnabled(false, record: record, app: app) }
        do {
            try await stopOwnedHelper(helper)
            if let session {
                let final = try json(session.appendingPathComponent("status.json"))
                let broker = try json(session.appendingPathComponent("report.json"), limit: 1024 * 1024)
                report["finalStatus"] = final; report["brokerReport"] = broker
                report["vendorVersion"] = broker["version"]; report["vendorBuild"] = broker["build"]
                let cleanup = try XCTUnwrap(broker["cleanup"] as? [String: Any])
                try require(final["phase"] as? String == "stopped" && (broker["errors"] as? [String])?.isEmpty == true,
                    "Owned helper exits with a successful terminal broker status")
                try require(cleanup["jsCleanupVerified"] as? Bool == true && cleanup["stylesheetRemoved"] as? Bool == true &&
                    cleanup["pipeCloseMayQuitApp"] as? Bool == true && cleanup["targetTerminationRequested"] as? Bool == false,
                    "Explicit helper stop cleans scripts and styles before closing its debugging pipe")
                let finalObservation = try XCTUnwrap(cleanup["finalProcessObservation"] as? [String: Any])
                try require(cleanup["launchedAppLeftRunning"] as? Bool == false && finalObservation["sameProcessAlive"] as? Bool == false,
                    "Broker reports the pipe-close app exit without a stale survival claim")
                let originalIdentity = try XCTUnwrap(broker["processIdentity"] as? [String: Any])
                let originalPID = try XCTUnwrap(originalIdentity["pid"] as? Int32)
                let _: Bool = try await wait("original Figma process exits after explicit pipe close", timeout: 10) {
                    let fresh = RuntimeProcessIdentity.processRecord(processIdentifier: originalPID)
                    self.report["afterHelperTargetIdentity"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(fresh))
                    if RuntimeProcessIdentity.hasDefinitelyExited(processIdentifier: originalPID) { return true }
                    return fresh.status == "ok" && fresh.started != originalIdentity["started"] as? String ? true : nil
                }
                let processExit = try XCTUnwrap(broker["processExit"] as? [String: Any])
                try require(processExit["code"] as? Int == 0 && processExit["signal"] is NSNull,
                    "Figma exits normally after explicit helper/pipe closure; ordinary disable did not close it")
                let before = try XCTUnwrap(broker["before"] as? [String: Any])
                let during = try XCTUnwrap(broker["during"] as? [String: Any])
                let after = try XCTUnwrap(broker["after"] as? [String: Any])
                let hash = try XCTUnwrap(before["sha256"] as? String), cdhash = try XCTUnwrap(before["cdhash"] as? String)
                try require(!hash.isEmpty && !cdhash.isEmpty && broker["unchanged"] as? Bool == true &&
                    [before, during, after].allSatisfy { $0["valid"] as? Bool == true && $0["sha256"] as? String == hash && $0["cdhash"] as? String == cdhash },
                    "Full bundle fingerprint and code signature match before, during, and after final cleanup")
            }
        } catch { operationError = operationError ?? error; report["cleanupError"] = error.localizedDescription }
        report["checks"] = checks; report["finishedAt"] = timestamp()
        report["memoryDockWrites"] = dock.writes; report["memoryDockRefreshes"] = dock.refreshes
        if let operationError { report["passed"] = false; report["error"] = operationError.localizedDescription }
        try writeJSON(report, to: proof.appendingPathComponent("native-report.json"))
        try writeJSON(["complete": true, "passed": operationError == nil], to: proof.appendingPathComponent("next-action.json"))
        print("Native Figma login proof result: \(proof.appendingPathComponent("native-report.json").path)")
        if let operationError { throw operationError }
    }

    private func observation(observer: ExtensionRecord, session: URL, timeout: TimeInterval = 30,
                             matches: ([String: Any]) -> Bool) async throws -> [String: Any] {
        try await wait("fixed observer DOM/CSS readback", timeout: timeout) {
            let status = try self.json(session.appendingPathComponent("status.json"))
            if status["phase"] as? String == "error" { throw self.failure(status["error"] as? String ?? "Figma extension failed") }
            // Only the newest snapshot is eligible; old matching history cannot
            // prove a later disable/re-enable/reload checkpoint.
            guard let last = try self.logs(observer, session: session, file: "observer.js").last(where: { $0.message.hasPrefix("EA_FIGMA_OBSERVE ") }),
                  let data = String(last.message.dropFirst("EA_FIGMA_OBSERVE ".count)).data(using: .utf8),
                  let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return matches(value) ? value : nil
        }
    }
    private func subjectLog(_ record: ExtensionRecord, session: URL, prefix: String) async throws -> ExtensionRuntimeLog {
        try await wait("attributed subject log", timeout: 20) { try self.logs(record, session: session, file: "main.js").last { $0.message.hasPrefix(prefix) } }
    }
    private func logs(_ record: ExtensionRecord, session: URL, file: String) throws -> [ExtensionRuntimeLog] {
        let value = ExtensionRuntimeLogs.load(.init(sessionDirectory: session, appKey: appKey, extensionID: record.id, sourceFileNames: [file]))
        guard value.issue == nil else { throw failure(value.issue!) }
        return value.events
    }
    private func checkpoint(_ number: Int, action: String, proof: URL) throws {
        let value: [String: Any] = ["schema": 1, "checkpoint": number, "app": "/Applications/Figma.app", "action": action, "timeoutSeconds": 180, "createdAt": timestamp()]
        try writeJSON(value, to: proof.appendingPathComponent("next-action.json"))
        try writeJSON(value, to: proof.appendingPathComponent("checkpoint-\(number).json"))
        print("FIGMA CHECKPOINT \(number): \(action) Evidence: \(proof.path)")
    }

    private func writeSubject(in folder: URL, proofClass: String, replacement: Bool) throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let manifest = ExtensionManifest(name: "Figma login proof", description: "Temporary authored button with registered cleanup", version: replacement ? "1.0.1" : "1.0.0", css: ["styles.css"], js: ["main.js"])
        try JSONEncoder().encode(manifest).write(to: folder.appendingPathComponent("manifest.json"), options: .atomic)
        let css = ".\(proofClass) { position: fixed !important; right: 24px !important; bottom: 36px !important; z-index: 2147483647 !important; padding: 10px 16px !important; background-color: rgb(22, 163, 74) !important; color: white !important; border: 1px solid white !important; border-radius: 8px !important; cursor: pointer; }\nhtml { outline-offset: \(replacement ? "7px" : "3px") !important; }\n"
        let js = """
        if (location.origin !== 'https://www.figma.com' || !/^\\/login\\/?$/.test(location.pathname)) throw new Error('Expected Figma login page');
        const className = '\(proofClass)';
        if (document.querySelector('.' + className)) throw new Error('Duplicate proof button');
        const button = document.createElement('button');
        button.id = 'ea-figma-proof-' + ea.id; button.type = 'button'; button.className = className;
        button.dataset.extensionId = ea.id; button.dataset.clickCount = '0'; button.textContent = 'Figma extension proof';
        let count = 0;
        const click = () => { count += 1; button.dataset.clickCount = String(count); button.textContent = 'Figma extension proof (' + count + ')'; console.log('EA_FIGMA_CLICK ' + JSON.stringify({ count, revision: '\(replacement ? "replacement" : "initial")' })); };
        ea.onDispose(() => { button.removeEventListener('click', click); button.remove(); console.info('EA_FIGMA_REMOVED ' + ea.id); });
        button.addEventListener('click', click, { signal: ea.signal }); document.body.append(button);
        console.info('EA_FIGMA_READY \(replacement ? "replacement" : "initial")');
        """
        try css.write(to: folder.appendingPathComponent("styles.css"), atomically: true, encoding: .utf8)
        try js.write(to: folder.appendingPathComponent("main.js"), atomically: true, encoding: .utf8)
    }
    private func writeObserver(in folder: URL, proofClass: String) throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let manifest = ExtensionManifest(name: "Figma proof observer", description: "Observes only owned proof DOM and CSS markers", version: "1.0.0", css: [], js: ["observer.js"])
        try JSONEncoder().encode(manifest).write(to: folder.appendingPathComponent("manifest.json"), options: .atomic)
        let js = """
        if (location.origin !== 'https://www.figma.com' || !/^\\/login\\/?$/.test(location.pathname)) throw new Error('Expected Figma login page');
        const documentToken = crypto.randomUUID(); let previous = '';
        const observe = () => {
          const buttons = document.querySelectorAll('.\(proofClass)'); const button = buttons[0];
          const value = JSON.stringify({ document: documentToken, count: buttons.length, extensionID: button?.dataset.extensionId ?? '', clicks: Number(button?.dataset.clickCount ?? 0), background: button ? getComputedStyle(button).backgroundColor : '', outline: getComputedStyle(document.documentElement).outlineOffset });
          if (value !== previous) { previous = value; console.info('EA_FIGMA_OBSERVE ' + value); }
        };
        const timer = setInterval(observe, 250);
        ea.onDispose(() => { clearInterval(timer); console.info('EA_FIGMA_OBSERVER_REMOVED'); });
        observe();
        """
        try js.write(to: folder.appendingPathComponent("observer.js"), atomically: true, encoding: .utf8)
    }

    private func prepareLiveDirectory(proof: URL, runID: UUID) throws -> URL {
        let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support", isDirectory: true)
        let base = support.appendingPathComponent("Extensions Anywhere Native E2E", isDirectory: true)
        guard support.resolvingSymlinksInPath().path == support.path else { throw failure("Symlinked Application Support is not a proof location") }
        if !FileManager.default.fileExists(atPath: base.path) { try FileManager.default.createDirectory(at: base, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
        let values = try base.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true, base.resolvingSymlinksInPath().path == base.path else { throw failure("Unsafe proof base") }
        let live = base.appendingPathComponent(proof.lastPathComponent, isDirectory: true)
        guard !FileManager.default.fileExists(atPath: live.path) else { throw failure("Proof directory already exists") }
        try FileManager.default.createDirectory(at: live, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let receipt: [String: Any] = ["schema": 1, "runID": runID.uuidString, "appKey": appKey, "uid": getuid(), "evidenceDirectory": proof.path, "liveDirectory": live.path, "createdAt": timestamp(), "retention": "Fresh isolated test directory retained for inspection; never replaces the user's library or launchers"]
        try writeJSON(receipt, to: proof.appendingPathComponent("live-artifacts-receipt.json"))
        try writeJSON(receipt, to: live.appendingPathComponent("test-run-receipt.json"))
        return live
    }
    private func integrity(_ app: URL, proof: URL) throws -> [String: Any] {
        guard app.path == "/Applications/Figma.app" else { throw failure("Unexpected integrity target") }
        _ = try command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path], proof: proof)
        let description = try command("/usr/bin/codesign", ["-dv", "--verbose=4", app.path], proof: proof)
        var hashes: [String: String] = [:]
        for file in ["Contents/Info.plist", "Contents/MacOS/Figma", "Contents/Resources/app.asar", "Contents/_CodeSignature/CodeResources"] {
            let output = try command("/usr/bin/shasum", ["-a", "256", app.appendingPathComponent(file).path], proof: proof)
            hashes[file] = String(data: output, encoding: .utf8)?.split(separator: " ").first.map(String.init)
        }
        return ["signatureDescription": String(data: description, encoding: .utf8) ?? "", "resourceSHA256": hashes]
    }
    private func sourceHashes(_ folder: URL) throws -> [String: String] {
        try Dictionary(uniqueKeysWithValues: ["manifest.json", "styles.css", "main.js"].map {
            ($0, SHA256.hash(data: try Data(contentsOf: folder.appendingPathComponent($0))).map { String(format: "%02x", $0) }.joined())
        })
    }
    private func stopOwnedHelper(_ url: URL) async throws {
        let candidates = NSRunningApplication.runningApplications(withBundleIdentifier: helperID).filter { $0.bundleURL?.path == url.path }
        guard candidates.count <= 1 else { throw failure("Multiple proof helpers; none was stopped") }
        guard let app = candidates.first else { return }
        let pid = app.processIdentifier, original = RuntimeProcessIdentity.processRecord(processIdentifier: app.processIdentifier)
        guard original.status == "ok", original.uid == getuid(), original.started != nil,
              original.executable == Bundle(url: url)?.executableURL?.path else { throw failure("Proof helper identity uncertain; it was not stopped") }
        guard app.terminate() else { throw failure("Proof helper refused normal quit") }
        let _: Bool = try await wait("proof helper normal exit", timeout: 30) {
            let fresh = RuntimeProcessIdentity.processRecord(processIdentifier: pid)
            if RuntimeProcessIdentity.hasDefinitelyExited(processIdentifier: pid) { return true }
            if fresh.status == "ok", let started = fresh.started, started != original.started { return true }
            return nil
        }
    }
    private func command(_ executable: String, _ arguments: [String], proof: URL) throws -> Data {
        commandNumber += 1
        let file = proof.appendingPathComponent("command-\(commandNumber).log")
        FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let handle = try FileHandle(forWritingTo: file); defer { try? handle.close() }
        let process = Process(); process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
        process.standardInput = FileHandle.nullDevice; process.standardOutput = handle; process.standardError = handle
        try process.run()
        let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 40, execute: timeout)
        process.waitUntilExit(); timeout.cancel()
        let data = try RuntimeBoundedFile.read(file, maximumBytes: 1024 * 1024) ?? Data()
        guard process.terminationStatus == 0 else { throw failure("Proof command failed: \(String(data: data, encoding: .utf8)?.prefix(1500) ?? "No output")") }
        return data
    }
    private func wait<T>(_ label: String, timeout: TimeInterval, condition: () throws -> T?) async throws -> T {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let result = try condition() { return result }
            try await Task.sleep(for: .milliseconds(250))
        } while Date() < deadline
        throw failure("Timed out waiting for \(label)")
    }
    private func json(_ file: URL, limit: Int = 64 * 1024) throws -> [String: Any] {
        guard let data = try RuntimeBoundedFile.read(file, maximumBytes: limit),
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw failure("Missing or invalid \(file.lastPathComponent)") }
        return value
    }
    private func plist(_ file: URL) throws -> [String: Any] {
        try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: file), options: [], format: nil) as? [String: Any])
    }
    private func writeJSON(_ value: [String: Any], to file: URL) throws {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .prettyPrinted]).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
    private func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw failure(message) }; checks.append(message)
    }
    private func timestamp() -> String { ISO8601DateFormatter().string(from: Date()) }
    private func failure(_ message: String) -> NSError {
        NSError(domain: "ExtensionsAnywhere.NativeFigmaProof", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
