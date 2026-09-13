import AppKit
import Darwin
import Dispatch
import Foundation
import RuntimeCatalog

private struct Configuration: Decodable {
    let schemaVersion: Int
    let profile: String?
    let targetBundlePath: String
    let targetBundleIdentifier: String
    let libraryPath: String
    let nodePath: String
    let brokerPath: String
    let sessionsPath: String

    var fixedProfile: LauncherProfile? {
        // Legacy Style Lab configurations predate the explicit profile field.
        let selected = profile.flatMap(LauncherProfile.init(rawValue:)) ?? (profile == nil ? .stylelab : nil)
        guard let selected, targetBundlePath == selected.targetPath,
              targetBundleIdentifier == selected.targetIdentifier,
              URL(fileURLWithPath: brokerPath).lastPathComponent == selected.brokerFilename else { return nil }
        return selected
    }
}

private enum LauncherProfile: Equatable {
    case stylelab, chatgpt, claude
    case catalog(RuntimeAppDefinition)
    init?(rawValue: String) {
        if rawValue == "stylelab" { self = .stylelab }
        else if rawValue == "chatgpt" { self = .chatgpt }
        else if rawValue == "claude" { self = .claude }
        else if let entry = RuntimeAppCatalog.entries.first(where: { $0.slug == rawValue }) { self = .catalog(entry) }
        else { return nil }
    }
    var rawValue: String {
        switch self { case .stylelab: "stylelab"; case .chatgpt: "chatgpt"; case .claude: "claude"; case .catalog(let app): app.slug }
    }
    var name: String {
        switch self { case .stylelab: "Style Lab"; case .chatgpt: "ChatGPT"; case .claude: "Claude"; case .catalog(let app): app.name }
    }
    var targetPath: String {
        switch self { case .catalog(let app): app.bundlePath; default: "/Applications/\(name).app" }
    }
    var targetIdentifier: String {
        switch self { case .stylelab: "dev.extensionsanywhere.stylelab"; case .chatgpt: "com.openai.codex"; case .claude: RuntimeExtensionSelection.claudeIdentifier; case .catalog(let app): app.bundleIdentifier }
    }
    var helperIdentifier: String { "dev.extensionsanywhere.launcher.\(rawValue)" }
    var brokerFilename: String {
        switch self { case .stylelab: "dock-fixture-session.mjs"; case .chatgpt: "dock-chatgpt-session.mjs"; case .claude: "dock-claude-session.mjs"; case .catalog: "dock-catalog-session.mjs" }
    }
    var brokerArguments: [String] {
        switch self { case .stylelab: ["--installed-fixture"]; case .chatgpt, .claude: []; case .catalog(let app): ["--app", app.slug] }
    }
    var sourcePolicy: RuntimeExtensionSelection.Policy {
        switch self {
        case .stylelab: .styleLabMixed
        case .chatgpt: .chatgptMixed
        case .claude: .claudeMixed
        case .catalog(let app): RuntimeExtensionSelection.catalogPolicy(for: app)
        }
    }
}

@MainActor
final class LauncherDelegate: NSObject, NSApplicationDelegate {
    private var configuration: Configuration?
    private var child: Process?
    private var output: URL?
    private var log: FileHandle?
    private var monitor: Task<Void, Never>?
    private var restartTask: Task<Void, Never>?
    private var restartAlert: NSAlert?
    private let restartService = RuntimeLauncherRestartService()
    private let sessionRetention = RuntimeSessionRetention()
    private var signalSources: [DispatchSourceSignal] = []
    private var activated = false
    private var isQuitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        installSignalHandlers()
        do { try launch() }
        catch { fail(error.localizedDescription) }
    }

    private func installSignalHandlers() {
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in
                Task { @MainActor in self?.requestQuit() }
            }
            signalSources.append(source)
            source.resume()
        }
    }

    private func launch(allowRestartPrompt: Bool = true, expectedProfile: LauncherProfile? = nil) throws {
        guard !isQuitting else { throw CancellationError() }
        let directory = Bundle.main.bundleURL.deletingLastPathComponent()
        let config = try JSONDecoder().decode(Configuration.self, from: RuntimeLauncherConfigurationFiles.read(in: directory))
        guard config.schemaVersion == 1, let profile = config.fixedProfile,
              expectedProfile == nil || profile == expectedProfile,
              Bundle.main.bundleIdentifier == profile.helperIdentifier,
              [config.libraryPath, config.nodePath, config.brokerPath, config.sessionsPath].allSatisfy({ ($0 as NSString).isAbsolutePath }),
              URL(fileURLWithPath: config.targetBundlePath).standardizedFileURL.resolvingSymlinksInPath().path == config.targetBundlePath,
              Bundle(path: config.targetBundlePath)?.bundleIdentifier == config.targetBundleIdentifier else {
            throw failure("The Electron launch configuration is invalid.")
        }
        let sessionsDirectory = try RuntimeLauncherConfigurationFiles.sessionsDirectory(config.sessionsPath, launcherDirectory: directory)
        guard let resources = Bundle.main.resourceURL else { throw failure("The launcher's packaged runtime is missing.") }
        let brokerURL = try RuntimeResourceFiles.brokerURL(in: resources, filename: profile.brokerFilename)
        // Old configuration files can contain a build-host Node path. A refreshed
        // launcher always uses its own sealed runtime, including before config migration.
        let nodeURL = try RuntimeResourceFiles.nativeExecutable(in: resources, filename: "node")
        _ = try RuntimeResourceFiles.nativeExecutable(in: resources, filename: "ProcessIdentity")
        guard config.brokerPath == brokerURL.path else {
            throw failure("The broker must be the fixed entry point inside this launcher's packaged runtime. Prepare the shortcut again.")
        }
        let runtimeRoot = resources.appendingPathComponent("Runtime", isDirectory: true)
        _ = try RuntimeResourceFiles.digest(in: runtimeRoot)
        configuration = config
        let libraryURL = URL(fileURLWithPath: config.libraryPath)
        guard let libraryData = try RuntimeBoundedFile.read(libraryURL, maximumBytes: RuntimeExtensionSelection.maximumLibraryBytes) else {
            throw failure("The extension library is invalid or exceeds 64 MiB.")
        }
        let selection = try RuntimeExtensionSelection.decodeLibrary(libraryData,
            targetIdentifier: config.targetBundleIdentifier, policy: profile.sourcePolicy)
        if !selection.hasContent {
            let options = NSWorkspace.OpenConfiguration()
            options.allowsRunningApplicationSubstitution = false
            NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: config.targetBundlePath), configuration: options) { _, error in
                Task { @MainActor in
                    if let error { self.fail(error.localizedDescription) }
                    else { self.finish() }
                }
            }
            return
        }
        guard let restartTarget = RuntimeRestartTarget(profile: profile.rawValue),
              restartTarget.bundleURL.path == config.targetBundlePath,
              restartTarget.bundleIdentifier == config.targetBundleIdentifier else {
            throw failure("The fixed restart profile is invalid.")
        }
        if let selected = try restartService.selectedProcess(for: restartTarget), restartTarget.requiresColdStart {
            guard allowRestartPrompt else { throw RuntimeLauncherRestartError.ambiguousApp }
            confirmRestart(profile: profile, target: restartTarget, selected: selected)
            return
        }
        let session = sessionsDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: session, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // Ownership is opt-in for newly created directories. Maintenance never
        // adopts legacy sessions or blocks launching if inspection is uncertain.
        try? sessionRetention.markCreated(session, launcherIdentifier: profile.helperIdentifier)
        _ = try? sessionRetention.prune(in: sessionsDirectory, launcherIdentifier: profile.helperIdentifier, excluding: session)
        output = session
        let pointer = try JSONSerialization.data(withJSONObject: ["path": session.path], options: [.sortedKeys])
        try pointer.write(to: directory.appendingPathComponent("latest-session.json"), options: .atomic)
        let logURL = session.appendingPathComponent("launcher.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let log = try FileHandle(forWritingTo: logURL)
        self.log = log
        let process = Process()
        process.executableURL = nodeURL
        process.arguments = [brokerURL.path, "--library", config.libraryPath, "--output", session.path] + profile.brokerArguments
        process.currentDirectoryURL = runtimeRoot
        // Do not inherit checkout-specific preloads or module search paths.
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "NODE_OPTIONS")
        environment.removeValue(forKey: "NODE_PATH")
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = log
        process.standardError = log
        process.terminationHandler = { [weak self] process in
            let status = process.terminationStatus
            Task { @MainActor in self?.didExit(status) }
        }
        try process.run()
        child = process
        try? sessionRetention.markBroker(session, launcherIdentifier: profile.helperIdentifier, brokerPID: process.processIdentifier)
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                self?.activateTargetIfReady()
                try? await Task.sleep(for: .milliseconds(300))
            }
        }
    }

    private func confirmRestart(profile: LauncherProfile, target: RuntimeRestartTarget, selected: RuntimeRestartProcess) {
        let alert = NativeRestartAlert.make(appName: profile.name, context: .alreadyRunning)
        restartAlert = alert
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        restartAlert = nil
        guard !isQuitting, response == .alertFirstButtonReturn else {
            finish()
            return
        }
        restartTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.restartService.restart(target: target, selected: selected) {
                    guard !self.isQuitting else { throw CancellationError() }
                    // The library/configuration/runtime may have changed while
                    // the app was quitting. Validate everything again.
                    try self.launch(allowRestartPrompt: false, expectedProfile: profile)
                }
                self.restartTask = nil
            } catch {
                self.restartTask = nil
                if error is CancellationError || self.isQuitting { self.finish() }
                else { self.fail(error.localizedDescription) }
            }
        }
    }

    private func status() -> [String: Any]? {
        guard let output, let data = try? Data(contentsOf: output.appendingPathComponent("status.json")) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func activateTargetIfReady(force: Bool = false) {
        guard force || !activated, let config = configuration, let status = status(),
              let phase = status["phase"] as? String,
              ["active", "disabled"].contains(phase) ||
                (config.fixedProfile == .claude && ["waiting-for-debugger", "waiting-for-page"].contains(phase)),
              let pid = status["pid"] as? Int32,
              let target = NSRunningApplication(processIdentifier: pid),
              target.bundleIdentifier == config.targetBundleIdentifier,
              target.bundleURL?.standardizedFileURL.path == config.targetBundlePath else { return }
        target.activate(options: [])
        activated = true
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        activateTargetIfReady(force: true)
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        restartTask?.cancel()
        if restartAlert != nil { NSApp.abortModal() }
        if let child, child.isRunning {
            requestQuit()
            return .terminateCancel
        }
        isQuitting = true
        return .terminateNow
    }

    private func requestQuit() {
        restartTask?.cancel()
        if restartAlert != nil { NSApp.abortModal() }
        if let child, child.isRunning {
            guard !isQuitting else { return }
            let brokerPID = child.processIdentifier
            guard brokerPID > 0 else { return }
            isQuitting = true
            // Process.terminate() also signals subtasks on macOS. The broker
            // must remove CSS before it stops its own Electron child.
            if Darwin.kill(brokerPID, SIGTERM) == -1 {
                let code = errno
                if code != ESRCH {
                    isQuitting = false
                    let message = "Could not signal owned broker \(brokerPID): errno \(code).\n"
                    try? log?.write(contentsOf: Data(message.utf8))
                }
            }
        } else {
            isQuitting = true
            finish()
        }
    }

    private func didExit(_ exitCode: Int32) {
        monitor?.cancel()
        child = nil
        try? log?.close()
        if let output, let profile = configuration?.fixedProfile {
            try? sessionRetention.markClosed(output, launcherIdentifier: profile.helperIdentifier)
        }
        if exitCode != 0 && !isQuitting {
            let error = status()?["error"] as? String ?? "The Electron launcher stopped (\(exitCode)). See \(output?.path ?? "the session logs")."
            fail(error)
        } else { finish() }
    }

    private func finish() { NSApp.terminate(nil) }
    private func fail(_ message: String) {
        guard !isQuitting else { finish(); return }
        let alert = NSAlert()
        alert.messageText = "Couldn't launch \(configuration?.fixedProfile?.name ?? "the app")"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
        finish()
    }
    private func failure(_ message: String) -> NSError { NSError(domain: "ExtensionsAnywhere.Launcher", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}

@main
struct LauncherMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = LauncherDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
