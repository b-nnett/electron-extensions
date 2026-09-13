// Local installer verification only. Never included in the production app.
// This process is Sparkle's applicationBundle; the signed copy is only hostBundle.
import AppKit
import CryptoKit
import Foundation
import Security
import Sparkle

enum HarnessFailure: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let text) = self { return text }; return nil }
}

enum HarnessPaths {
    static let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
    static let root = repository.appendingPathComponent("output/release-review/2026-09-13/updater-install-test")
    static let host = root.appendingPathComponent("Host/Extensions Anywhere.app")
    static let application = root.appendingPathComponent("Sparkle Install Harness.app")
    static let baseline = repository.appendingPathComponent("output/release-review/2026-09-13/notarization/build-2/Extensions Anywhere.app")
    static let expected = repository.appendingPathComponent("output/release-review/2026-09-13/notarization/build-3/Extensions Anywhere.app")
    static let feed = "http://127.0.0.1:8767/appcast.xml"
    static let identifier = "dev.extensions-anywhere.app"
    static let publicKey = "sek+Mp0TedaOAi0QoQA1luAcjgXWnXDQW6pbjnCVyy8="

    static func checkPath(_ url: URL) throws {
        guard url.path == url.standardizedFileURL.path,
              url.path == url.resolvingSymlinksInPath().path,
              url.path.hasPrefix(repository.appendingPathComponent("output").path + "/") else {
            throw HarnessFailure.invalid("Refusing an unexpected or symlinked test path: \(url.path)")
        }
    }

    static func checkNoManager() throws {
        guard NSWorkspace.shared.runningApplications.allSatisfy({ $0.bundleIdentifier != identifier }) else {
            throw HarnessFailure.invalid("Quit Extensions Anywhere normally before this test. Its updater preferences must not change concurrently.")
        }
    }

    static func validateBundle(_ path: URL, version: String) throws -> [String: String] {
        try checkPath(path)
        let infoURL = path.appendingPathComponent("Contents/Info.plist")
        let info = try PropertyListSerialization.propertyList(from: Data(contentsOf: infoURL), format: nil) as? [String: Any]
        guard info?["CFBundleIdentifier"] as? String == identifier,
              info?["CFBundleVersion"] as? String == version,
              info?["CFBundleExecutable"] as? String == "ExtensionsAnywhere",
              info?["SUPublicEDKey"] as? String == publicKey,
              info?["SURequireSignedFeed"] as? Bool == true,
              info?["SUVerifyUpdateBeforeExtraction"] as? Bool == true,
              info?["SUFeedURL"] as? String == "https://github.com/b-nnett/electron-extensions/releases/latest/download/appcast.xml" else {
            throw HarnessFailure.invalid("Unexpected host identity, version, or signed updater configuration.")
        }
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(path as CFURL, SecCSFlags(), &code) == errSecSuccess, let code else {
            throw HarnessFailure.invalid("Cannot read the host signature.")
        }
        var requirement: SecRequirement?
        let expression = "anchor apple generic and identifier \"dev.extensions-anywhere.app\" and certificate leaf[subject.OU] = \"X522N436T7\""
        guard SecRequirementCreateWithString(expression as CFString, SecCSFlags(), &requirement) == errSecSuccess,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate), requirement) == errSecSuccess else {
            throw HarnessFailure.invalid("The host is not an intact app signed by the expected Developer ID team.")
        }
        let executable = path.appendingPathComponent("Contents/MacOS/ExtensionsAnywhere")
        let hash = SHA256.hash(data: try Data(contentsOf: executable)).map { String(format: "%02x", $0) }.joined()
        return ["path": path.path, "build": version, "executableSHA256": hash, "team": "X522N436T7", "signature": "valid"]
    }
}

enum Evidence {
    static let stateURL = HarnessPaths.root.appendingPathComponent("state.json")
    static let resultURL = HarnessPaths.root.appendingPathComponent("installation-result.json")
    static func write(_ value: Any, to url: URL) throws {
        try HarnessPaths.checkPath(url)
        let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    static func writeResultOnce(_ value: Any) throws {
        try HarnessPaths.checkPath(resultURL)
        let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: resultURL, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: resultURL.path)
    }
    static func state() throws -> [String: Any]? {
        guard FileManager.default.fileExists(atPath: stateURL.path) else { return nil }
        try HarnessPaths.checkPath(stateURL)
        guard let state = try JSONSerialization.jsonObject(with: Data(contentsOf: stateURL)) as? [String: Any] else {
            throw HarnessFailure.invalid("Invalid harness state.")
        }
        return state
    }
    static func event(_ name: String, fields: [String: Any] = [:]) {
        var record = fields
        record["event"] = name
        record["time"] = ISO8601DateFormatter().string(from: Date())
        record["pid"] = ProcessInfo.processInfo.processIdentifier
        try? write(record, to: HarnessPaths.root.appendingPathComponent("event-\(name).json"))
    }
}

// Exact mutable host-domain keys found in vendored Sparkle 2.9.6. Never restore
// the whole preferences domain, reset cfprefsd, or touch the extension library.
enum SparklePreferences {
    static let keys = ["SUEnableAutomaticChecks", "SUScheduledCheckInterval", "SUAutomaticallyUpdate",
        "SUSendProfileInfo", "SUHasLaunchedBefore", "SULastCheckTime", "SUFeedURL",
        "SULastProfileSubmissionDate", "SUUpdateGroupIdentifier", "SUSkippedVersion",
        "SUSkippedMajorVersion", "SUSkippedMajorSubreleaseVersion"]
    static let snapshotURL = HarnessPaths.root.appendingPathComponent("sparkle-preferences-before.plist")
    static func snapshot() throws {
        try HarnessPaths.checkNoManager()
        try HarnessPaths.checkPath(snapshotURL)
        guard !FileManager.default.fileExists(atPath: snapshotURL.path) else {
            throw HarnessFailure.invalid("An earlier preference snapshot exists; restore it before preparing another test.")
        }
        guard let defaults = UserDefaults(suiteName: HarnessPaths.identifier) else {
            throw HarnessFailure.invalid("Cannot access the updater preferences domain.")
        }
        let domain = defaults.persistentDomain(forName: HarnessPaths.identifier) ?? [:]
        let values = domain.filter { keys.contains($0.key) }
        let snapshot: [String: Any] = ["domain": HarnessPaths.identifier, "keys": keys, "values": values]
        let data = try PropertyListSerialization.data(fromPropertyList: snapshot, format: .xml, options: 0)
        try data.write(to: snapshotURL, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: snapshotURL.path)
    }
    static func restore() throws {
        guard FileManager.default.fileExists(atPath: snapshotURL.path) else { return }
        try HarnessPaths.checkNoManager()
        try HarnessPaths.checkPath(snapshotURL)
        let data = try Data(contentsOf: snapshotURL)
        guard data.count < 64 * 1024,
              let snapshot = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              snapshot["domain"] as? String == HarnessPaths.identifier,
              snapshot["keys"] as? [String] == keys,
              let values = snapshot["values"] as? [String: Any],
              Set(values.keys).isSubset(of: Set(keys)),
              let defaults = UserDefaults(suiteName: HarnessPaths.identifier) else {
            throw HarnessFailure.invalid("Refusing an invalid preference snapshot.")
        }
        for key in keys {
            if let value = values[key] { defaults.set(value, forKey: key) }
            else { defaults.removeObject(forKey: key) }
        }
        guard defaults.synchronize() else { throw HarnessFailure.invalid("Updater preferences did not synchronize.") }
        let after = (defaults.persistentDomain(forName: HarnessPaths.identifier) ?? [:]).filter { keys.contains($0.key) }
        guard NSDictionary(dictionary: after).isEqual(to: values) else {
            throw HarnessFailure.invalid("Updater preference restoration did not verify.")
        }
        Evidence.event("preferences-restored", fields: ["keys": keys, "verified": true])
    }
}

@MainActor
final class HarnessDelegate: NSObject, NSApplicationDelegate, SPUUpdaterDelegate {
    private var updater: SPUUpdater?
    private var userDriver: SPUStandardUserDriver?
    private var state: [String: Any] = [:]
    private var ownsPreferenceRestoration = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            guard Bundle.main.bundleURL.path == HarnessPaths.application.path,
                  Bundle.main.bundleIdentifier == "dev.extensions-anywhere.sparkle-install-harness" else {
                throw HarnessFailure.invalid("Run only the generated test harness at its fixed output path.")
            }
            try HarnessPaths.checkPath(Bundle.main.bundleURL)
            if FileManager.default.fileExists(atPath: Evidence.resultURL.path) {
                // A subsequent Finder/CUA launch is not another Sparkle relaunch.
                // Preserve the first receipt and do not restore stale preferences.
                showPreviouslyCompletedTest()
                return
            }
            try HarnessPaths.checkNoManager()
            if let prior = try Evidence.state() {
                state = prior
                try verifyRelaunch(prior)
                return
            }
            let before = try HarnessPaths.validateBundle(HarnessPaths.host, version: "2")
            let baseline = try HarnessPaths.validateBundle(HarnessPaths.baseline, version: "2")
            let expected = try HarnessPaths.validateBundle(HarnessPaths.expected, version: "3")
            guard before["executableSHA256"] == baseline["executableSHA256"] else {
                throw HarnessFailure.invalid("The install target is not an intact copy of build 2.")
            }
            let prompt = NSAlert()
            prompt.messageText = "Test the local Sparkle installer?"
            prompt.informativeText = "Only the signed app copy under output will be replaced. Sparkle will restart this harness; Extensions Anywhere will never launch. Its updater preference keys are backed up and restored. Click through Sparkle’s own update prompts to install build 3."
            prompt.addButton(withTitle: "Check for Updates")
            prompt.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            guard prompt.runModal() == .alertFirstButtonReturn else { NSApp.terminate(nil); return }
            try HarnessPaths.checkNoManager()
            try SparklePreferences.snapshot()
            ownsPreferenceRestoration = true
            state = ["schema": 1, "before": before, "expected": expected,
                "initialPID": ProcessInfo.processInfo.processIdentifier,
                "startedAt": ISO8601DateFormatter().string(from: Date()),
                "applicationBundle": HarnessPaths.application.path, "feed": HarnessPaths.feed]
            try Evidence.write(state, to: Evidence.stateURL)
            guard let host = Bundle(url: HarnessPaths.host) else { throw HarnessFailure.invalid("Cannot load the signed host bundle.") }
            let driver = SPUStandardUserDriver(hostBundle: host, delegate: nil)
            let controller = SPUUpdater(hostBundle: host, applicationBundle: Bundle.main, userDriver: driver, delegate: self)
            userDriver = driver
            updater = controller
            try controller.start()
            // Supported immediate user-initiated check, before the scheduled startup cycle.
            controller.checkForUpdates()
        } catch { fail(error) }
    }

    func feedURLString(for updater: SPUUpdater) -> String? { HarnessPaths.feed }

    func updater(_ updater: SPUUpdater, shouldProceedWithUpdate item: SUAppcastItem, updateCheck: SPUUpdateCheck) throws {
        try HarnessPaths.checkNoManager()
        guard item.versionString == "3", let url = item.fileURL,
              url.scheme == "http", url.host == "127.0.0.1", url.port == 8767,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.pathExtension == "zip", item.infoURL == nil else {
            throw HarnessFailure.invalid("Only the signed build 3 ZIP on the fixed loopback server is accepted.")
        }
        Evidence.event("update-selected", fields: ["version": item.versionString, "archive": url.absoluteString])
    }

    func updater(_ updater: SPUUpdater, shouldDownloadReleaseNotesForUpdate item: SUAppcastItem) -> Bool { false }

    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        Evidence.event("will-install", fields: ["version": item.versionString])
    }

    func updaterWillRelaunchApplication(_ updater: SPUUpdater) {
        state["sparkleRequestedRelaunch"] = true
        state["relaunchRequestedAt"] = ISO8601DateFormatter().string(from: Date())
        try? Evidence.write(state, to: Evidence.stateURL)
        Evidence.event("will-relaunch-harness")
    }

    func applicationWillTerminate(_ notification: Notification) {
        guard ownsPreferenceRestoration else { return }
        do { try SparklePreferences.restore() }
        catch { Evidence.event("preference-restore-error", fields: ["error": error.localizedDescription]) }
    }

    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        Evidence.event("update-aborted", fields: ["error": error.localizedDescription])
    }

    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        Evidence.event("update-cycle-finished", fields: ["error": error?.localizedDescription ?? NSNull()])
        // A completed update cycle is not proof of installation; only verifyRelaunch is.
        do { try SparklePreferences.restore() }
        catch { Evidence.event("preference-restore-error", fields: ["error": error.localizedDescription]) }
    }

    private func verifyRelaunch(_ prior: [String: Any]) throws {
        guard prior["sparkleRequestedRelaunch"] as? Bool == true,
              let initialPID = prior["initialPID"] as? Int,
              initialPID != Int(ProcessInfo.processInfo.processIdentifier),
              let expected = prior["expected"] as? [String: String] else {
            throw HarnessFailure.invalid("An unfinished test exists. No successful installation is claimed; inspect state.json and restore preferences before retrying.")
        }
        ownsPreferenceRestoration = true
        let installed = try HarnessPaths.validateBundle(HarnessPaths.host, version: "3")
        guard installed["executableSHA256"] == expected["executableSHA256"] else {
            throw HarnessFailure.invalid("The replacement does not match the signed build 3 executable.")
        }
        let baseline = try HarnessPaths.validateBundle(HarnessPaths.baseline, version: "2")
        guard let before = prior["before"] as? [String: String],
              before["executableSHA256"] == baseline["executableSHA256"] else {
            throw HarnessFailure.invalid("The immutable build 2 baseline changed.")
        }
        try SparklePreferences.restore()
        ownsPreferenceRestoration = false
        try Evidence.writeResultOnce(["result": "signed-copy-replaced-and-harness-restarted", "installed": installed,
            "initialPID": initialPID, "restartedPID": ProcessInfo.processInfo.processIdentifier,
            "managerWasLaunched": false, "productionFeedWasTested": false,
            "preferencesRestored": true, "recordedAt": ISO8601DateFormatter().string(from: Date())])
        let alert = NSAlert()
        alert.messageText = "Signed build 3 installed"
        alert.informativeText = "Sparkle replaced the test copy, and this harness started again with a new process ID. The signature, build number, and expected executable hash passed. The original build 2 is intact and updater preferences were restored. Extensions Anywhere itself was not launched."
        alert.addButton(withTitle: "Done")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
        NSApp.terminate(nil)
    }

    private func showPreviouslyCompletedTest() {
        let alert = NSAlert()
        alert.messageText = "This installer test is already complete"
        alert.informativeText = "The saved installation receipt is unchanged. This launch does not run the updater, restore preferences, or create another restart receipt. Read installation-result.json for the recorded result."
        alert.addButton(withTitle: "Done")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
        NSApp.terminate(nil)
    }

    private func fail(_ error: Error) {
        Evidence.event("harness-error", fields: ["error": error.localizedDescription])
        if ownsPreferenceRestoration { try? SparklePreferences.restore() }
        let alert = NSAlert()
        alert.messageText = "Installer test stopped"
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
        NSApp.terminate(nil)
    }
}

if CommandLine.arguments.contains("--restore-preferences") {
    do { try SparklePreferences.restore(); print("Sparkle preference restoration verified.") }
    catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
} else {
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        let delegate = HarnessDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}
