import Foundation
import XCTest
@testable import ExtensionsAnywhere

@MainActor
final class AppRestartServiceTests: XCTestCase {
    private enum Failure: Error { case preparation }

    @MainActor
    private final class ProcessState {
        static let helperURL = URL(fileURLWithPath: "/AppRestartServiceTests/Style Lab Launcher.app")
        var processes: [AppRestartProcess]
        var terminated: [AppRestartProcess] = []
        var events: [String] = []
        var time: TimeInterval = 0
        var onTerminate: ((ProcessState, AppRestartProcess) -> Bool)?
        var onSleep: ((ProcessState, TimeInterval) -> Void)?

        init(_ processes: [AppRestartProcess]) { self.processes = processes }

        var environment: AppRestartEnvironment {
            AppRestartEnvironment(
                runningProcesses: { self.processes },
                terminate: { process in
                    self.terminated.append(process)
                    self.events.append("terminate:\(process.processIdentifier)")
                    return self.onTerminate?(self, process) ?? true
                },
                now: { self.time },
                sleep: { interval in
                    self.time += interval
                    self.onSleep?(self, interval)
                },
                helperURL: { _ in Self.helperURL }
            )
        }
    }

    private var app: InstalledApp {
        InstalledApp(id: ElectronLaunchProfile.fixtureURL.path, name: "Style Lab",
                     bundleIdentifier: ElectronLaunchProfile.fixtureKey, url: ElectronLaunchProfile.fixtureURL)
    }

    private func target(pid: Int32 = 101, date: Date? = Date(timeIntervalSince1970: 1_000)) -> AppRestartProcess {
        AppRestartProcess(processIdentifier: pid, bundleIdentifier: app.bundleIdentifier,
                          bundleURL: app.url, launchDate: date)
    }

    private func helper(date: Date = Date(timeIntervalSince1970: 900)) -> AppRestartProcess {
        AppRestartProcess(processIdentifier: 202,
                          bundleIdentifier: ElectronLaunchProfile.Profile.stylelab.launcherIdentifier,
                          bundleURL: ProcessState.helperURL, launchDate: date)
    }

    private func expectError(_ expected: AppRestartError, file: StaticString = #filePath, line: UInt = #line,
                             operation: () async throws -> Void) async {
        do {
            try await operation()
            XCTFail("Expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? AppRestartError, expected, file: file, line: line)
        }
    }

    func testRestartWaitsForTargetThenHelperBeforeOpening() async throws {
        let target = target(), helper = helper()
        let state = ProcessState([target, helper])
        state.onSleep = { state, _ in
            if state.processes.contains(target) {
                state.processes.removeAll { $0 == target }
                state.events.append("target exited")
            } else if state.terminated.contains(helper) {
                state.processes.removeAll { $0 == helper }
                state.events.append("helper exited")
            }
        }
        let service = AppRestartService(environment: state.environment)
        try await service.restart(app: app, processIdentifier: target.processIdentifier, launchDate: target.launchDate,
                                  prepare: { state.events.append("prepare") },
                                  open: {
                                      XCTAssertTrue(state.processes.isEmpty)
                                      state.events.append("open")
                                  })
        XCTAssertEqual(state.terminated, [target, helper])
        XCTAssertEqual(state.events, ["prepare", "terminate:101", "target exited", "terminate:202", "helper exited", "open"])
    }

    func testDeclinedTargetQuitDoesNotTouchHelperOrOpen() async {
        let target = target(), helper = helper()
        let state = ProcessState([target, helper])
        state.onTerminate = { _, _ in false }
        let service = AppRestartService(environment: state.environment)
        await expectError(.quitDeclined) {
            try await service.restart(app: app, processIdentifier: target.processIdentifier, launchDate: target.launchDate,
                                      prepare: { state.events.append("prepare") },
                                      open: { state.events.append("open") })
        }
        XCTAssertEqual(state.terminated, [target])
        XCTAssertEqual(state.processes, [target, helper])
        XCTAssertEqual(state.events, ["prepare", "terminate:101"])
        XCTAssertEqual(state.time, 0)
    }

    func testTargetTimeoutDoesNotRepeatTerminationOrOpen() async {
        let target = target(), helper = helper()
        let state = ProcessState([target, helper])
        let service = AppRestartService(environment: state.environment, timeout: 1)
        await expectError(.timedOut) {
            try await service.restart(app: app, processIdentifier: target.processIdentifier, launchDate: target.launchDate,
                                      prepare: { state.events.append("prepare") },
                                      open: { state.events.append("open") })
        }
        XCTAssertEqual(state.terminated, [target])
        XCTAssertEqual(state.processes, [target, helper])
        XCTAssertFalse(state.events.contains("open"))
        XCTAssertGreaterThanOrEqual(state.time, 1)
        XCTAssertLessThanOrEqual(state.time, 1.001)
    }

    func testHelperWaitSharesTargetDeadline() async {
        let target = target(), helper = helper()
        let state = ProcessState([target, helper])
        state.onSleep = { state, _ in
            if state.time >= 0.75 { state.processes.removeAll { $0 == target } }
        }
        let service = AppRestartService(environment: state.environment, timeout: 1)
        await expectError(.timedOut) {
            try await service.restart(app: app, processIdentifier: target.processIdentifier, launchDate: target.launchDate,
                                      prepare: {}, open: { state.events.append("open") })
        }
        XCTAssertEqual(state.terminated, [target, helper])
        XCTAssertEqual(state.processes, [helper])
        XCTAssertFalse(state.events.contains("open"))
        XCTAssertGreaterThanOrEqual(state.time, 1)
        XCTAssertLessThanOrEqual(state.time, 1.001)
    }

    func testPIDOrLaunchDateChangedDuringPreparationPreventsTermination() async {
        let original = target()
        let replacements = [target(pid: 303), target(date: Date(timeIntervalSince1970: 2_000))]
        for replacement in replacements {
            let state = ProcessState([original])
            let service = AppRestartService(environment: state.environment)
            await expectError(.processChanged) {
                try await service.restart(app: app, processIdentifier: original.processIdentifier, launchDate: original.launchDate,
                                          prepare: {
                                              state.events.append("prepare")
                                              state.processes = [replacement]
                                          }, open: { state.events.append("open") })
            }
            XCTAssertTrue(state.terminated.isEmpty)
            XCTAssertEqual(state.processes, [replacement])
            XCTAssertEqual(state.events, ["prepare"])
        }
    }

    func testAutomaticTargetReplacementAfterQuitPreventsOpening() async {
        let original = target(), replacement = target(pid: 303, date: Date(timeIntervalSince1970: 2_000))
        let helper = helper()
        let state = ProcessState([original, helper])
        state.onSleep = { state, _ in state.processes = [replacement, helper] }
        let service = AppRestartService(environment: state.environment)
        await expectError(.concurrentReplacement) {
            try await service.restart(app: app, processIdentifier: original.processIdentifier, launchDate: original.launchDate,
                                      prepare: {}, open: { state.events.append("open") })
        }
        XCTAssertEqual(state.terminated, [original])
        XCTAssertEqual(state.processes, [replacement, helper])
        XCTAssertFalse(state.events.contains("open"))
    }

    func testPreparationFailureLeavesProcessesRunningAndPropagatesError() async {
        let target = target(), helper = helper()
        let state = ProcessState([target, helper])
        let service = AppRestartService(environment: state.environment)
        do {
            try await service.restart(app: app, processIdentifier: target.processIdentifier, launchDate: target.launchDate,
                                      prepare: { throw Failure.preparation }, open: { state.events.append("open") })
            XCTFail("Expected the preparation error")
        } catch {
            XCTAssertTrue(error is Failure)
        }
        XCTAssertTrue(state.terminated.isEmpty)
        XCTAssertEqual(state.processes, [target, helper])
        XCTAssertTrue(state.events.isEmpty)
    }

    func testChangedHelperIdentityAfterTargetExitIsNeverTerminated() async {
        let target = target(), originalHelper = helper(), replacement = helper(date: Date(timeIntervalSince1970: 2_000))
        let state = ProcessState([target, originalHelper])
        state.onSleep = { state, _ in state.processes = [replacement] }
        let service = AppRestartService(environment: state.environment)
        await expectError(.helperChanged) {
            try await service.restart(app: app, processIdentifier: target.processIdentifier, launchDate: target.launchDate,
                                      prepare: {}, open: { state.events.append("open") })
        }
        XCTAssertEqual(state.terminated, [target])
        XCTAssertEqual(state.processes, [replacement])
        XCTAssertFalse(state.events.contains("open"))
    }

    func testDeclinedHelperQuitPreventsOpeningWithoutAnotherQuitRequest() async {
        let target = target(), helper = helper()
        let state = ProcessState([target, helper])
        state.onTerminate = { _, process in process != helper }
        state.onSleep = { state, _ in state.processes.removeAll { $0 == target } }
        let service = AppRestartService(environment: state.environment)
        await expectError(.helperQuitDeclined) {
            try await service.restart(app: app, processIdentifier: target.processIdentifier, launchDate: target.launchDate,
                                      prepare: {}, open: { state.events.append("open") })
        }
        XCTAssertEqual(state.terminated, [target, helper])
        XCTAssertEqual(state.processes, [helper])
        XCTAssertFalse(state.events.contains("open"))
    }

    func testMissingLaunchDateFailsBeforePreparation() async {
        let target = target(date: nil)
        let state = ProcessState([target])
        let service = AppRestartService(environment: state.environment)
        await expectError(.missingLaunchDate) {
            try await service.restart(app: app, processIdentifier: target.processIdentifier, launchDate: nil,
                                      prepare: { state.events.append("prepare") }, open: { state.events.append("open") })
        }
        XCTAssertTrue(state.terminated.isEmpty)
        XCTAssertTrue(state.events.isEmpty)
    }

    func testCopiedAppOutsideFixedProfileIsNeverPreparedOrTerminated() async {
        let original = target()
        let copiedURL = URL(fileURLWithPath: "/AppRestartServiceTests/Style Lab.app")
        let copied = InstalledApp(id: copiedURL.path, name: "Style Lab",
                                  bundleIdentifier: app.bundleIdentifier, url: copiedURL)
        let state = ProcessState([original])
        let service = AppRestartService(environment: state.environment)
        await expectError(.unsupportedApp) {
            try await service.restart(app: copied, processIdentifier: original.processIdentifier,
                                      launchDate: original.launchDate,
                                      prepare: { state.events.append("prepare") },
                                      open: { state.events.append("open") })
        }
        XCTAssertTrue(state.terminated.isEmpty)
        XCTAssertTrue(state.events.isEmpty)
    }
}
