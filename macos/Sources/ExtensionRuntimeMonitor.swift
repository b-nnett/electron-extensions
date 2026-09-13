import AppKit
import Foundation
import RuntimeCatalog

struct RunningTweakInstance: Hashable, Sendable {
    let app: InstalledApp
    let processIdentifier: Int32
    let launchDate: Date
}

/// A launch must remain disconnected through the grace period. Dismissals last
/// for this process only, so an updater's next process gets its own decision.
struct RestartPromptPolicy {
    struct Observation {
        let instance: RunningTweakInstance
        let connectedOrStarting: Bool
    }

    let gracePeriod: TimeInterval
    private var missingSince: [RunningTweakInstance: Date] = [:]
    private var prompted: Set<RunningTweakInstance> = []

    init(gracePeriod: TimeInterval = 45) { self.gracePeriod = gracePeriod }

    mutating func next(observations: [Observation], enabled: Bool, now: Date) -> RunningTweakInstance? {
        guard enabled else {
            missingSince.removeAll()
            prompted.removeAll()
            return nil
        }
        let current = Set(observations.map(\.instance))
        missingSince = missingSince.filter { current.contains($0.key) }
        prompted.formIntersection(current)
        for observation in observations {
            if observation.connectedOrStarting { missingSince[observation.instance] = nil }
            else if missingSince[observation.instance] == nil { missingSince[observation.instance] = now }
        }
        return observations.first {
            !$0.connectedOrStarting && !prompted.contains($0.instance) &&
            now.timeIntervalSince(missingSince[$0.instance] ?? now) >= gracePeriod
        }?.instance
    }

    mutating func didPresent(_ instance: RunningTweakInstance) { prompted.insert(instance) }
}

/// One manager lifetime's maintenance queue. Active helpers never block another
/// stopped helper, and a deferred preparation never counts as an installed update.
struct LauncherRefreshQueue {
    private var pending: [InstalledApp] = []
    private var finished: Set<String> = []

    mutating func poll(
        apps: [InstalledApp], exists: (InstalledApp) throws -> Bool,
        active: (InstalledApp) throws -> Bool,
        refresh: (InstalledApp) throws -> ElectronLauncher.RefreshResult,
        didUpdate: (InstalledApp) -> Void, failed: (InstalledApp, Error) -> Void
    ) {
        let ids = Set(apps.map(\.id))
        pending.removeAll { !ids.contains($0.id) }
        finished.formIntersection(ids)
        for app in apps where !finished.contains(app.id) && !pending.contains(where: { $0.id == app.id }) {
            do { if try exists(app) { pending.append(app) } }
            catch { finished.insert(app.id); failed(app, error) }
        }
        for app in pending {
            do {
                if try active(app) { continue }
                switch try refresh(app) {
                case .deferred: break
                case .current, .missing:
                    finished.insert(app.id)
                    pending.removeAll { $0.id == app.id }
                case .updated:
                    finished.insert(app.id)
                    pending.removeAll { $0.id == app.id }
                    didUpdate(app)
                }
            } catch {
                finished.insert(app.id)
                pending.removeAll { $0.id == app.id }
                failed(app, error)
            }
            return // At most one preparation attempt per poll.
        }
    }
}

@MainActor
final class ExtensionRuntimeMonitor: NSObject {
    private let library: AppLibraryStore
    private let extensions: ExtensionManager
    private let preferences: AppPreferences
    private var policy = RestartPromptPolicy()
    private var launcherRefresh = LauncherRefreshQueue()
    private var task: Task<Void, Never>?
    private var lastRefresh = Date.distantPast
    private var lastLibraryData: Data?
    private var visiblePrompt: RunningTweakInstance?
    private var lastConnections: [RunningTweakInstance: Bool] = [:]
    private var restarting: Set<String> = []
    private let prompt = RestartPromptAlertController()

    init(library: AppLibraryStore, extensions: ExtensionManager, preferences: AppPreferences) {
        self.library = library
        self.extensions = extensions
        self.preferences = preferences
    }

    func start() {
        guard task == nil else { return }
        let center = NSWorkspace.shared.notificationCenter
        center.addObserver(self, selector: #selector(applicationsChanged(_:)), name: NSWorkspace.didLaunchApplicationNotification, object: nil)
        center.addObserver(self, selector: #selector(applicationsChanged(_:)), name: NSWorkspace.didTerminateApplicationNotification, object: nil)
        center.addObserver(self, selector: #selector(applicationActivated(_:)), name: NSWorkspace.didActivateApplicationNotification, object: nil)
        center.addObserver(self, selector: #selector(applicationsChanged(_:)), name: NSWorkspace.didWakeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(stop), name: NSApplication.willTerminateNotification, object: nil)
        task = Task { [weak self] in
            while !Task.isCancelled {
                self?.poll()
                do { try await Task.sleep(for: .seconds(2)) } catch { break }
            }
        }
    }

    @objc func stop() {
        task?.cancel()
        task = nil
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        NotificationCenter.default.removeObserver(self)
        prompt.dismiss()
    }

    @objc private func applicationsChanged(_ notification: Notification) {
        library.refresh()
        poll()
    }

    @objc private func applicationActivated(_ notification: Notification) {
        guard let running = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
              let path = running.bundleURL?.standardizedFileURL.resolvingSymlinksInPath().path,
              let app = library.yourApps.first(where: { $0.id == path && $0.bundleIdentifier == running.bundleIdentifier }) else { return }
        preferences.recordUse(of: app)
        RuntimeEventJournal.shared.record("appActivated", app: app, processIdentifier: running.processIdentifier,
                                          processStartedAt: RunningApplicationIdentity.startDate(of: running))
    }

    func poll() {
        // The service outlives the main window. Changes made by a launcher or an
        // external editor still reach both the menu and the prompt policy.
        let data = try? ExtensionLibrary.readData(from: extensions.storageFileURL)
        if data != lastLibraryData {
            extensions.reload()
            lastLibraryData = data
        }
        library.setExtensionAppKeys(extensions.appKeys)
        let now = Date()
        if now.timeIntervalSince(lastRefresh) >= 30 {
            library.refresh()
            lastRefresh = now
        }
        if !extensions.loadFailed {
            launcherRefresh.poll(
                apps: library.yourApps.filter {
                    ElectronLaunchProfile.supports($0) && !restarting.contains($0.id) &&
                        !extensions.records(for: $0).isEmpty
                },
                exists: { try extensions.launcher.hasExistingManagedHelper(app: $0) },
                active: { try extensions.launcher.isManagedHelperActive(app: $0) },
                refresh: { try extensions.refreshExistingLauncher($0) },
                didUpdate: { RuntimeEventJournal.shared.record("launcherBuildUpdated", app: $0) },
                failed: { app, error in
                    // One diagnostic per app/build; background maintenance never
                    // interrupts an active session or presents a modal alert.
                    RuntimeEventJournal.shared.record("launcherBuildRefreshFailed", app: app)
                    NSLog("Launcher refresh failed for %@: %@", app.name, error.localizedDescription)
                }
            )
        }
        let observations = library.yourApps.flatMap { app -> [RestartPromptPolicy.Observation] in
            guard !extensions.loadFailed, ElectronLaunchProfile.supports(app), !restarting.contains(app.id),
                  extensions.records(for: app).contains(where: \.isEnabled),
                  (try? ElectronLaunchProfile.validate(records: extensions.records(for: app), app: app)) != nil else { return [] }
            let snapshot = extensions.launcher.runtimeSession(app: app)
            return NSRunningApplication.runningApplications(withBundleIdentifier: app.bundleIdentifier ?? "").compactMap { running in
                guard !running.isTerminated, running.bundleURL?.standardizedFileURL.resolvingSymlinksInPath().path == app.url.path,
                      let launchDate = RunningApplicationIdentity.startDate(of: running) else { return nil }
                let instance = RunningTweakInstance(app: app, processIdentifier: running.processIdentifier, launchDate: launchDate)
                let connected = snapshot.map {
                    $0.suppressesMissingRuntimePrompt(processIdentifier: running.processIdentifier, launchDate: launchDate)
                } ?? false
                return .init(instance: instance, connectedOrStarting: connected)
            }
        }
        for observation in observations where lastConnections[observation.instance] != observation.connectedOrStarting {
            RuntimeEventJournal.shared.record(observation.connectedOrStarting ? "runtimeConnectedOrStarting" : "runtimeMissing", instance: observation.instance)
        }
        lastConnections = Dictionary(uniqueKeysWithValues: observations.map { ($0.instance, $0.connectedOrStarting) })
        let candidate = policy.next(observations: observations, enabled: preferences.promptToRestartAppsWithoutExtensions, now: now)
        if let visiblePrompt, !preferences.promptToRestartAppsWithoutExtensions ||
            !observations.contains(where: { $0.instance == visiblePrompt && !$0.connectedOrStarting }) {
            prompt.dismiss()
            RuntimeEventJournal.shared.record("promptDismissedAfterStateChange", instance: visiblePrompt)
            self.visiblePrompt = nil
        }
        guard visiblePrompt == nil, let candidate else { return }
        policy.didPresent(candidate)
        visiblePrompt = candidate
        prompt.show(app: candidate.app, icon: library.icons[candidate.app.id]) { [weak self] restart in
            guard let self else { return }
            self.visiblePrompt = nil
            RuntimeEventJournal.shared.record(restart ? "restartAccepted" : "restartDeclined", instance: candidate)
            if restart { self.restart(candidate) }
        }
        RuntimeEventJournal.shared.record("promptPresented", instance: candidate)
    }

    private func restart(_ instance: RunningTweakInstance) {
        guard preferences.promptToRestartAppsWithoutExtensions else { return }
        restarting.insert(instance.app.id)
        Task { [weak self] in
            guard let self else { return }
            defer {
                restarting.remove(instance.app.id)
                // Polling excluded this app during the quit dialog. Preserve the
                // choice if it declined or timed out and the same process lives.
                policy.didPresent(instance)
                poll()
            }
            do {
                try await extensions.restart(instance)
                RuntimeEventJournal.shared.record("restartRequestCompleted", instance: instance)
            } catch {
                RuntimeEventJournal.shared.record("restartFailed", instance: instance)
                let alert = NSAlert()
                alert.messageText = "Couldn't restart \(instance.app.name)"
                alert.informativeText = error.localizedDescription
                alert.addButton(withTitle: "OK")
                NSApp.activate(ignoringOtherApps: true)
                alert.runModal()
            }
        }
    }
}

@MainActor
final class RestartPromptAlertController {
    private var alert: NSAlert?
    private var session: NSApplication.ModalSession?
    private var timer: Timer?
    private var completion: ((Bool) -> Void)?

    func show(app: InstalledApp, icon: NSImage? = nil, completion: @escaping (Bool) -> Void) {
        dismiss()
        let alert = NativeRestartAlert.make(appName: app.name, context: .missingExtensions, icon: icon,
            assistedSetupInstructions: ElectronLaunchProfile.profile(for: app)?.assistedSetupInstructions)
        self.alert = alert
        self.completion = completion
        alert.layout()
        NSApp.activate(ignoringOtherApps: true)
        session = NSApp.beginModalSession(for: alert.window)
        alert.window.center()
        alert.window.makeKeyAndOrderFront(nil)
        // A nonblocking AppKit modal session keeps the monitor alive so a
        // connected/closed app or a changed setting can dismiss a stale alert.
        let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.pollResponse() }
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func dismiss() {
        completion = nil
        timer?.invalidate()
        timer = nil
        if let session { NSApp.endModalSession(session) }
        session = nil
        alert?.window.orderOut(nil)
        alert = nil
    }

    private func pollResponse() {
        guard let session else { return }
        let response = NSApp.runModalSession(session)
        guard response != .continue else { return }
        let callback = completion
        dismiss()
        callback?(response == .alertFirstButtonReturn)
    }
}
