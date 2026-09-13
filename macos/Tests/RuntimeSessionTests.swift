import Darwin
import Foundation
import XCTest
@testable import ExtensionsAnywhere

final class RuntimeSessionTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_100)
    private var launched: Date { now.addingTimeInterval(-30.125) }
    private var app: InstalledApp {
        InstalledApp(id: "/Applications/ChatGPT.app", name: "ChatGPT", bundleIdentifier: "com.openai.codex",
                     url: URL(fileURLWithPath: "/Applications/ChatGPT.app", isDirectory: true))
    }
    private var current: RuntimeSessionSnapshot.RunningProcess {
        .init(pid: 42, launchDate: launched)
    }
    private var session: URL {
        URL(fileURLWithPath: "/Owned/Launchers/chatgpt/Sessions/\(UUID().uuidString)", isDirectory: true)
    }

    private func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private func payload() -> [String: Any] {
        [
            "phase": "active", "appKey": "com.openai.codex", "bundle": app.url.path,
            "pid": 42, "brokerPid": 43, "heartbeatVersion": 1,
            "updatedAt": timestamp(now.addingTimeInterval(-1)),
            "startedAt": timestamp(now.addingTimeInterval(-40)),
            "phaseStartedAt": timestamp(now.addingTimeInterval(-2)),
            "processIdentity": ["pid": 42, "uid": getuid(),
                                "executable": "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
                                "started": String(format: "%.6f", launched.timeIntervalSince1970)]
        ]
    }

    private func parse(_ value: [String: Any], current: RuntimeSessionSnapshot.RunningProcess?, brokerAlive: Bool = true,
                       for selectedApp: InstalledApp? = nil) throws -> RuntimeSessionSnapshot? {
        RuntimeSessionSnapshot.validated(data: try JSONSerialization.data(withJSONObject: value), app: selectedApp ?? app,
                                         sessionDirectory: session, now: now, currentProcess: current,
                                         brokerIsAlive: { pid in
            XCTAssertEqual(pid, 43)
            return brokerAlive
        })
    }

    func testFreshSessionRequiresExactRunningLaunchForHealthyState() throws {
        let value = try XCTUnwrap(parse(payload(), current: current))
        XCTAssertEqual(value.phase, .active)
        XCTAssertEqual(value.pid, 42)
        XCTAssertEqual(value.brokerPid, 43)
        XCTAssertEqual(value.processStartedAt, launched)
        XCTAssertTrue(value.isHealthy)
        XCTAssertFalse(value.isStarting)
        XCTAssertTrue(value.matches(processIdentifier: 42, launchDate: launched))
        XCTAssertFalse(value.matches(processIdentifier: 44, launchDate: launched))
        XCTAssertFalse(value.matches(processIdentifier: 42, launchDate: launched.addingTimeInterval(1)))
        XCTAssertFalse(value.matches(processIdentifier: 42, launchDate: nil))
        XCTAssertFalse(try XCTUnwrap(parse(payload(), current: .init(pid: 44, launchDate: launched))).isHealthy)
        XCTAssertFalse(try XCTUnwrap(parse(payload(), current: .init(pid: 42, launchDate: now))).isHealthy)
        XCTAssertFalse(try XCTUnwrap(parse(payload(), current: nil)).isHealthy)
    }

    func testDeadBrokerAndStaleOrFutureHeartbeatCannotSuppressRestart() throws {
        XCTAssertNil(try parse(payload(), current: current, brokerAlive: false))
        var stale = payload()
        stale["updatedAt"] = timestamp(now.addingTimeInterval(-16))
        stale["phaseStartedAt"] = timestamp(now.addingTimeInterval(-20))
        XCTAssertNil(try parse(stale, current: current))
        var future = payload()
        future["updatedAt"] = timestamp(now.addingTimeInterval(2))
        XCTAssertNil(try parse(future, current: current))
        for version in [0, 2] {
            var changed = payload()
            changed["heartbeatVersion"] = version
            XCTAssertNil(try parse(changed, current: current))
        }
    }

    func testStartingGraceIsBoundedAndDoesNotCoverAnOlderNormalApp() throws {
        var starting = payload()
        starting["phase"] = "starting"
        starting["pid"] = NSNull()
        starting.removeValue(forKey: "processIdentity")
        starting["phaseStartedAt"] = starting["startedAt"]
        let snapshot = try XCTUnwrap(parse(starting, current: nil))
        XCTAssertTrue(snapshot.isStarting)
        XCTAssertFalse(snapshot.isHealthy)
        XCTAssertTrue(try XCTUnwrap(parse(starting, current: current)).isStarting)
        XCTAssertFalse(try XCTUnwrap(parse(starting, current: .init(pid: 44, launchDate: now.addingTimeInterval(-300)))).isStarting)
        starting["startedAt"] = timestamp(now.addingTimeInterval(-61))
        starting["phaseStartedAt"] = starting["startedAt"]
        XCTAssertFalse(try XCTUnwrap(parse(starting, current: nil)).isStarting)
    }

    func testApplyingGraceToleratesLongAwaitButNeverWrongPidOrExpiredPhase() throws {
        var applying = payload()
        applying["phase"] = "applying"
        applying["startedAt"] = timestamp(now.addingTimeInterval(-55))
        applying["phaseStartedAt"] = timestamp(now.addingTimeInterval(-25))
        applying["updatedAt"] = timestamp(now.addingTimeInterval(-20))
        XCTAssertTrue(try XCTUnwrap(parse(applying, current: current)).isStarting)
        XCTAssertFalse(try XCTUnwrap(parse(applying, current: .init(pid: 44, launchDate: launched))).isStarting)
        applying["startedAt"] = timestamp(now.addingTimeInterval(-65))
        applying["phaseStartedAt"] = timestamp(now.addingTimeInterval(-61))
        XCTAssertNil(try parse(applying, current: current))
    }

    func testLegacyActiveSessionNeedsSameLaunchAndLiveBrokerWithoutPidlessGrace() throws {
        let oldLaunch = now.addingTimeInterval(-600)
        let oldCurrent = RuntimeSessionSnapshot.RunningProcess(pid: 42, launchDate: oldLaunch)
        var legacy = payload()
        for field in ["heartbeatVersion", "startedAt", "phaseStartedAt"] { legacy.removeValue(forKey: field) }
        legacy["updatedAt"] = timestamp(now.addingTimeInterval(-300))
        var identity = try XCTUnwrap(legacy["processIdentity"] as? [String: Any])
        identity["started"] = String(format: "%.6f", oldLaunch.timeIntervalSince1970)
        legacy["processIdentity"] = identity
        let snapshot = try XCTUnwrap(parse(legacy, current: oldCurrent))
        XCTAssertTrue(snapshot.isHealthy)
        XCTAssertEqual(snapshot.startedAt, oldLaunch)
        XCTAssertNil(try parse(legacy, current: current))
        XCTAssertNil(try parse(legacy, current: oldCurrent, brokerAlive: false))
        legacy["phase"] = "starting"
        legacy["pid"] = NSNull()
        legacy.removeValue(forKey: "processIdentity")
        XCTAssertNil(try parse(legacy, current: nil))
    }

    func testClaudeAssistedWaitingIsActionableWithoutHealthyOrRestartClaim() throws {
        let claude = InstalledApp(id: "/Applications/Claude.app", name: "Claude",
            bundleIdentifier: "com.anthropic.claudefordesktop", url: URL(fileURLWithPath: "/Applications/Claude.app"))
        let oldLaunch = now.addingTimeInterval(-700)
        let oldCurrent = RuntimeSessionSnapshot.RunningProcess(pid: 42, launchDate: oldLaunch)
        var value = payload()
        value["appKey"] = claude.bundleIdentifier
        value["bundle"] = claude.url.path
        value["startedAt"] = timestamp(now.addingTimeInterval(-600))
        value["phaseStartedAt"] = timestamp(now.addingTimeInterval(-500))
        value["processIdentity"] = ["pid": 42, "uid": getuid(), "executable": "/Applications/Claude.app/Contents/MacOS/Claude",
                                    "started": String(format: "%.6f", oldLaunch.timeIntervalSince1970)]
        for phase in ["waiting-for-debugger", "waiting-for-page"] {
            value["phase"] = phase
            let snapshot = try XCTUnwrap(parse(value, current: oldCurrent, for: claude))
            XCTAssertTrue(snapshot.isWaitingForAssistedSetup)
            XCTAssertFalse(snapshot.isHealthy)
            XCTAssertFalse(snapshot.isStarting)
            XCTAssertTrue(snapshot.suppressesMissingRuntimePrompt(processIdentifier: 42, launchDate: oldLaunch))
            XCTAssertFalse(snapshot.suppressesMissingRuntimePrompt(processIdentifier: 44, launchDate: oldLaunch))
            XCTAssertTrue(try XCTUnwrap(snapshot.assistedSetupStatus).contains(phase == "waiting-for-debugger"
                ? "Enable Main Process Debugger" : "Open a new chat"))
            XCTAssertNil(try parse(value, current: oldCurrent, brokerAlive: false, for: claude))
            XCTAssertFalse(try XCTUnwrap(parse(value, current: nil, for: claude)).isWaitingForAssistedSetup)
            XCTAssertFalse(try XCTUnwrap(parse(value, current: .init(pid: 42, launchDate: now), for: claude)).isWaitingForAssistedSetup)
            var stale = value
            stale["updatedAt"] = timestamp(now.addingTimeInterval(-16))
            XCTAssertNil(try parse(stale, current: oldCurrent, for: claude))
            var legacy = value
            legacy.removeValue(forKey: "heartbeatVersion")
            XCTAssertFalse(try XCTUnwrap(parse(legacy, current: oldCurrent, for: claude)).isWaitingForAssistedSetup)
            var other = payload()
            other["phase"] = phase
            let otherSnapshot = try XCTUnwrap(parse(other, current: current))
            XCTAssertFalse(otherSnapshot.isWaitingForAssistedSetup)
            XCTAssertNil(otherSnapshot.assistedSetupStatus)
            XCTAssertFalse(otherSnapshot.suppressesMissingRuntimePrompt(processIdentifier: 42, launchDate: launched))
        }
    }

    func testMalformedIdentityMetadataAndOversizedStatusAreRejected() throws {
        for (key, value) in [
            ("appKey", "example.other" as Any), ("bundle", "/Applications/Other.app" as Any),
            ("phase", "unknown" as Any), ("pid", -1 as Any), ("pid", true as Any),
            ("brokerPid", 0 as Any), ("brokerPid", 2_147_483_648 as Any),
            ("updatedAt", "yesterday" as Any), ("startedAt", "invalid" as Any)
        ] {
            var changed = payload()
            changed[key] = value
            XCTAssertNil(try parse(changed, current: current), key)
        }
        for (key, value) in [
            ("pid", 44 as Any), ("uid", getuid() + 1 as Any),
            ("executable", "/usr/bin/other" as Any), ("started", "1.1" as Any)
        ] {
            var changed = payload()
            var identity = try XCTUnwrap(changed["processIdentity"] as? [String: Any])
            identity[key] = value
            changed["processIdentity"] = identity
            XCTAssertNil(try parse(changed, current: current), key)
        }
        let oversized = Data(repeating: 32, count: RuntimeSessionFiles.statusLimit + 1)
        XCTAssertNil(RuntimeSessionSnapshot.validated(data: oversized, app: app, sessionDirectory: session,
                                                      now: now, currentProcess: current, brokerIsAlive: { _ in true }))
    }

    private var scriptApp: InstalledApp {
        InstalledApp(id: "/Applications/Style Lab.app", name: "Style Lab", bundleIdentifier: "dev.extensionsanywhere.stylelab",
                     url: URL(fileURLWithPath: "/Applications/Style Lab.app"))
    }

    private func scriptFailurePayload() -> [String: Any] {
        var value = payload()
        value["phase"] = "error"
        value["appKey"] = scriptApp.bundleIdentifier
        value["bundle"] = scriptApp.url.path
        value["processIdentity"] = ["pid": 42, "uid": getuid(),
                                    "executable": "/Applications/Style Lab.app/Contents/MacOS/Style Lab",
                                    "started": String(format: "%.6f", launched.timeIntervalSince1970)]
        value["jsStates"] = [["extensionID": "01234567-89AB-CDEF-0123-456789ABCDEF", "revision": "hash1",
                              "phase": "failed", "generation": 1, "cleanupComplete": true, "reloadBlocked": false]]
        return value
    }

    func testLiveRecoverableScriptFailureDoesNotMasqueradeAsHealthyOrPromptMissingRuntime() throws {
        let snapshot = try XCTUnwrap(parse(scriptFailurePayload(), current: current, for: scriptApp))
        XCTAssertFalse(snapshot.isHealthy)
        XCTAssertFalse(snapshot.isStarting)
        XCTAssertTrue(snapshot.hasRecoverableExtensionFailure)
        XCTAssertTrue(snapshot.suppressesMissingRuntimePrompt(processIdentifier: 42, launchDate: launched))
        XCTAssertFalse(snapshot.suppressesMissingRuntimePrompt(processIdentifier: 44, launchDate: launched))
        XCTAssertFalse(snapshot.suppressesMissingRuntimePrompt(processIdentifier: 42, launchDate: now))
        let instance = RunningTweakInstance(app: scriptApp, processIdentifier: 42, launchDate: launched)
        let observation = RestartPromptPolicy.Observation(instance: instance,
            connectedOrStarting: snapshot.suppressesMissingRuntimePrompt(processIdentifier: 42, launchDate: launched))
        var policy = RestartPromptPolicy(gracePeriod: 45)
        XCTAssertNil(policy.next(observations: [observation], enabled: true, now: now))
        XCTAssertNil(policy.next(observations: [observation], enabled: true, now: now.addingTimeInterval(600)))
    }

    func testScriptFailureCannotSuppressRestartForDeadStaleOrDifferentSession() throws {
        let value = scriptFailurePayload()
        XCTAssertNil(try parse(value, current: current, brokerAlive: false, for: scriptApp))
        XCTAssertFalse(try XCTUnwrap(parse(value, current: nil, for: scriptApp)).hasRecoverableExtensionFailure)
        XCTAssertFalse(try XCTUnwrap(parse(value, current: .init(pid: 44, launchDate: launched), for: scriptApp)).hasRecoverableExtensionFailure)
        var stale = value
        stale["updatedAt"] = timestamp(now.addingTimeInterval(-16))
        stale["phaseStartedAt"] = timestamp(now.addingTimeInterval(-20))
        XCTAssertNil(try parse(stale, current: current, for: scriptApp))
        var legacy = value
        legacy.removeValue(forKey: "heartbeatVersion")
        XCTAssertFalse(try XCTUnwrap(parse(legacy, current: current, for: scriptApp)).hasRecoverableExtensionFailure)
        var chatgpt = payload()
        chatgpt["phase"] = "error"
        chatgpt["jsStates"] = value["jsStates"]
        // The exact built-in ChatGPT adapter now carries the same JS lifecycle
        // states. A live script failure needs editing, not endless restarts.
        XCTAssertTrue(try XCTUnwrap(parse(chatgpt, current: current)).hasRecoverableExtensionFailure)
    }

    func testFatalEmptyDuplicateAndMalformedScriptStatesDoNotSuppressRestart() throws {
        let original = scriptFailurePayload()
        let failed = try XCTUnwrap((original["jsStates"] as? [[String: Any]])?.first)
        func suppressed(_ states: [[String: Any]], phase: String = "error") throws -> Bool {
            var value = original
            value["jsStates"] = states
            value["phase"] = phase
            return try parse(value, current: current, for: scriptApp)?.hasRecoverableExtensionFailure == true
        }
        XCTAssertFalse(try suppressed([]))
        XCTAssertFalse(try suppressed([failed], phase: "stopping"))
        for (key, changed) in [("phase", "active" as Any), ("phase", "unknown" as Any),
            ("cleanupComplete", false as Any), ("reloadBlocked", true as Any),
            ("extensionID", "legacy-id" as Any), ("revision", String(repeating: "x", count: 129) as Any),
            ("generation", 0 as Any), ("cleanupComplete", 1 as Any)] {
            var invalid = failed
            invalid[key] = changed
            XCTAssertFalse(try suppressed([invalid]), key)
        }
        var duplicate = failed
        duplicate["extensionID"] = (failed["extensionID"] as? String)?.lowercased()
        XCTAssertFalse(try suppressed([failed, duplicate]))
        let excessive = (0..<65).map { _ in var state = failed; state["extensionID"] = UUID().uuidString; return state }
        XCTAssertFalse(try suppressed(excessive))
        var active = failed
        active["extensionID"] = UUID().uuidString
        active["phase"] = "active"
        active["cleanupComplete"] = false
        XCTAssertTrue(try suppressed([failed, active]))
    }

    func testPointerRequiresOneCanonicalUUIDChildAndRejectsSymlinkEscape() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("RuntimeSessionTests-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let launcher = root.appendingPathComponent("Launchers/target")
        let sessions = launcher.appendingPathComponent("Sessions")
        let id = UUID().uuidString
        let valid = sessions.appendingPathComponent(id)
        try FileManager.default.createDirectory(at: valid, withIntermediateDirectories: true)
        func pointer(_ path: String) throws -> Data { try JSONSerialization.data(withJSONObject: ["path": path]) }
        XCTAssertEqual(RuntimeSessionFiles.directory(pointer: try pointer(valid.path), launcherDirectory: launcher)?.path, valid.path)
        for path in [
            "relative/\(id)", "file://\(valid.path)", sessions.path + "/../\(id)",
            valid.path + "/extra", sessions.path + "/not-a-uuid", root.path + "/\(id)"
        ] {
            XCTAssertNil(RuntimeSessionFiles.directory(pointer: try pointer(path), launcherDirectory: launcher), path)
        }
        let outside = root.appendingPathComponent("Outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let linked = sessions.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: outside)
        XCTAssertNil(RuntimeSessionFiles.directory(pointer: try pointer(linked.path), launcherDirectory: launcher))
        XCTAssertNil(RuntimeSessionFiles.directory(pointer: Data(repeating: 32, count: RuntimeSessionFiles.pointerLimit + 1), launcherDirectory: launcher))
    }

    func testBoundedFileReadsRejectDirectoriesSymlinksAndOversize() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("RuntimeSessionFilesTests-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("status.json")
        let bytes = Data("{}".utf8)
        try bytes.write(to: file)
        XCTAssertEqual(RuntimeSessionFiles.read(file, limit: 2), bytes)
        XCTAssertNil(RuntimeSessionFiles.read(file, limit: 1))
        XCTAssertNil(RuntimeSessionFiles.read(root, limit: 100))
        let alias = root.appendingPathComponent("alias.json")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: file)
        XCTAssertNil(RuntimeSessionFiles.read(alias, limit: 100))
    }
}
