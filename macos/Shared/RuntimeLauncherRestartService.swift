import AppKit
import Darwin
import Foundation

/// Only the launcher's fixed, reviewed profiles can become restart targets.
public struct RuntimeRestartTarget: Equatable, Sendable {
    public let profile: String
    public let bundleIdentifier: String
    public let bundleURL: URL
    public let executableURL: URL
    /// Claude's official inspector is activated in its UI after launch. An
    /// existing verified process may be borrowed without destroying that setup.
    public var requiresColdStart: Bool { profile != "claude" }
    public var assistedSetupInstructions: String? {
        profile == "claude" ? "In Claude choose Developer → Enable Main Process Debugger after each launch. If needed, first enable Developer Mode from Help → Troubleshooting. Extensions connect after that setup." : nil
    }

    public init?(profile: String) {
        self.profile = profile
        let path: String, executable: String
        if profile == "stylelab" {
            bundleIdentifier = "dev.extensionsanywhere.stylelab"
            path = "/Applications/Style Lab.app"
            executable = path + "/Contents/MacOS/Style Lab"
        } else if profile == "chatgpt" {
            bundleIdentifier = "com.openai.codex"
            path = "/Applications/ChatGPT.app"
            executable = path + "/Contents/MacOS/ChatGPT"
        } else if profile == "claude" {
            bundleIdentifier = RuntimeExtensionSelection.claudeIdentifier
            path = "/Applications/Claude.app"
            executable = path + "/Contents/MacOS/Claude"
        } else if let app = RuntimeAppCatalog.entries.first(where: { $0.slug == profile }) {
            bundleIdentifier = app.bundleIdentifier
            path = app.bundlePath
            executable = app.executable
        } else { return nil }
        bundleURL = URL(fileURLWithPath: path)
        executableURL = URL(fileURLWithPath: executable)
    }
}

public struct RuntimeRestartProcess: Equatable, Sendable {
    public let pid: Int32
    public let uid: UInt32
    public let startedAt: Date
    public let executableURL: URL

    public init(pid: Int32, uid: UInt32, startedAt: Date, executableURL: URL) {
        self.pid = pid
        self.uid = uid
        self.startedAt = startedAt
        self.executableURL = executableURL
    }
}

/// A matching LaunchServices registration is kept even when its identity cannot
/// be read. Only positive kernel exit evidence permits dropping a stale entry.
public struct RuntimeRestartRegistration: Sendable {
    public let pid: Int32
    public let bundleIdentifier: String?
    public let bundleURL: URL?
    public let process: RuntimeRestartProcess?

    public init(pid: Int32, bundleIdentifier: String?, bundleURL: URL?, process: RuntimeRestartProcess?) {
        self.pid = pid
        self.bundleIdentifier = bundleIdentifier
        self.bundleURL = bundleURL
        self.process = process
    }
}

public enum RuntimeRestartObservation: Equatable, Sendable {
    case running(RuntimeRestartProcess), exited, unresolved
}

@MainActor
public struct RuntimeLauncherRestartEnvironment {
    public var registrations: (RuntimeRestartTarget) -> [RuntimeRestartRegistration]
    public var observe: (Int32, RuntimeRestartTarget) -> RuntimeRestartObservation
    public var terminate: (RuntimeRestartProcess, RuntimeRestartTarget) -> Bool
    public var currentUID: () -> UInt32
    public var now: () -> TimeInterval
    public var sleep: (TimeInterval) async throws -> Void

    public init(
        registrations: @escaping (RuntimeRestartTarget) -> [RuntimeRestartRegistration],
        observe: @escaping (Int32, RuntimeRestartTarget) -> RuntimeRestartObservation,
        terminate: @escaping (RuntimeRestartProcess, RuntimeRestartTarget) -> Bool,
        currentUID: @escaping () -> UInt32,
        now: @escaping () -> TimeInterval,
        sleep: @escaping (TimeInterval) async throws -> Void
    ) {
        self.registrations = registrations
        self.observe = observe
        self.terminate = terminate
        self.currentUID = currentUID
        self.now = now
        self.sleep = sleep
    }

    public static var live: Self {
        Self(
            registrations: { target in
                NSWorkspace.shared.runningApplications.compactMap { app in
                    guard app.bundleIdentifier == target.bundleIdentifier ||
                            canonical(app.bundleURL) == target.bundleURL.path else { return nil }
                    let observation = observeKernel(app.processIdentifier, target: target)
                    if observation == .exited { return nil }
                    let process: RuntimeRestartProcess?
                    if case .running(let identity) = observation, !app.isTerminated,
                       canonical(app.executableURL ?? Bundle(url: target.bundleURL)?.executableURL) == target.executableURL.path {
                        process = identity
                    } else { process = nil }
                    return RuntimeRestartRegistration(pid: app.processIdentifier,
                        bundleIdentifier: app.bundleIdentifier, bundleURL: app.bundleURL, process: process)
                }
            },
            observe: { observeKernel($0, target: $1) },
            terminate: { expected, target in
                guard let app = NSRunningApplication(processIdentifier: expected.pid), !app.isTerminated,
                      app.bundleIdentifier == target.bundleIdentifier,
                      canonical(app.bundleURL) == target.bundleURL.path,
                      canonical(app.executableURL ?? Bundle(url: target.bundleURL)?.executableURL) == target.executableURL.path,
                      observeKernel(expected.pid, target: target) == .running(expected) else { return false }
                return app.terminate()
            },
            currentUID: { getuid() },
            now: { ProcessInfo.processInfo.systemUptime },
            sleep: { try await Task.sleep(for: .seconds($0)) }
        )
    }

    private static func observeKernel(_ pid: Int32, target: RuntimeRestartTarget) -> RuntimeRestartObservation {
        if let started = RuntimeProcessIdentity.kernelStartDate(processIdentifier: pid,
                                                                expectedExecutable: target.executableURL) {
            return .running(RuntimeRestartProcess(pid: pid, uid: getuid(), startedAt: started,
                                                  executableURL: target.executableURL))
        }
        return RuntimeProcessIdentity.hasDefinitelyExited(processIdentifier: pid) ? .exited : .unresolved
    }

    fileprivate static func canonical(_ url: URL?) -> String? {
        guard let url, url.isFileURL else { return nil }
        return url.standardizedFileURL.resolvingSymlinksInPath().path
    }
}

public enum RuntimeLauncherRestartError: LocalizedError, Equatable {
    case ambiguousApp, identityChanged, quitDeclined, timedOut, alreadyRestarting

    public var errorDescription: String? {
        switch self {
        case .ambiguousApp: "Another or unidentified instance of this app is running. No app was restarted."
        case .identityChanged: "The selected app changed or its process identity could not be confirmed. No replacement was opened."
        case .quitDeclined: "The app did not accept the quit request. Save your work and quit it normally before reopening."
        case .timedOut: "The app did not finish quitting within 30 seconds. Nothing was forced to quit or reopened."
        case .alreadyRestarting: "An app restart is already in progress."
        }
    }
}

/// Caller presents confirmation first. Cancellation and failed identity checks
/// never reach the final launch callback; quit is a normal NSRunningApplication request.
@MainActor
public final class RuntimeLauncherRestartService {
    private let environment: RuntimeLauncherRestartEnvironment
    private let timeout: TimeInterval
    private var isRestarting = false

    public init(environment: RuntimeLauncherRestartEnvironment = .live, timeout: TimeInterval = 30) {
        self.environment = environment
        self.timeout = timeout.isFinite ? min(max(timeout, 0), 30) : 30
    }

    /// Capture before showing the alert, so approval cannot transfer to a new PID.
    public func selectedProcess(for target: RuntimeRestartTarget) throws -> RuntimeRestartProcess? {
        let candidates = relatedRegistrations(target)
        guard candidates.count <= 1 else { throw RuntimeLauncherRestartError.ambiguousApp }
        guard let candidate = candidates.first else { return nil }
        guard exactRegistration(candidate, target: target), let process = candidate.process,
              valid(process, target: target),
              environment.observe(process.pid, target) == .running(process) else {
            throw RuntimeLauncherRestartError.identityChanged
        }
        return process
    }

    public func restart(
        target: RuntimeRestartTarget, selected: RuntimeRestartProcess,
        launch: () throws -> Void
    ) async throws {
        guard !isRestarting else { throw RuntimeLauncherRestartError.alreadyRestarting }
        isRestarting = true
        defer { isRestarting = false }
        try Task.checkCancellation()
        guard valid(selected, target: target), try selectedProcess(for: target) == selected else {
            throw RuntimeLauncherRestartError.identityChanged
        }
        try Task.checkCancellation()
        guard environment.terminate(selected, target) else { throw RuntimeLauncherRestartError.quitDeclined }
        let deadline = environment.now() + timeout
        while true {
            try Task.checkCancellation()
            if try hasExited(selected, target: target) {
                try Task.checkCancellation()
                // Recheck before launch, while a transient old registration can
                // still use the remaining quit deadline rather than fail early.
                if try hasExited(selected, target: target) { break }
            }
            let remaining = deadline - environment.now()
            guard remaining > 0 else { throw RuntimeLauncherRestartError.timedOut }
            try await environment.sleep(min(0.2, remaining))
        }
        try Task.checkCancellation()
        try launch()
    }

    private func hasExited(_ selected: RuntimeRestartProcess, target: RuntimeRestartTarget) throws -> Bool {
        let candidates = relatedRegistrations(target)
        guard candidates.count <= 1 else { throw RuntimeLauncherRestartError.ambiguousApp }
        for candidate in candidates {
            guard candidate.pid == selected.pid,
                  candidate.bundleIdentifier == target.bundleIdentifier,
                  RuntimeLauncherRestartEnvironment.canonical(candidate.bundleURL) == target.bundleURL.path,
                  candidate.process == nil || candidate.process == selected else {
                throw RuntimeLauncherRestartError.ambiguousApp
            }
        }
        switch environment.observe(selected.pid, target) {
        // AppKit may mark the exact old registration terminated between its
        // kernel read and snapshot construction, leaving process=nil. After our
        // validated normal quit only, wait for that registration to disappear.
        // It is never positive exit evidence and never authorizes another quit.
        case .exited: return candidates.isEmpty
        case .running(let current) where current == selected: return false
        case .unresolved where !candidates.isEmpty: return false
        default: throw RuntimeLauncherRestartError.identityChanged
        }
    }

    private func relatedRegistrations(_ target: RuntimeRestartTarget) -> [RuntimeRestartRegistration] {
        environment.registrations(target).filter {
            $0.bundleIdentifier == target.bundleIdentifier ||
                RuntimeLauncherRestartEnvironment.canonical($0.bundleURL) == target.bundleURL.path
        }
    }

    private func exactRegistration(_ registration: RuntimeRestartRegistration, target: RuntimeRestartTarget) -> Bool {
        registration.bundleIdentifier == target.bundleIdentifier &&
            RuntimeLauncherRestartEnvironment.canonical(registration.bundleURL) == target.bundleURL.path &&
            registration.pid == registration.process?.pid
    }

    private func valid(_ process: RuntimeRestartProcess, target: RuntimeRestartTarget) -> Bool {
        process.pid > 0 && process.uid == environment.currentUID() &&
            process.startedAt.timeIntervalSince1970.isFinite && process.startedAt.timeIntervalSince1970 > 0 &&
            RuntimeLauncherRestartEnvironment.canonical(process.executableURL) == target.executableURL.path
    }
}
