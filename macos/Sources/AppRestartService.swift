import AppKit
import Foundation

struct AppRestartProcess: Equatable, Sendable {
    let processIdentifier: Int32
    let bundleIdentifier: String?
    let bundleURL: URL?
    let launchDate: Date?

    func isSameProcess(as other: Self) -> Bool {
        guard let launchDate, let otherDate = other.launchDate,
              launchDate.timeIntervalSinceReferenceDate.isFinite,
              otherDate.timeIntervalSinceReferenceDate.isFinite else { return false }
        return processIdentifier == other.processIdentifier &&
            bundleIdentifier == other.bundleIdentifier &&
            Self.canonicalPath(bundleURL) == Self.canonicalPath(other.bundleURL) &&
            launchDate == otherDate
    }

    static func canonicalPath(_ url: URL?) -> String? {
        guard let url, url.isFileURL else { return nil }
        return url.standardizedFileURL.resolvingSymlinksInPath().path
    }
}

@MainActor
struct AppRestartEnvironment {
    var runningProcesses: () -> [AppRestartProcess]
    var terminate: (AppRestartProcess) -> Bool
    var now: () -> TimeInterval
    var sleep: (TimeInterval) async throws -> Void
    var helperURL: (InstalledApp) -> URL

    static var live: Self {
        Self(
            runningProcesses: {
                NSWorkspace.shared.runningApplications.compactMap { app in
                    guard !app.isTerminated else { return nil }
                    let value = snapshot(app)
                    // Do not mistake a stale LaunchServices registration during
                    // a normal quit for PID reuse. Retain every uncertain/live
                    // identity so the existing fail-closed checks still apply.
                    if value.launchDate == nil && RunningApplicationIdentity.hasDefinitelyExited(processIdentifier: app.processIdentifier) {
                        return nil
                    }
                    return value
                }
            },
            terminate: { expected in
                guard let process = NSRunningApplication(processIdentifier: expected.processIdentifier),
                      !process.isTerminated,
                      snapshot(process).isSameProcess(as: expected) else { return false }
                return process.terminate()
            },
            now: { ProcessInfo.processInfo.systemUptime },
            sleep: { seconds in try await Task.sleep(for: .seconds(seconds)) },
            helperURL: { app in
                ElectronLauncher().directory(for: app)
                    .appendingPathComponent("\(app.name) Launcher.app", isDirectory: true)
            }
        )
    }

    private static func snapshot(_ app: NSRunningApplication) -> AppRestartProcess {
        AppRestartProcess(processIdentifier: app.processIdentifier,
                          bundleIdentifier: app.bundleIdentifier,
                          bundleURL: app.bundleURL, launchDate: RunningApplicationIdentity.startDate(of: app))
    }
}

enum AppRestartError: LocalizedError, Equatable {
    case unsupportedApp, alreadyRestarting, processChanged, missingLaunchDate
    case concurrentReplacement, quitDeclined, timedOut, helperChanged, helperQuitDeclined

    var errorDescription: String? {
        switch self {
        case .unsupportedApp: "This app does not have a supported extension launch profile."
        case .alreadyRestarting: "An app restart is already in progress."
        case .processChanged: "The running app changed. It was not restarted. Try again for the current app."
        case .missingLaunchDate: "The app's launch time could not be confirmed. It was not restarted."
        case .concurrentReplacement: "Another instance of the app started. It was left running; no additional instance was opened."
        case .quitDeclined: "The app did not accept the quit request. Save your work and quit it normally before reopening."
        case .timedOut: "The app or its launcher did not finish quitting within 30 seconds. Nothing was forced to quit or reopened."
        case .helperChanged: "The extension launcher changed or could not be identified. It was left running; reopen after it has quit normally."
        case .helperQuitDeclined: "The extension launcher did not accept the quit request. Close its alert or quit it normally before reopening."
        }
    }
}

/// Called only after the user approves a restart. Never sends force termination.
@MainActor
final class AppRestartService {
    private let environment: AppRestartEnvironment
    private let timeout: TimeInterval
    private var isRestarting = false

    init(environment: AppRestartEnvironment = .live, timeout: TimeInterval = 30) {
        self.environment = environment
        self.timeout = timeout.isFinite ? min(max(timeout, 0), 30) : 30
    }

    func restart(
        app: InstalledApp, processIdentifier: Int32, launchDate: Date?,
        prepare: () throws -> Void, open: () throws -> Void
    ) async throws {
        guard !isRestarting else { throw AppRestartError.alreadyRestarting }
        guard let profile = ElectronLaunchProfile.profile(for: app) else {
            throw AppRestartError.unsupportedApp
        }
        guard let launchDate, launchDate.timeIntervalSinceReferenceDate.isFinite else {
            throw AppRestartError.missingLaunchDate
        }
        guard processIdentifier > 0 else { throw AppRestartError.processChanged }
        isRestarting = true
        defer { isRestarting = false }
        try Task.checkCancellation()

        let expected = AppRestartProcess(processIdentifier: processIdentifier,
                                        bundleIdentifier: profile.targetIdentifier,
                                        bundleURL: profile.targetURL, launchDate: launchDate)
        let helperURL = environment.helperURL(app)
        let initial = environment.runningProcesses()
        try validateTarget(initial, expected: expected, mustBeRunning: true)
        let helper = try initialHelper(in: initial, url: helperURL, identifier: profile.launcherIdentifier)

        // Preparation can fail (or present a modal alert); revalidate afterward
        // before requesting quit so its earlier process snapshot is not trusted.
        try prepare()
        try Task.checkCancellation()
        let prepared = environment.runningProcesses()
        try validateTarget(prepared, expected: expected, mustBeRunning: true)
        _ = try remainingHelper(in: prepared, original: helper, url: helperURL,
                                identifier: profile.launcherIdentifier)
        guard environment.terminate(expected) else { throw AppRestartError.quitDeclined }
        let deadline = environment.now() + timeout

        try await waitUntil(deadline: deadline) { processes in
            try self.validateTarget(processes, expected: expected, mustBeRunning: nil)
            _ = try self.remainingHelper(in: processes, original: helper, url: helperURL,
                                         identifier: profile.launcherIdentifier)
            return !processes.contains { $0.processIdentifier == expected.processIdentifier }
        }

        let afterExit = environment.runningProcesses()
        try validateTarget(afterExit, expected: expected, mustBeRunning: false)
        if let remaining = try remainingHelper(in: afterExit, original: helper, url: helperURL,
                                                identifier: profile.launcherIdentifier) {
            try Task.checkCancellation()
            guard environment.terminate(remaining) else { throw AppRestartError.helperQuitDeclined }
            try await waitUntil(deadline: deadline) { processes in
                try self.validateTarget(processes, expected: expected, mustBeRunning: false)
                return try self.remainingHelper(in: processes, original: helper, url: helperURL,
                                                 identifier: profile.launcherIdentifier) == nil
            }
        }

        try Task.checkCancellation()
        let beforeOpen = environment.runningProcesses()
        try validateTarget(beforeOpen, expected: expected, mustBeRunning: false)
        guard try remainingHelper(in: beforeOpen, original: helper, url: helperURL,
                                  identifier: profile.launcherIdentifier) == nil else {
            throw AppRestartError.helperChanged
        }
        try open()
    }

    private func validateTarget(
        _ processes: [AppRestartProcess], expected: AppRestartProcess, mustBeRunning: Bool?
    ) throws {
        let samePID = processes.first { $0.processIdentifier == expected.processIdentifier }
        if let samePID, !samePID.isSameProcess(as: expected) { throw AppRestartError.processChanged }
        if mustBeRunning == true && samePID == nil { throw AppRestartError.processChanged }
        let replacement = processes.contains {
            $0.bundleIdentifier == expected.bundleIdentifier &&
                AppRestartProcess.canonicalPath($0.bundleURL) == AppRestartProcess.canonicalPath(expected.bundleURL) &&
                !$0.isSameProcess(as: expected)
        }
        if replacement { throw AppRestartError.concurrentReplacement }
        if mustBeRunning == false && samePID != nil { throw AppRestartError.processChanged }
    }

    private func initialHelper(
        in processes: [AppRestartProcess], url: URL, identifier: String
    ) throws -> AppRestartProcess? {
        let candidates = processes.filter {
            $0.bundleIdentifier == identifier ||
                AppRestartProcess.canonicalPath($0.bundleURL) == AppRestartProcess.canonicalPath(url)
        }
        guard candidates.count <= 1 else { throw AppRestartError.helperChanged }
        guard let helper = candidates.first else { return nil }
        guard helper.processIdentifier > 0, helper.bundleIdentifier == identifier,
              AppRestartProcess.canonicalPath(helper.bundleURL) == AppRestartProcess.canonicalPath(url),
              let date = helper.launchDate, date.timeIntervalSinceReferenceDate.isFinite else {
            throw AppRestartError.helperChanged
        }
        return helper
    }

    private func remainingHelper(
        in processes: [AppRestartProcess], original: AppRestartProcess?, url: URL, identifier: String
    ) throws -> AppRestartProcess? {
        if let original, let samePID = processes.first(where: { $0.processIdentifier == original.processIdentifier }),
           !samePID.isSameProcess(as: original) { throw AppRestartError.helperChanged }
        guard let current = try initialHelper(in: processes, url: url, identifier: identifier) else { return nil }
        guard let original, current.isSameProcess(as: original) else { throw AppRestartError.helperChanged }
        return current
    }

    private func waitUntil(
        deadline: TimeInterval, check: ([AppRestartProcess]) throws -> Bool
    ) async throws {
        while true {
            try Task.checkCancellation()
            if try check(environment.runningProcesses()) { return }
            let remaining = deadline - environment.now()
            guard remaining > 0 else { throw AppRestartError.timedOut }
            try await environment.sleep(min(0.2, remaining))
        }
    }
}
