import AppKit
import Foundation
import RuntimeCatalog

enum RuntimeUpgradeError: LocalizedError, Equatable {
    case alreadyPending, libraryChanged, missingRunningApp
    var errorDescription: String? {
        switch self {
        case .alreadyPending: "An extension launcher update is already in progress for this app."
        case .libraryChanged: "The extension library changed while the restart was pending. The requested extension change was not saved. Review the latest library and try again."
        case .missingRunningApp: "The running app could not be identified for this restart. Close its extension launcher's current alert, then try enabling the extension again."
        }
    }
}

/// Runs only after preparation refuses an enabled JS selection for an older
/// active helper. The intent remains in memory until normal shutdown finishes.
@MainActor
final class RuntimeUpgradeCoordinator {
    private let confirmRestart: (InstalledApp) -> Bool
    private let restartEnvironment: AppRestartEnvironment
    private var pending: Set<String> = []

    init(confirmRestart: ((InstalledApp) -> Bool)? = nil, restartEnvironment: AppRestartEnvironment = .live) {
        self.confirmRestart = confirmRestart ?? Self.confirmNativeRestart
        self.restartEnvironment = restartEnvironment
    }

    /// Returns false for Not Now. Read/prepare/commit are injected separately so
    /// validation never turns an uncommitted preference into the old watcher's input.
    func run(app: InstalledApp, helperURL: URL, originalLibrary: Data?,
             readLibrary: () throws -> Data?, prepare: (_ afterShutdown: Bool) throws -> Void,
             commit: () throws -> Void, open: () -> Void) async throws -> Bool {
        guard pending.insert(app.id).inserted else { throw RuntimeUpgradeError.alreadyPending }
        defer { pending.remove(app.id) }
        func requireUnchangedLibrary() throws {
            guard try readLibrary() == originalLibrary else { throw RuntimeUpgradeError.libraryChanged }
        }
        try requireUnchangedLibrary()
        guard let profile = ElectronLaunchProfile.profile(for: app) else { throw AppRestartError.unsupportedApp }
        var environment = restartEnvironment
        environment.helperURL = { _ in helperURL }
        let candidates = environment.runningProcesses().filter {
            $0.bundleIdentifier == profile.targetIdentifier || AppRestartProcess.canonicalPath($0.bundleURL) == profile.targetURL.path
        }
        guard candidates.count == 1, let target = candidates.first,
              target.bundleIdentifier == profile.targetIdentifier,
              AppRestartProcess.canonicalPath(target.bundleURL) == profile.targetURL.path,
              target.processIdentifier > 0, target.launchDate != nil else { throw RuntimeUpgradeError.missingRunningApp }
        guard confirmRestart(app) else { return false }
        try requireUnchangedLibrary()
        try await AppRestartService(environment: environment).restart(app: app,
            processIdentifier: target.processIdentifier, launchDate: target.launchDate,
            prepare: {
                try requireUnchangedLibrary()
                try prepare(false) // Read-only preflight; the existing helper/library stay untouched.
                try requireUnchangedLibrary()
            }, open: {
                try requireUnchangedLibrary()
                try prepare(true) // Target and helper have exited; rebuild compatibility.
                try requireUnchangedLibrary()
                try commit() // Retry the captured intent once; never prompt recursively.
                open()
            })
        return true
    }

    private static func confirmNativeRestart(_ app: InstalledApp) -> Bool {
        guard NSApp != nil else { return false }
        let alert = NativeRestartAlert.make(appName: app.name, context: .runtimeUpgrade,
            icon: NSWorkspace.shared.icon(forFile: app.url.path),
            assistedSetupInstructions: ElectronLaunchProfile.profile(for: app)?.assistedSetupInstructions)
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }
}
