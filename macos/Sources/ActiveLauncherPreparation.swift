import Foundation
import RuntimeCatalog

/// An active helper may predate a runtime migration. Preserve the verified
/// shortcut/configuration it already uses instead of requiring new resources
/// inside a bundle that must not be replaced until it stops.
enum ActiveLauncherPreparation {
    /// Used only by read-only restart preflight, never written or launched.
    /// Existing unmarked helpers may already contain saved JS from earlier builds.
    static func readOnlyRestartRecords(_ records: [ExtensionRecord]) -> [ExtensionRecord] {
        records.map { record in
            var inspected = record
            if record.sourceType == .js || record.sourceFiles?.contains(where: { $0.type == .js }) == true {
                inspected.isEnabled = false
            }
            return inspected
        }
    }
    private struct Configuration: Decodable {
        let schemaVersion: Int
        let profile: String
        let targetBundlePath: String
        let targetBundleIdentifier: String
        let libraryPath: String
        let nodePath: String
        let brokerPath: String
        let sessionsPath: String
    }

    /// The caller has already verified the installed helper's code signature
    /// and resolved its fixed broker entry point. This function performs no writes.
    static func preserveIfNeeded(
        deferred: Bool, isActive: () throws -> Bool, launcher: URL, alias: URL,
        app: InstalledApp, profile: ElectronLaunchProfile.Profile, libraryURL: URL, brokerURL: URL,
        records: [ExtensionRecord] = []
    ) throws -> Bool {
        guard try deferred || isActive() else { return false }
        let directory = launcher.deletingLastPathComponent()
        do {
            let configuration = try JSONDecoder().decode(Configuration.self,
                from: RuntimeLauncherConfigurationFiles.read(in: directory))
            guard configuration.schemaVersion == 1, configuration.profile == profile.rawValue,
                  configuration.targetBundlePath == app.url.path,
                  configuration.targetBundleIdentifier == profile.targetIdentifier,
                  configuration.libraryPath == libraryURL.path, configuration.brokerPath == brokerURL.path,
                  (configuration.nodePath as NSString).isAbsolutePath,
                  try alias.resourceValues(forKeys: [.isAliasFileKey, .isSymbolicLinkKey]).isAliasFile == true,
                  alias.standardizedFileURL.resolvingSymlinksInPath().path == alias.path,
                  try URL(resolvingAliasFileAt: alias, options: [.withoutUI, .withoutMounting])
                    .standardizedFileURL.resolvingSymlinksInPath().path == launcher.path else {
                throw CocoaError(.fileReadCorruptFile)
            }
            _ = try RuntimeLauncherConfigurationFiles.sessionsDirectory(configuration.sessionsPath, launcherDirectory: directory)
        } catch {
            throw ElectronLaunchError.shortcut("The running extension launcher's existing shortcut or configuration doesn't match this app. Quit that launcher normally, then prepare its shortcut again. Its active session was preserved.")
        }
        // The new manager's source policy cannot establish what an older active
        // watcher understands. Refuse before ExtensionManager commits its shared
        // library, so the old broker keeps its current CSS selection untouched.
        let needsJavaScript = records.contains { record in
            record.appKey == profile.targetIdentifier && record.isEnabled &&
                (record.sourceType == .js || record.sourceFiles?.contains(where: { $0.type == .js }) == true)
        }
        if needsJavaScript {
            let metadata = RuntimeSessionFiles.read(launcher.appendingPathComponent("Contents/Info.plist"),
                                                    limit: RuntimeHelperCapabilities.maximumMetadataBytes)
            guard profile.supportsJavaScript,
                  RuntimeHelperCapabilities.supportsRendererJavaScript(metadata: metadata, profile: profile.rawValue,
                    targetIdentifier: profile.targetIdentifier) else {
                throw ElectronLaunchError.runtimeUpgradeRequired(app.name)
            }
        }
        return true
    }
}
