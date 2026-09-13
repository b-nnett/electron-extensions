import Foundation
import Observation
import AppKit

@MainActor
@Observable
final class ExtensionManager {
    private(set) var library = ExtensionLibrary()
    private(set) var loadFailed = false
    var errorMessage: String?
    private(set) var dockNotice: [String: String] = [:]
    private let storageURL: URL
    private let presentDockInstaller: @MainActor (InstalledApp, URL) -> Bool
    private let runtimeUpgradeCoordinator: RuntimeUpgradeCoordinator
    private struct LibrarySnapshot { let bytes: Data? }
    let launcher: ElectronLauncher

    init(storageURL: URL = ExtensionLibrary.defaultURL, launcher: ElectronLauncher = ElectronLauncher(),
         presentDockInstaller: @escaping @MainActor (InstalledApp, URL) -> Bool = { app, shortcut in
             guard NSApp != nil else { return false }
             DockInstallWindowController.shared.show(app: app, shortcut: shortcut)
             return true
         }, runtimeUpgradeCoordinator: RuntimeUpgradeCoordinator = RuntimeUpgradeCoordinator()) {
        self.storageURL = storageURL
        self.launcher = launcher
        self.presentDockInstaller = presentDockInstaller
        self.runtimeUpgradeCoordinator = runtimeUpgradeCoordinator
    }

    var appKeys: Set<String> { Set(library.records.map(\.appKey)) }
    var storageFileURL: URL { storageURL }

    func records(for app: InstalledApp) -> [ExtensionRecord] {
        library.records(for: app)
    }

    func record(_ id: UUID) -> ExtensionRecord? {
        library.records.first { $0.id == id }
    }

    func reload() {
        do {
            library = try ExtensionLibrary.load(from: storageURL)
            loadFailed = false
        } catch {
            loadFailed = true
            errorMessage = error.localizedDescription
        }
    }

    func add(source: ImportedExtensionSource, app: InstalledApp, name: String, description: String) throws {
        guard !loadFailed else { throw CocoaError(.fileReadCorruptFile) }
        try change(app: app) { temporaryURL in try library.adding(
            source: source, appKey: ExtensionLibrary.appKey(for: app),
            name: name, description: description, isEnabled: true, to: temporaryURL
        ) }
    }

    func add(package: ImportedExtensionPackage, app: InstalledApp, isEnabled: Bool = true) throws {
        guard !loadFailed else { throw CocoaError(.fileReadCorruptFile) }
        try change(app: app) { temporaryURL in try library.adding(
            package: package, appKey: ExtensionLibrary.appKey(for: app),
            isEnabled: isEnabled, to: temporaryURL
        ) }
    }

    /// UI imports wait for the optional native upgrade decision. The synchronous
    /// API remains available to callers that do not present interactive UI.
    func addWithRuntimeUpgrade(package: ImportedExtensionPackage, app: InstalledApp, isEnabled: Bool = true) async throws -> Bool {
        let original = try ExtensionLibrary.readData(from: storageURL)
        do {
            try add(package: package, app: app, isEnabled: isEnabled)
            return true
        } catch {
            guard needsRuntimeUpgrade(error) else { throw error }
            return try await retryAfterRuntimeUpgrade(app: app, originalLibrary: original) {
                try self.change(app: app, expectedLibrary: LibrarySnapshot(bytes: original)) { temporaryURL in
                    try self.library.adding(package: package, appKey: ExtensionLibrary.appKey(for: app),
                                            isEnabled: isEnabled, to: temporaryURL)
                }
            }
        }
    }

    func setEnabled(_ enabled: Bool, record: ExtensionRecord, app: InstalledApp) {
        let original: Data?
        do { original = try ExtensionLibrary.readData(from: storageURL) }
        catch { errorMessage = error.localizedDescription; return }
        let mutation = {
            guard !self.loadFailed else { throw CocoaError(.fileReadCorruptFile) }
            try self.change(app: app, expectedLibrary: LibrarySnapshot(bytes: original)) { temporaryURL in
                guard self.library.records.first(where: { $0.id == record.id && $0.appKey == record.appKey }) == record else {
                    throw ElectronLaunchError.shortcut("This extension changed or was removed. Refresh before changing its enabled preference.")
                }
                return try self.library.settingEnabled(enabled, for: record.id, appKey: record.appKey, to: temporaryURL)
            }
        }
        do {
            try mutation()
        } catch {
            if needsRuntimeUpgrade(error) {
                Task {
                    do { _ = try await retryAfterRuntimeUpgrade(app: app, originalLibrary: original, retry: mutation) }
                    catch { errorMessage = error.localizedDescription }
                }
            } else { errorMessage = error.localizedDescription }
        }
    }

    private func needsRuntimeUpgrade(_ error: Error) -> Bool {
        guard let error = error as? ElectronLaunchError else { return false }
        if case .runtimeUpgradeRequired = error { return true }
        return false
    }

    private func retryAfterRuntimeUpgrade(app: InstalledApp, originalLibrary: Data?,
                                         retry: () throws -> Void) async throws -> Bool {
        errorMessage = nil
        return try await runtimeUpgradeCoordinator.run(app: app,
            helperURL: launcher.directory(for: app).appendingPathComponent("\(app.name) Launcher.app"),
            originalLibrary: originalLibrary,
            readLibrary: { try ExtensionLibrary.readData(from: self.storageURL) },
            prepare: { afterShutdown in
                self.reload()
                guard !self.loadFailed else { throw CocoaError(.fileReadCorruptFile) }
                if afterShutdown {
                    try self.launcher.prepare(app: app, libraryURL: self.storageURL, records: self.records(for: app))
                } else {
                    try self.launcher.preflightRuntimeUpgrade(app: app, libraryURL: self.storageURL, records: self.records(for: app))
                }
            }, commit: retry, open: {
                do { try self.launcher.open(app: app) }
                catch { self.errorMessage = "Your extension change was saved, but \(app.name) couldn't reopen. \(error.localizedDescription)" }
            })
    }

    func remove(_ record: ExtensionRecord, app: InstalledApp) throws {
        guard !loadFailed else { throw CocoaError(.fileReadCorruptFile) }
        try change(app: app) { temporaryURL in
            try library.removing(record.id, appKey: record.appKey, to: temporaryURL)
        }
    }

    /// Recovery for saved records whose installation is unavailable. These
    /// operations never prepare a launch, enable code, or change Dock receipts.
    func disableSavedRecord(_ record: ExtensionRecord) throws {
        try changeSavedRecord(record, removing: false)
    }

    func removeSavedRecord(_ record: ExtensionRecord) throws {
        try changeSavedRecord(record, removing: true)
    }

    private func changeSavedRecord(_ record: ExtensionRecord, removing: Bool) throws {
        guard !loadFailed else { throw CocoaError(.fileReadCorruptFile) }
        library = try ExtensionLibrary.load(from: storageURL)
        guard library.records.first(where: { $0.id == record.id && $0.appKey == record.appKey }) == record else {
            throw ElectronLaunchError.shortcut("This extension changed or was removed. Refresh before changing it.")
        }
        guard let original = try ExtensionLibrary.readData(from: storageURL) else {
            throw ExtensionLibraryError.missingRecord
        }
        let temporaryURL = FileManager.default.temporaryDirectory.appendingPathComponent("saved-extension-change-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: temporaryURL) }
        let next: ExtensionLibrary
        if removing {
            next = try library.removing(record.id, appKey: record.appKey, to: temporaryURL)
        } else {
            next = try library.settingEnabled(false, for: record.id, appKey: record.appKey, to: temporaryURL)
        }
        guard try ExtensionLibrary.readData(from: storageURL) == original else {
            throw ElectronLaunchError.shortcut("The extension library changed while saving. Refresh and try again.")
        }
        try next.save(to: storageURL, expectedOriginal: original, checkExpected: true)
        library = next
    }

    func open(_ app: InstalledApp) {
        do {
            try launcher.prepare(app: app, libraryURL: storageURL, records: records(for: app))
            try launcher.open(app: app)
        } catch { errorMessage = error.localizedDescription }
    }

    func refreshExistingLauncher(_ app: InstalledApp) throws -> ElectronLauncher.RefreshResult {
        guard !loadFailed else { throw CocoaError(.fileReadCorruptFile) }
        return try launcher.refreshExistingHelper(app: app, libraryURL: storageURL, records: records(for: app))
    }

    func restart(_ instance: RunningTweakInstance) async throws {
        reload()
        guard !loadFailed, records(for: instance.app).contains(where: \.isEnabled) else {
            throw ElectronLaunchError.shortcut("There are no enabled extensions to restart this app with. Refresh and try again.")
        }
        if let snapshot = launcher.runtimeSession(app: instance.app),
           snapshot.suppressesMissingRuntimePrompt(processIdentifier: instance.processIdentifier, launchDate: instance.launchDate) {
            return
        }
        try await AppRestartService().restart(app: instance.app,
            processIdentifier: instance.processIdentifier, launchDate: instance.launchDate,
            prepare: { try self.launcher.prepare(app: instance.app, libraryURL: self.storageURL, records: self.records(for: instance.app)) },
            open: {
                // Re-read after the app's quit/save dialogs, which can stay open.
                self.reload()
                guard !self.loadFailed else { throw CocoaError(.fileReadCorruptFile) }
                try self.launcher.prepare(app: instance.app, libraryURL: self.storageURL, records: self.records(for: instance.app))
                try self.launcher.open(app: instance.app)
            })
    }

    func repairShortcut(_ app: InstalledApp) {
        do {
            let records = records(for: app)
            try launcher.prepare(app: app, libraryURL: storageURL, records: records)
            let result = try launcher.installShortcut(app: app)
            showDockResult(result, app: app)
        } catch {
            errorMessage = "The Dock shortcut couldn't be updated. \(error.localizedDescription)"
            showDockInstaller(app)
        }
    }

    func showDockInstaller(_ app: InstalledApp) {
        do {
            try launcher.prepare(app: app, libraryURL: storageURL, records: records(for: app))
            if !presentDockInstaller(app, launcher.shortcut(for: app)) {
                errorMessage = errorMessage ?? "The Dock installer cannot be shown in this process. Open the app to add its shortcut."
            }
        } catch { errorMessage = errorMessage ?? error.localizedDescription }
    }

    private func showDockResult(_ result: DockShortcutOutcome, app: InstalledApp) {
        switch result {
        case .added, .installed: dockNotice[app.id] = "Added to your Dock."
        case .alreadyReplaced: dockNotice[app.id] = "Already in your Dock."
        case .restored, .removed: dockNotice[app.id] = "Dock shortcut restored."
        default: break
        }
    }

    private func change(app: InstalledApp, expectedLibrary: LibrarySnapshot? = nil,
                        operation: (URL) throws -> ExtensionLibrary) throws {
        // Re-read before staging so a stale window cannot replace newer records.
        let original = try ExtensionLibrary.readData(from: storageURL)
        if let expectedLibrary, original != expectedLibrary.bytes { throw RuntimeUpgradeError.libraryChanged }
        library = try ExtensionLibrary.load(from: storageURL)
        guard try ExtensionLibrary.readData(from: storageURL) == original else { throw RuntimeUpgradeError.libraryChanged }
        let temporaryURL = FileManager.default.temporaryDirectory.appendingPathComponent("extension-change-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: temporaryURL) }
        let next = try operation(temporaryURL)
        let enabled = next.records(for: app).contains(where: \.isEnabled)
        if enabled {
            try launcher.prepare(app: app, libraryURL: storageURL, records: next.records(for: app))
        }
        guard try ExtensionLibrary.readData(from: storageURL) == original else {
            throw ElectronLaunchError.shortcut("The extension library changed while saving. Refresh and try again.")
        }
        try next.save(to: storageURL, expectedOriginal: original, checkExpected: true)
        library = next
        do {
            let result = try launcher.reconcile(app: app, hasEnabledExtensions: enabled)
            showDockResult(result, app: app)
        }
        catch {
            // Desired state remains saved, especially disabling. Never re-enable
            // code because a separately editable Dock preference conflicted.
            errorMessage = "Your extension preference was saved, but the Dock shortcut couldn't be updated. \(error.localizedDescription)"
            if enabled {
                showDockInstaller(app)
            }
        }
    }
}
