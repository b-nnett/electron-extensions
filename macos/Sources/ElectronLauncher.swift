import AppKit
import CryptoKit
import Foundation
import Darwin
import RuntimeCatalog

enum ElectronLaunchError: LocalizedError {
    case unavailable, staleApp, missingRuntime, unsupportedSource, cssTooLarge, emptyCSS, shortcut(String)
    case runtimeUpgradeRequired(String)
    var errorDescription: String? {
        switch self {
        case .unavailable: "A launch adapter is not configured for this Electron app yet."
        case .staleApp: "The selected app moved or changed. Refresh the app library and try again."
        case .missingRuntime: "Build Extensions Anywhere again to restore its development launcher."
        case .unsupportedSource: "This launch profile supports CSS extensions only."
        case .cssTooLarge: "Enabled stylesheets must total 64 KiB or less."
        case .emptyCSS: "Add a nonempty stylesheet before launching with a tweak."
        case .runtimeUpgradeRequired(let appName): "The running \(appName) extension launcher needs an update before it can run JavaScript. Quit \(appName) and its extension launcher normally, then use Open App to update the launcher. Enable this extension afterward. Your current extension preferences were preserved."
        case .shortcut(let message): message
        }
    }
}

/// App-specific capabilities are explicit: Electron detection alone is not proof
/// that a particular release accepts debugging flags.
enum ElectronLaunchProfile {
    static let fixtureKey = "dev.extensionsanywhere.stylelab"
    static let fixtureURL = URL(fileURLWithPath: "/Applications/Style Lab.app", isDirectory: true)
    static let fixtureArguments = ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"]
    static let chatgptKey = "com.openai.codex"
    static let chatgptURL = URL(fileURLWithPath: "/Applications/ChatGPT.app", isDirectory: true)
    static let claudeKey = RuntimeExtensionSelection.claudeIdentifier
    static let claudeURL = URL(fileURLWithPath: "/Applications/Claude.app", isDirectory: true)

    enum Profile: Hashable, Sendable {
        case stylelab, chatgpt, claude
        case catalog(RuntimeAppDefinition)
        var rawValue: String {
            switch self { case .stylelab: "stylelab"; case .chatgpt: "chatgpt"; case .claude: "claude"; case .catalog(let app): app.slug }
        }
        var targetIdentifier: String {
            switch self { case .stylelab: fixtureKey; case .chatgpt: chatgptKey; case .claude: claudeKey; case .catalog(let app): app.bundleIdentifier }
        }
        var targetURL: URL {
            switch self { case .stylelab: fixtureURL; case .chatgpt: chatgptURL; case .claude: claudeURL; case .catalog(let app): URL(fileURLWithPath: app.bundlePath) }
        }
        var executable: String {
            switch self {
            case .stylelab: fixtureURL.appendingPathComponent("Contents/MacOS/Style Lab").path
            case .chatgpt: chatgptURL.appendingPathComponent("Contents/MacOS/ChatGPT").path
            case .claude: claudeURL.appendingPathComponent("Contents/MacOS/Claude").path
            case .catalog(let app): app.executable
            }
        }
        var launcherIdentifier: String { "dev.extensionsanywhere.launcher.\(rawValue)" }
        var brokerEnvironmentKey: String {
            switch self { case .stylelab: "brokerPath"; case .chatgpt: "chatgptBrokerPath"; case .claude: "claudeBrokerPath"; case .catalog: "catalogBrokerPath" }
        }
        var brokerFilename: String {
            switch self { case .stylelab: "dock-fixture-session.mjs"; case .chatgpt: "dock-chatgpt-session.mjs"; case .claude: "dock-claude-session.mjs"; case .catalog: "dock-catalog-session.mjs" }
        }
        var sourcePolicy: RuntimeExtensionSelection.Policy {
            switch self {
            case .stylelab: .styleLabMixed
            case .chatgpt: .chatgptMixed
            case .claude: .claudeMixed
            case .catalog(let app): RuntimeExtensionSelection.catalogPolicy(for: app)
            }
        }
        var supportsJavaScript: Bool { sourcePolicy != .cssOnly }
        var assistedSetupInstructions: String? { RuntimeRestartTarget(profile: rawValue)?.assistedSetupInstructions }
    }

    static func profile(for app: InstalledApp) -> Profile? {
        guard app.url.isFileURL else { return nil }
        let canonical = app.url.standardizedFileURL.resolvingSymlinksInPath().path
        return ([Profile.stylelab, .chatgpt, .claude] + RuntimeAppCatalog.entries.map(Profile.catalog)).first {
            app.bundleIdentifier == $0.targetIdentifier && canonical == $0.targetURL.path
        }
    }

    static func supports(_ app: InstalledApp) -> Bool {
        profile(for: app) != nil
    }

    static func validate(records: [ExtensionRecord]) throws {
        // Compatibility without a selected app never infers JS from stored IDs.
        // Real app paths use the explicitly selected profile overload.
        let targetIdentifier = records.first?.appKey ?? "css-only-validation"
        guard records.allSatisfy({ $0.appKey == targetIdentifier }) else { throw RuntimeExtensionSelection.ValidationError.invalidRecord }
        _ = try RuntimeExtensionSelection.select(records: sourceRecords(records), targetIdentifier: targetIdentifier, policy: .cssOnly)
    }

    static func validate(records: [ExtensionRecord], for profile: Profile) throws {
        _ = try RuntimeExtensionSelection.select(records: sourceRecords(records), targetIdentifier: profile.targetIdentifier, policy: profile.sourcePolicy)
    }

    static func validate(records: [ExtensionRecord], app: InstalledApp) throws {
        guard let profile = profile(for: app) else { throw ElectronLaunchError.unavailable }
        try validate(records: records, for: profile)
    }

    private static func sourceRecords(_ records: [ExtensionRecord]) -> [RuntimeExtensionSelection.Record] {
        records.map { record in
            RuntimeExtensionSelection.Record(id: record.id.uuidString, appKey: record.appKey, name: record.name,
                isEnabled: record.isEnabled, sourceFileName: record.sourceFileName,
                sourceType: record.sourceType.rawValue, sourceText: record.sourceText,
                sourceFiles: record.sourceFiles?.map { .init(fileName: $0.fileName, type: $0.type.rawValue, text: $0.text) })
        }
    }
}

struct RuntimeSessionSnapshot: Sendable {
    enum Phase: String, Decodable, Sendable {
        case starting, applying, active, disabled, stopping, stopped, error
        case waitingForDebugger = "waiting-for-debugger"
        case waitingForPage = "waiting-for-page"
    }

    struct RunningProcess: Sendable {
        let pid: Int32
        let launchDate: Date?
    }

    let phase: Phase
    let pid: Int32?
    let brokerPid: Int32
    let updatedAt: Date
    let startedAt: Date
    let phaseStartedAt: Date
    let processStartedAt: Date?
    let sessionDirectory: URL
    private let observedProcessMatches: Bool
    private let startupContextMatches: Bool
    private let observedAt: Date
    private let recoverableExtensionFailure: Bool
    private let assistedSetupAllowed: Bool

    var isHealthy: Bool { phase == .active && observedProcessMatches }
    /// A connected script failure needs editing/disabling, not the missing-runtime
    /// restart prompt. It remains an error and never reports healthy extensions.
    var hasRecoverableExtensionFailure: Bool { phase == .error && observedProcessMatches && recoverableExtensionFailure }
    var isWaitingForAssistedSetup: Bool {
        assistedSetupAllowed && observedProcessMatches && (phase == .waitingForDebugger || phase == .waitingForPage)
    }
    var assistedSetupStatus: String? {
        guard isWaitingForAssistedSetup else { return nil }
        return phase == .waitingForDebugger
            ? "Waiting for Claude. Choose Developer → Enable Main Process Debugger in Claude. If the Developer menu is missing, enable Developer Mode from Help → Troubleshooting."
            : "Waiting for Claude’s new-chat page. Open a new chat in Claude to connect extensions."
    }
    var isStarting: Bool {
        (phase == .starting || phase == .applying) && startupContextMatches &&
        observedAt.timeIntervalSince(phaseStartedAt) <= 60
    }

    func matches(processIdentifier: Int32, launchDate: Date?) -> Bool {
        guard pid == processIdentifier, let processStartedAt, let launchDate else { return false }
        return abs(processStartedAt.timeIntervalSince(launchDate)) <= 0.001
    }

    func suppressesMissingRuntimePrompt(processIdentifier: Int32, launchDate: Date?) -> Bool {
        isStarting || ((isHealthy || hasRecoverableExtensionFailure || isWaitingForAssistedSetup) && matches(processIdentifier: processIdentifier, launchDate: launchDate))
    }

    static func validated(
        data: Data, app: InstalledApp, sessionDirectory: URL, now: Date,
        currentProcess: RunningProcess?, brokerIsAlive: (Int32) -> Bool
    ) -> Self? {
        guard data.count <= RuntimeSessionFiles.statusLimit,
              let profile = ElectronLaunchProfile.profile(for: app),
              let payload = try? JSONDecoder().decode(RuntimeStatusPayload.self, from: data),
              payload.appKey == profile.targetIdentifier, payload.bundle == app.url.path,
              payload.brokerPid > 0, payload.pid == nil || payload.pid! > 0,
              let updatedAt = date(payload.updatedAt), updatedAt <= now.addingTimeInterval(1),
              payload.heartbeatVersion == nil || payload.heartbeatVersion == 1,
              payload.heartbeatVersion != 1 || (payload.startedAt != nil && payload.phaseStartedAt != nil) else { return nil }
        var processStartedAt: Date?
        if let identity = payload.processIdentity {
            let expectedExecutable = profile.executable
            guard identity.pid == payload.pid, identity.pid > 0,
                  identity.executable == expectedExecutable, identity.uid == getuid(),
                  identity.started.range(of: #"^[1-9][0-9]*\.[0-9]{6}$"#, options: .regularExpression) != nil,
                  let epoch = Double(identity.started), epoch.isFinite else { return nil }
            processStartedAt = Date(timeIntervalSince1970: epoch)
            guard processStartedAt! <= updatedAt.addingTimeInterval(1) else { return nil }
        } else if payload.pid != nil { return nil }
        let startedAt: Date
        if let value = payload.startedAt {
            guard let parsed = date(value) else { return nil }
            startedAt = parsed
        } else { startedAt = processStartedAt ?? updatedAt }
        let phaseStartedAt: Date
        if let value = payload.phaseStartedAt {
            guard let parsed = date(value) else { return nil }
            phaseStartedAt = parsed
        } else { phaseStartedAt = startedAt }
        guard startedAt <= updatedAt.addingTimeInterval(1),
              phaseStartedAt >= startedAt.addingTimeInterval(-1),
              phaseStartedAt <= updatedAt.addingTimeInterval(1),
              brokerIsAlive(payload.brokerPid) else { return nil }
        let observedMatch = currentProcess.map { current in
            guard current.pid == payload.pid, let launchDate = current.launchDate, let processStartedAt else { return false }
            return abs(processStartedAt.timeIntervalSince(launchDate)) <= 0.001
        } ?? false
        let starting = payload.phase == .starting || payload.phase == .applying
        if payload.heartbeatVersion == 1 {
            let age = now.timeIntervalSince(updatedAt)
            guard age <= 15 || (starting && age <= 60 && now.timeIntervalSince(phaseStartedAt) <= 60) else { return nil }
        } else {
            // Legacy brokers did not heartbeat: only the same still-running app
            // launch plus a live broker can establish a usable legacy session.
            guard observedMatch else { return nil }
        }
        let startupMatch: Bool
        if payload.pid != nil { startupMatch = observedMatch }
        else if let currentProcess {
            startupMatch = currentProcess.launchDate.map { $0 >= startedAt.addingTimeInterval(-0.001) } ?? false
        } else { startupMatch = true }
        return Self(phase: payload.phase, pid: payload.pid, brokerPid: payload.brokerPid,
                    updatedAt: updatedAt, startedAt: startedAt, phaseStartedAt: phaseStartedAt,
                    processStartedAt: processStartedAt, sessionDirectory: sessionDirectory,
                    observedProcessMatches: observedMatch, startupContextMatches: startupMatch, observedAt: now,
                    recoverableExtensionFailure: profile.supportsJavaScript && payload.hasRecoverableExtensionFailure,
                    assistedSetupAllowed: profile == .claude && payload.heartbeatVersion == 1)
    }

    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}

private struct RuntimeStatusPayload: Decodable {
    struct ScriptState: Decodable {
        let extensionID: String
        let revision: String
        let phase: String
        let generation: Int
        let cleanupComplete: Bool
        let reloadBlocked: Bool
    }
    struct Identity: Decodable {
        let pid: Int32
        let executable: String
        let started: String
        let uid: UInt32
    }
    let phase: RuntimeSessionSnapshot.Phase
    let appKey: String
    let bundle: String
    let pid: Int32?
    let brokerPid: Int32
    let updatedAt: String
    let startedAt: String?
    let phaseStartedAt: String?
    let heartbeatVersion: Int?
    let processIdentity: Identity?
    let error: String?
    let jsStates: [ScriptState]?

    var hasRecoverableExtensionFailure: Bool {
        guard phase == .error, heartbeatVersion == 1,
              let jsStates, !jsStates.isEmpty, jsStates.count <= 64,
              jsStates.contains(where: { $0.phase == "failed" }) else { return false }
        var ids = Set<UUID>()
        return jsStates.allSatisfy { state in
            guard let id = UUID(uuidString: state.extensionID), ids.insert(id).inserted,
                  state.generation > 0,
                  state.revision.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"#, options: .regularExpression) != nil else { return false }
            return state.phase == "active" || (state.phase == "failed" && state.cleanupComplete && !state.reloadBlocked)
        }
    }
}

enum RuntimeSessionFiles {
    static let pointerLimit = 4096
    static let statusLimit = 64 * 1024

    static func read(_ url: URL, limit: Int) -> Data? {
        guard url.isFileURL, url.path == url.standardizedFileURL.resolvingSymlinksInPath().path,
              let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue <= limit,
              let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: limit + 1), data.count <= limit else { return nil }
        return data
    }

    static func directory(pointer: Data, launcherDirectory: URL) -> URL? {
        guard pointer.count <= pointerLimit, launcherDirectory.isFileURL,
              let object = try? JSONDecoder().decode([String: String].self, from: pointer),
              let path = object["path"], path.hasPrefix("/"),
              !path.contains(where: { $0 == "\0" || $0 == "\r" || $0 == "\n" }) else { return nil }
        let base = launcherDirectory.standardizedFileURL.resolvingSymlinksInPath()
        let sessions = base.appendingPathComponent("Sessions", isDirectory: true)
        let candidate = URL(fileURLWithPath: path, isDirectory: true)
        guard !base.pathComponents.contains(where: { $0.lowercased().hasSuffix(".app") }),
              candidate.path == candidate.standardizedFileURL.resolvingSymlinksInPath().path,
              candidate.deletingLastPathComponent().path == sessions.path,
              UUID(uuidString: candidate.lastPathComponent) != nil else { return nil }
        return candidate
    }
}

/// Changes only our alias file. The caller explicitly authorizes the one old
/// target; an alias with any other destination is preserved and rejected.
enum RuntimeLauncherAlias {
    @discardableResult
    static func prepare(at alias: URL, target: URL, allowedPreviousTarget: URL? = nil) throws -> URL? {
        let manager = FileManager.default
        let folder = alias.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
        guard alias.isFileURL, target.isFileURL,
              !folder.pathComponents.contains(where: { $0.lowercased().hasSuffix(".app") }) else {
            throw ElectronLaunchError.shortcut("Launcher aliases must be stored outside application bundles.")
        }
        let target = target.standardizedFileURL.resolvingSymlinksInPath()
        let previous = allowedPreviousTarget?.standardizedFileURL.resolvingSymlinksInPath()
        let attributes: [FileAttributeKey: Any]?
        do { attributes = try manager.attributesOfItem(atPath: alias.path) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { attributes = nil }
        var originalData: Data?
        if let attributes {
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  try alias.resourceValues(forKeys: [.isAliasFileKey]).isAliasFile == true else {
                throw ElectronLaunchError.shortcut("The existing launcher shortcut is not a Finder alias. It was preserved.")
            }
            let destination = try resolved(alias)
            if destination.path == target.path { return nil }
            guard let previous, destination.path == previous.path else {
                throw ElectronLaunchError.shortcut("The existing launcher alias points somewhere else. It was preserved.")
            }
            originalData = try Data(contentsOf: alias)
        }
        try manager.createDirectory(at: folder, withIntermediateDirectories: true)
        let temporary = folder.appendingPathComponent(".runtime-alias-\(UUID().uuidString)")
        defer { try? manager.removeItem(at: temporary) }
        let bookmark = try target.bookmarkData(options: .suitableForBookmarkFile, includingResourceValuesForKeys: nil, relativeTo: nil)
        try URL.writeBookmarkData(bookmark, to: temporary)
        guard try resolved(temporary).path == target.path else {
            throw ElectronLaunchError.shortcut("The new launcher alias could not be verified.")
        }
        guard let originalData else {
            try manager.moveItem(at: temporary, to: alias)
            return nil
        }
        guard try Data(contentsOf: alias) == originalData, try resolved(alias).path == previous?.path else {
            throw ElectronLaunchError.shortcut("The existing launcher alias changed during preparation. It was preserved.")
        }
        let newData = try Data(contentsOf: temporary)
        let backupName = ".alias-before-runtime-\(UUID().uuidString)"
        let backup = folder.appendingPathComponent(backupName)
        _ = try manager.replaceItemAt(alias, withItemAt: temporary, backupItemName: backupName,
                                      options: [.usingNewMetadataOnly, .withoutDeletingBackupItem])
        do {
            guard try resolved(alias).path == target.path else {
                throw ElectronLaunchError.shortcut("The migrated launcher alias could not be verified.")
            }
        } catch {
            // Restore only if our just-written alias is still present; preserve
            // any intervening external change and keep the backup otherwise.
            if (try? Data(contentsOf: alias)) == newData {
                _ = try? manager.replaceItemAt(alias, withItemAt: backup, options: .usingNewMetadataOnly)
            }
            throw error
        }
        return backup
    }

    private static func resolved(_ alias: URL) throws -> URL {
        try URL(resolvingAliasFileAt: alias, options: [.withoutUI, .withoutMounting])
            .standardizedFileURL.resolvingSymlinksInPath()
    }
}

@MainActor
struct ElectronLauncher {
    enum RefreshResult: Equatable { case current, updated, deferred, missing }
    private let dock: DockShortcutManager
    private let baseDirectory: URL
    private let refreshDock: () throws -> Void
    private let openURL: (URL) -> Bool
    private let runtimeResources: URL?
    static var supportDirectory: URL {
        ExtensionLibrary.defaultURL.deletingLastPathComponent().appendingPathComponent("Launchers", isDirectory: true)
    }

    init() {
        self.init(supportDirectory: Self.supportDirectory, dock: DockShortcutManager(),
                  refreshDock: DockShortcutManager.restartDock, openURL: { NSWorkspace.shared.open($0) })
    }

    init(supportDirectory: URL, dock: DockShortcutManager, refreshDock: @escaping () throws -> Void,
         openURL: @escaping (URL) -> Bool, runtimeResources: URL? = Bundle.main.resourceURL) {
        baseDirectory = supportDirectory
        self.dock = dock; self.refreshDock = refreshDock; self.openURL = openURL
        self.runtimeResources = runtimeResources
    }

    func directory(for app: InstalledApp) -> URL {
        let hash = SHA256.hash(data: Data(app.url.standardizedFileURL.resolvingSymlinksInPath().path.utf8)).map { String(format: "%02x", $0) }.joined()
        return baseDirectory.appendingPathComponent(hash, isDirectory: true)
    }

    func shortcut(for app: InstalledApp) -> URL { directory(for: app).appendingPathComponent("\(app.name).app") }

    func prepare(app: InstalledApp, libraryURL: URL, records: [ExtensionRecord], existingOnly: Bool = false) throws {
        if existingOnly {
            guard try hasExistingManagedHelper(app: app), !(try isManagedHelperActive(app: app)) else { return }
        }
        try validateSelectedApp(app)
        guard let profile = ElectronLaunchProfile.profile(for: app) else {
            // Generic shortcuts launch the original app normally. Stored source
            // records are not read, validated for execution, or run on this path.
            try prepareOrdinaryAlias(app: app)
            return
        }
        try ElectronLaunchProfile.validate(records: records, for: profile)
        guard let resources = runtimeResources,
              let data = RuntimeSessionFiles.read(resources.appendingPathComponent("LaunchEnvironment.json"), limit: 16 * 1024),
              let environment = try JSONSerialization.jsonObject(with: data) as? [String: String],
              environment["schemaVersion"] == "2", environment["nodeRelativePath"] == "Runtime/native/node",
              FileManager.default.isExecutableFile(atPath: resources.appendingPathComponent("ExtensionLauncher").path) else {
            throw ElectronLaunchError.missingRuntime
        }
        _ = try RuntimeResourceFiles.nativeExecutable(in: resources, filename: "node")
        _ = try RuntimeResourceFiles.nativeExecutable(in: resources, filename: "ProcessIdentity")
        // Build metadata may refer to the manager's location. Only the copied,
        // sealed runtime inside the generated helper is used when launching.
        _ = try RuntimeResourceFiles.brokerURL(in: resources, filename: profile.brokerFilename)
        let bundledRuntime = resources.appendingPathComponent("Runtime", isDirectory: true)
        let runtimeDigest = try RuntimeResourceFiles.digest(in: bundledRuntime)
        let directory = directory(for: app)
        guard directory.isFileURL,
              !directory.standardizedFileURL.resolvingSymlinksInPath().pathComponents
                .contains(where: { $0.lowercased().hasSuffix(".app") }) else {
            throw ElectronLaunchError.shortcut("Extension launchers must be stored outside target application bundles.")
        }
        let launcher = directory.appendingPathComponent("\(app.name) Launcher.app", isDirectory: true)
        let alias = shortcut(for: app)
        let manager = FileManager.default
        let bundledHelper = resources.appendingPathComponent("ExtensionLauncher")
        guard let catalogData = RuntimeSessionFiles.read(resources.appendingPathComponent("runtime-profiles.json"), limit: 1024 * 1024) else {
            throw ElectronLaunchError.missingRuntime
        }
        _ = try RuntimeAppCatalog.decode(catalogData)
        let sourceHash = SHA256.hash(data: try Data(contentsOf: bundledHelper) + catalogData + Data(runtimeDigest.utf8)).map { String(format: "%02x", $0) }.joined()
        if !existingOnly { try manager.createDirectory(at: directory, withIntermediateDirectories: true) }
        let transaction = helperTransaction(app: app, helper: launcher)
        var deferred = false
        if try transaction.recover() == .deferred {
            if existingOnly { return }
            deferred = true
        }
        let active = try isManagedHelperActive(app: app)
        deferred = deferred || active
        let installedResources = launcher.appendingPathComponent("Contents/Resources", isDirectory: true)
        let installedRuntime = installedResources.appendingPathComponent("Runtime", isDirectory: true)
        if try !active && !helperIsCurrent(launcher, identifier: profile.launcherIdentifier,
                                          sourceHash: sourceHash, runtimeDigest: runtimeDigest,
                                          rendererJavaScriptProfile: profile.supportsJavaScript ? profile.rawValue : nil,
                                          rendererJavaScriptTargetIdentifier: profile.targetIdentifier) {
            if existingOnly && !manager.fileExists(atPath: launcher.path) { return }
            let result = try transaction.install { staging in
                try buildHelper(at: staging, app: app, profile: profile, resources: resources,
                                catalogData: catalogData, sourceHash: sourceHash)
            }
            deferred = result == .deferred
            if result == .deferred && existingOnly { return }
        }
        try verifyHelperSignature(launcher)
        guard manager.fileExists(atPath: installedRuntime.path) else {
            throw ElectronLaunchError.shortcut("Quit the running extension launcher normally, then retry to install its packaged runtime.")
        }
        let brokerURL = try RuntimeResourceFiles.brokerURL(in: installedResources, filename: profile.brokerFilename)
        // Startup maintenance updates only an existing helper. Its alias, Dock
        // pin, library and configuration remain exactly as the user left them.
        if existingOnly { return }
        if try ActiveLauncherPreparation.preserveIfNeeded(
            deferred: deferred, isActive: { try isManagedHelperActive(app: app) },
            launcher: launcher, alias: alias, app: app, profile: profile,
            libraryURL: libraryURL, brokerURL: brokerURL, records: records) { return }
        let config: [String: Any] = [
            "schemaVersion": 1, "profile": profile.rawValue, "targetBundlePath": app.url.path,
            "targetBundleIdentifier": profile.targetIdentifier,
            "libraryPath": libraryURL.path,
            "nodePath": try RuntimeResourceFiles.nativeExecutable(in: installedResources, filename: "node").path,
            "brokerPath": brokerURL.path,
            "sessionsPath": directory.appendingPathComponent("Sessions", isDirectory: true).path
        ]
        try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys])
            .write(to: directory.appendingPathComponent("configuration.json"), options: .atomic)
        try RuntimeLauncherAlias.prepare(at: alias, target: launcher,
                                         allowedPreviousTarget: app.url)
    }

    func hasExistingManagedHelper(app: InstalledApp) throws -> Bool {
        guard let profile = ElectronLaunchProfile.profile(for: app) else { return false }
        let helper = directory(for: app).appendingPathComponent("\(app.name) Launcher.app")
        guard FileManager.default.fileExists(atPath: helper.path) else {
            return try helperTransaction(app: app, helper: helper).hasPendingCommit()
        }
        guard helper.standardizedFileURL.resolvingSymlinksInPath().path == helper.path,
              let data = RuntimeSessionFiles.read(helper.appendingPathComponent("Contents/Info.plist"), limit: 64 * 1024),
              let info = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
              info["CFBundleIdentifier"] as? String == profile.launcherIdentifier,
              info["CFBundleExecutable"] as? String == "ExtensionLauncher" else {
            throw ElectronLaunchError.shortcut("The existing managed launcher could not be identified. It was preserved.")
        }
        return true
    }

    /// Read-only counterpart to preparation for an approved runtime upgrade.
    /// It verifies the original installation and new packaged resources without
    /// saving filtered preferences, replacing a helper, or modifying the Dock.
    func preflightRuntimeUpgrade(app: InstalledApp, libraryURL: URL, records: [ExtensionRecord]) throws {
        try validateSelectedApp(app)
        guard let profile = ElectronLaunchProfile.profile(for: app), profile.supportsJavaScript,
              let resources = runtimeResources,
              let data = RuntimeSessionFiles.read(resources.appendingPathComponent("LaunchEnvironment.json"), limit: 16 * 1024),
              let environment = try JSONSerialization.jsonObject(with: data) as? [String: String],
              environment["schemaVersion"] == "2", environment["nodeRelativePath"] == "Runtime/native/node",
              FileManager.default.isExecutableFile(atPath: resources.appendingPathComponent("ExtensionLauncher").path),
              let catalog = RuntimeSessionFiles.read(resources.appendingPathComponent("runtime-profiles.json"), limit: 1024 * 1024) else {
            throw ElectronLaunchError.missingRuntime
        }
        try ElectronLaunchProfile.validate(records: records, for: profile)
        _ = try RuntimeAppCatalog.decode(catalog)
        _ = try RuntimeResourceFiles.nativeExecutable(in: resources, filename: "node")
        _ = try RuntimeResourceFiles.nativeExecutable(in: resources, filename: "ProcessIdentity")
        _ = try RuntimeResourceFiles.brokerURL(in: resources, filename: profile.brokerFilename)
        _ = try RuntimeResourceFiles.digest(in: resources.appendingPathComponent("Runtime"))
        let helper = directory(for: app).appendingPathComponent("\(app.name) Launcher.app")
        try verifyHelperSignature(helper)
        let broker = try RuntimeResourceFiles.brokerURL(in: helper.appendingPathComponent("Contents/Resources"), filename: profile.brokerFilename)
        _ = try ActiveLauncherPreparation.preserveIfNeeded(deferred: true, isActive: { false },
            launcher: helper, alias: shortcut(for: app), app: app, profile: profile,
            libraryURL: libraryURL, brokerURL: broker,
            records: ActiveLauncherPreparation.readOnlyRestartRecords(records))
    }

    func isManagedHelperActive(app: InstalledApp) throws -> Bool {
        guard let profile = ElectronLaunchProfile.profile(for: app) else { return false }
        let helper = directory(for: app).appendingPathComponent("\(app.name) Launcher.app")
        var active = false
        for process in NSWorkspace.shared.runningApplications {
            let path = process.bundleURL?.standardizedFileURL.resolvingSymlinksInPath().path
            guard process.bundleIdentifier == profile.launcherIdentifier || path == helper.path else { continue }
            // LaunchServices can retain a dead registration. An unreadable or
            // still-live identity always defers maintenance rather than guessing.
            if RunningApplicationIdentity.hasDefinitelyExited(processIdentifier: process.processIdentifier) { continue }
            guard process.bundleIdentifier == profile.launcherIdentifier, path == helper.path else {
                throw ElectronLaunchError.shortcut("A managed launcher has an unexpected running identity. It was preserved.")
            }
            active = true
        }
        return active
    }

    func refreshExistingHelper(app: InstalledApp, libraryURL: URL, records: [ExtensionRecord]) throws -> RefreshResult {
        guard let profile = ElectronLaunchProfile.profile(for: app), try hasExistingManagedHelper(app: app) else { return .missing }
        guard !(try isManagedHelperActive(app: app)) else { return .deferred }
        guard let resources = runtimeResources,
              let catalogData = RuntimeSessionFiles.read(resources.appendingPathComponent("runtime-profiles.json"), limit: 1024 * 1024) else {
            throw ElectronLaunchError.missingRuntime
        }
        _ = try RuntimeAppCatalog.decode(catalogData)
        let runtimeDigest = try RuntimeResourceFiles.digest(in: resources.appendingPathComponent("Runtime"))
        let sourceHash = SHA256.hash(data: try Data(contentsOf: resources.appendingPathComponent("ExtensionLauncher")) + catalogData + Data(runtimeDigest.utf8))
            .map { String(format: "%02x", $0) }.joined()
        let helper = directory(for: app).appendingPathComponent("\(app.name) Launcher.app")
        let wasCurrent = try helperIsCurrent(helper, identifier: profile.launcherIdentifier,
                                             sourceHash: sourceHash, runtimeDigest: runtimeDigest,
                                             rendererJavaScriptProfile: profile.supportsJavaScript ? profile.rawValue : nil,
                                             rendererJavaScriptTargetIdentifier: profile.targetIdentifier)
        if wasCurrent, !(try helperTransaction(app: app, helper: helper).hasPendingCommit()) {
            // Avoid hashing the bundled Node tree again for an unchanged helper.
            return try isManagedHelperActive(app: app) ? .deferred : .current
        }
        try prepare(app: app, libraryURL: libraryURL, records: records, existingOnly: true)
        // A helper may have started while its replacement was being built.
        // Keep it queued until a stopped observation verifies the new build.
        guard !(try isManagedHelperActive(app: app)) else { return .deferred }
        guard try hasExistingManagedHelper(app: app) else { return .missing }
        guard try helperIsCurrent(helper, identifier: profile.launcherIdentifier,
                                  sourceHash: sourceHash, runtimeDigest: runtimeDigest,
                                  rendererJavaScriptProfile: profile.supportsJavaScript ? profile.rawValue : nil,
                                  rendererJavaScriptTargetIdentifier: profile.targetIdentifier) else {
            throw ElectronLaunchError.missingRuntime
        }
        return wasCurrent ? .current : .updated
    }

    private func helperTransaction(app: InstalledApp, helper: URL) -> HelperBundleTransaction {
        HelperBundleTransaction(installed: helper,
            identifier: ElectronLaunchProfile.profile(for: app)!.launcherIdentifier,
            verify: { try verifyHelperSignature($0) },
            isActive: { try isManagedHelperActive(app: app) })
    }

    private func verifyHelperSignature(_ helper: URL) throws {
        try run("/usr/bin/codesign", ["--verify", "--strict", helper.path])
    }

    /// A metadata hash alone cannot establish a usable installed helper. A
    /// current hash with damaged signing or Runtime must be rebuilt as well.
    func helperIsCurrent(_ helper: URL, identifier: String, sourceHash: String, runtimeDigest: String,
                         rendererJavaScriptProfile: String? = nil, rendererJavaScriptTargetIdentifier: String? = nil) throws -> Bool {
        guard FileManager.default.fileExists(atPath: helper.path) else { return false }
        guard helper.standardizedFileURL.resolvingSymlinksInPath().path == helper.path,
              let data = RuntimeSessionFiles.read(helper.appendingPathComponent("Contents/Info.plist"), limit: 64 * 1024),
              let info = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
              info["CFBundleIdentifier"] as? String == identifier,
              info["CFBundleExecutable"] as? String == "ExtensionLauncher" else {
            throw ElectronLaunchError.shortcut("The existing launcher could not be identified. It was preserved.")
        }
        guard info["EALauncherSourceSHA256"] as? String == sourceHash else { return false }
        if let rendererJavaScriptProfile {
            guard let rendererJavaScriptTargetIdentifier,
                  RuntimeHelperCapabilities.supportsRendererJavaScript(metadata: data, profile: rendererJavaScriptProfile,
                    targetIdentifier: rendererJavaScriptTargetIdentifier) else { return false }
        }
        do {
            try verifyHelperSignature(helper)
            return try RuntimeResourceFiles.digest(in: helper.appendingPathComponent("Contents/Resources/Runtime")) == runtimeDigest
        } catch { return false }
    }

    private func buildHelper(at staging: URL, app: InstalledApp, profile: ElectronLaunchProfile.Profile,
                             resources: URL, catalogData: Data, sourceHash: String) throws {
        let manager = FileManager.default
        let contents = staging.appendingPathComponent("Contents", isDirectory: true)
        try manager.createDirectory(at: contents.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
        try manager.createDirectory(at: contents.appendingPathComponent("Resources"), withIntermediateDirectories: true)
        try manager.copyItem(at: resources.appendingPathComponent("ExtensionLauncher"), to: contents.appendingPathComponent("MacOS/ExtensionLauncher"))
        try catalogData.write(to: contents.appendingPathComponent("Resources/runtime-profiles.json"))
        try manager.copyItem(at: resources.appendingPathComponent("Runtime"), to: contents.appendingPathComponent("Resources/Runtime"))
        var info: [String: Any] = [
            "CFBundleIdentifier": profile.launcherIdentifier,
            "CFBundleName": app.name, "CFBundleDisplayName": app.name,
            "CFBundleExecutable": "ExtensionLauncher", "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "0.1.0", "CFBundleVersion": "1",
            "EALauncherSourceSHA256": sourceHash,
            "LSUIElement": true, "NSHighResolutionCapable": true, "LSMinimumSystemVersion": "14.0"
        ]
        if profile.supportsJavaScript {
            info.merge(RuntimeHelperCapabilities.metadata(profile: profile.rawValue, targetIdentifier: profile.targetIdentifier)) { _, required in required }
        }
        if let iconName = Bundle(url: app.url)?.object(forInfoDictionaryKey: "CFBundleIconFile") as? String,
           (iconName as NSString).lastPathComponent == iconName {
            let icon = app.url.appendingPathComponent("Contents/Resources/\(iconName.hasSuffix(".icns") ? iconName : iconName + ".icns")")
            if manager.fileExists(atPath: icon.path) {
                try manager.copyItem(at: icon, to: contents.appendingPathComponent("Resources/AppIcon.icns"))
                info["CFBundleIconFile"] = "AppIcon.icns"
            }
        }
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"), options: .atomic)
        // Only our fully staged helper is signed, never the target application.
        try run("/usr/bin/codesign", ["--force", "--sign", "-", staging.path])
        try verifyHelperSignature(staging)
    }

    @discardableResult
    func installShortcut(app: InstalledApp) throws -> DockShortcutOutcome {
        try validateSelectedApp(app)
        if !ElectronLaunchProfile.supports(app) { try prepareOrdinaryAlias(app: app) }
        return try finishDockChange(dock.install(target: app.url, replacement: shortcut(for: app), addIfMissing: true))
    }

    @discardableResult
    func reconcile(app: InstalledApp, hasEnabledExtensions: Bool) throws -> DockShortcutOutcome {
        if hasEnabledExtensions { return try installShortcut(app: app) }
        try validateSelectedApp(app)
        return try finishDockChange(dock.restore(target: app.url))
    }

    private func finishDockChange(_ result: DockShortcutOutcome) throws -> DockShortcutOutcome {
        switch result {
        case .installed, .restored, .added, .removed: try refreshDock()
        case .conflict(let message): throw ElectronLaunchError.shortcut(message)
        default: break
        }
        return result
    }

    func open(app: InstalledApp) throws {
        try validateSelectedApp(app)
        if !ElectronLaunchProfile.supports(app) { try prepareOrdinaryAlias(app: app) }
        guard openURL(shortcut(for: app)) else { throw ElectronLaunchError.shortcut("Couldn't open the app shortcut.") }
    }

    private func validateSelectedApp(_ app: InstalledApp) throws {
        guard app.url.isFileURL,
              app.url.path == app.url.standardizedFileURL.resolvingSymlinksInPath().path,
              app.id == app.url.path,
              try ElectronAppDiscovery.scan(in: app.url.deletingLastPathComponent()).contains(app) else {
            throw ElectronLaunchError.staleApp
        }
        // Read the identifier directly as Bundle may cache Info.plist contents.
        guard let data = try? Data(contentsOf: app.url.appendingPathComponent("Contents/Info.plist")),
              let info = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any] else {
            throw ElectronLaunchError.staleApp
        }
        let rawIdentifier = (info["CFBundleIdentifier"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let identifier = rawIdentifier?.isEmpty == true ? nil : rawIdentifier
        guard identifier == app.bundleIdentifier else { throw ElectronLaunchError.staleApp }
    }

    private func prepareOrdinaryAlias(app: InstalledApp) throws {
        let manager = FileManager.default
        let directory = directory(for: app).standardizedFileURL.resolvingSymlinksInPath()
        guard directory.isFileURL,
              !directory.pathComponents.contains(where: { $0.lowercased().hasSuffix(".app") }) else {
            throw ElectronLaunchError.shortcut("App shortcuts must be stored outside application bundles.")
        }
        let alias = shortcut(for: app)
        let existing: [FileAttributeKey: Any]?
        do { existing = try manager.attributesOfItem(atPath: alias.path) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { existing = nil }
        if let existing {
            guard existing[.type] as? FileAttributeType == .typeRegular,
                  try alias.resourceValues(forKeys: [.isAliasFileKey]).isAliasFile == true,
                  try URL(resolvingAliasFileAt: alias, options: [.withoutUI, .withoutMounting])
                    .standardizedFileURL.resolvingSymlinksInPath().path == app.url.path else {
                throw ElectronLaunchError.shortcut("The existing app shortcut points somewhere else or is not a Finder alias. It was preserved.")
            }
            return
        }
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        let temporary = directory.appendingPathComponent(".alias-\(UUID().uuidString)")
        defer { try? manager.removeItem(at: temporary) }
        let bookmark = try app.url.bookmarkData(options: .suitableForBookmarkFile, includingResourceValuesForKeys: nil, relativeTo: nil)
        try URL.writeBookmarkData(bookmark, to: temporary)
        guard try temporary.resourceValues(forKeys: [.isAliasFileKey]).isAliasFile == true,
              try URL(resolvingAliasFileAt: temporary, options: [.withoutUI, .withoutMounting])
                .standardizedFileURL.resolvingSymlinksInPath().path == app.url.path else {
            throw ElectronLaunchError.shortcut("The app shortcut could not be verified.")
        }
        try manager.moveItem(at: temporary, to: alias)
    }

    func sessionDirectory(app: InstalledApp) -> URL? {
        let directory = directory(for: app)
        guard let data = RuntimeSessionFiles.read(directory.appendingPathComponent("latest-session.json"), limit: RuntimeSessionFiles.pointerLimit) else { return nil }
        return RuntimeSessionFiles.directory(pointer: data, launcherDirectory: directory)
    }

    func runtimeSession(app: InstalledApp) -> RuntimeSessionSnapshot? {
        guard let profile = ElectronLaunchProfile.profile(for: app),
              let session = sessionDirectory(app: app),
              let data = RuntimeSessionFiles.read(session.appendingPathComponent("status.json"), limit: RuntimeSessionFiles.statusLimit) else { return nil }
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: profile.targetIdentifier).filter {
            $0.bundleURL?.standardizedFileURL.resolvingSymlinksInPath().path == app.url.path
        }
        guard running.count <= 1 else { return nil }
        let current = running.first.map {
            RuntimeSessionSnapshot.RunningProcess(pid: $0.processIdentifier, launchDate: RunningApplicationIdentity.startDate(of: $0))
        }
        return RuntimeSessionSnapshot.validated(data: data, app: app, sessionDirectory: session, now: Date(),
                                                currentProcess: current, brokerIsAlive: { Darwin.kill($0, 0) == 0 })
    }

    func status(app: InstalledApp) -> String {
        guard let profile = ElectronLaunchProfile.profile(for: app) else { return "Extensions are saved. Running them in \(app.name) isn’t implemented yet." }
        if let snapshot = runtimeSession(app: app) {
            if snapshot.isHealthy {
                return profile.supportsJavaScript ? "Connected. Enabled extensions are running in \(app.name)." : "Connected. Enabled stylesheets are running in \(app.name)."
            }
            if snapshot.hasRecoverableExtensionFailure {
                return "Connected. One or more extensions failed. Open their logs, then disable or replace the affected extension."
            }
            if let instruction = snapshot.assistedSetupStatus { return instruction }
            if snapshot.isStarting { return "Connecting extensions to \(app.name)…" }
            if snapshot.phase == .disabled, let pid = snapshot.pid,
               let running = NSRunningApplication(processIdentifier: pid),
               snapshot.matches(processIdentifier: pid, launchDate: RunningApplicationIdentity.startDate(of: running)) {
                return profile.supportsJavaScript ? "Connected. Stylesheets removed and registered script cleanup completed." : "Connected. Stylesheets removed."
            }
        }
        if let directory = sessionDirectory(app: app),
           let data = RuntimeSessionFiles.read(directory.appendingPathComponent("status.json"), limit: RuntimeSessionFiles.statusLimit),
           let payload = try? JSONDecoder().decode(RuntimeStatusPayload.self, from: data),
           payload.appKey == app.bundleIdentifier, payload.bundle == app.url.path, payload.phase == .error {
            return payload.error.map { String($0.prefix(4096)) } ?? "The launcher reported an error. Open session logs for details."
        }
        if ElectronLaunchProfile.profile(for: app) == .chatgpt {
            return "Experimental CSS connection is not active. Quit ChatGPT normally, then reopen it from its shortcut to attempt connection."
        }
        if let instruction = profile.assistedSetupInstructions { return "Ready. Open Claude to connect extensions. \(instruction)" }
        return "Ready. Open \(app.name) from its Dock shortcut or the Open App button."
    }

    private func run(_ path: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw ElectronLaunchError.missingRuntime }
    }
}
