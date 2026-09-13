import Foundation
import XCTest
@testable import RuntimeCatalog

@MainActor
final class RuntimeLauncherRestartServiceTests: XCTestCase {
    private let target = RuntimeRestartTarget(profile: "stylelab")!

    @MainActor
    private final class State {
        var registrations: [RuntimeRestartRegistration] = []
        var observation: RuntimeRestartObservation = .unresolved
        var terminated: [RuntimeRestartProcess] = []
        var events: [String] = []
        var time: TimeInterval = 0
        var acceptsQuit = true
        var onSleep: ((State) throws -> Void)?
        var onObserve: ((State) -> RuntimeRestartObservation)?
        var environment: RuntimeLauncherRestartEnvironment {
            RuntimeLauncherRestartEnvironment(
                registrations: { _ in self.registrations },
                observe: { _, _ in self.onObserve?(self) ?? self.observation },
                terminate: { process, _ in
                    self.terminated.append(process)
                    self.events.append("quit")
                    return self.acceptsQuit
                },
                currentUID: { 501 }, now: { self.time },
                sleep: { interval in
                    self.time += interval
                    try self.onSleep?(self)
                }
            )
        }

        func exit() {
            registrations = []
            observation = .exited
            events.append("exited")
        }
    }

    private func process(pid: Int32 = 42, uid: UInt32 = 501, started: Double = 1_000,
                         executable: URL? = nil) -> RuntimeRestartProcess {
        .init(pid: pid, uid: uid, startedAt: Date(timeIntervalSince1970: started),
              executableURL: executable ?? target.executableURL)
    }

    private func registration(_ process: RuntimeRestartProcess?, pid: Int32 = 42,
                              identifier: String? = nil, bundleURL: URL? = nil) -> RuntimeRestartRegistration {
        .init(pid: process?.pid ?? pid, bundleIdentifier: identifier ?? target.bundleIdentifier,
              bundleURL: bundleURL ?? target.bundleURL, process: process)
    }

    private func state(_ process: RuntimeRestartProcess) -> State {
        let state = State()
        state.registrations = [registration(process)]
        state.observation = .running(process)
        return state
    }

    private func expectError(_ expected: RuntimeLauncherRestartError,
                             operation: () async throws -> Void,
                             file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Expected \(expected)", file: file, line: line) }
        catch { XCTAssertEqual(error as? RuntimeLauncherRestartError, expected, file: file, line: line) }
    }

    func testOnlyFixedProfilesCanBecomeTargets() {
        XCTAssertNil(RuntimeRestartTarget(profile: "/Applications/Other.app"))
        XCTAssertNil(RuntimeRestartTarget(profile: "unknown-app"))
        XCTAssertEqual(RuntimeRestartTarget(profile: "chatgpt")?.bundleIdentifier, "com.openai.codex")
        for app in RuntimeAppCatalog.entries {
            let target = RuntimeRestartTarget(profile: app.slug)
            XCTAssertEqual(target?.bundleIdentifier, app.bundleIdentifier)
            XCTAssertEqual(target?.executableURL.path, app.executable)
        }
    }

    func testSelectionIsReadOnlyAndNormalRestartWaitsForPositiveExit() async throws {
        let original = process(), state = state(process())
        let service = RuntimeLauncherRestartService(environment: state.environment)
        let selected = try XCTUnwrap(service.selectedProcess(for: target))
        XCTAssertEqual(selected, original)
        XCTAssertTrue(state.terminated.isEmpty) // Cancel can simply discard this selection.
        state.onSleep = { $0.exit() }
        try await service.restart(target: target, selected: selected) { state.events.append("launch") }
        XCTAssertEqual(state.terminated, [original])
        XCTAssertEqual(state.events, ["quit", "exited", "launch"])
    }

    func testPIDStartUIDAndExecutableChangesAfterConfirmationDoNotQuitAnything() async {
        let original = process()
        let changed = [process(pid: 43), process(uid: 502), process(started: 1_001),
                       process(executable: URL(fileURLWithPath: "/Applications/Other.app/Contents/MacOS/Other"))]
        for replacement in changed {
            let state = state(replacement)
            let service = RuntimeLauncherRestartService(environment: state.environment)
            await expectError(.identityChanged) {
                try await service.restart(target: target, selected: original) { state.events.append("launch") }
            }
            XCTAssertTrue(state.terminated.isEmpty)
            XCTAssertFalse(state.events.contains("launch"))
        }
    }

    func testMatchingBundleIDAtAnotherPathAndMatchingPathWithDifferentIDAreRejected() throws {
        for registration in [
            registration(process(), bundleURL: URL(fileURLWithPath: "/Users/test/Style Lab.app")),
            registration(process(), identifier: "different.identifier"),
            registration(nil)
        ] {
            let state = state(process())
            state.registrations = [registration]
            let service = RuntimeLauncherRestartService(environment: state.environment)
            XCTAssertThrowsError(try service.selectedProcess(for: target))
            XCTAssertTrue(state.terminated.isEmpty)
        }
    }

    func testDuplicateInstancesCannotReachQuit() async {
        let original = process(), state = state(process())
        state.registrations.append(registration(process(pid: 43)))
        let service = RuntimeLauncherRestartService(environment: state.environment)
        await expectError(.ambiguousApp) {
            try await service.restart(target: target, selected: original) { state.events.append("launch") }
        }
        XCTAssertTrue(state.terminated.isEmpty)
    }

    func testQuitDeclinedNeverWaitsOrLaunches() async {
        let original = process(), state = state(process())
        state.acceptsQuit = false
        let service = RuntimeLauncherRestartService(environment: state.environment)
        await expectError(.quitDeclined) {
            try await service.restart(target: target, selected: original) { state.events.append("launch") }
        }
        XCTAssertEqual(state.terminated, [original])
        XCTAssertEqual(state.time, 0)
        XCTAssertEqual(state.events, ["quit"])
    }

    func testMissingRegistrationDoesNotMeanAStillLiveKernelProcessExited() async {
        let original = process(), state = state(process())
        state.onSleep = { $0.registrations = [] }
        let service = RuntimeLauncherRestartService(environment: state.environment, timeout: 0.6)
        await expectError(.timedOut) {
            try await service.restart(target: target, selected: original) { state.events.append("launch") }
        }
        XCTAssertEqual(state.terminated, [original])
        XCTAssertEqual(state.time, 0.6, accuracy: 0.0001)
        XCTAssertFalse(state.events.contains("launch"))
    }

    func testNormalQuitRetriesExactOldRegistrationWhileItsIdentityDisappears() async throws {
        let original = process(), state = state(process())
        var observations = 0
        state.onSleep = { state in
            observations += 1
            switch observations {
            case 1:
                // AppKit can flip isTerminated after collecting a live kernel
                // identity, causing its registration snapshot to omit process.
                state.registrations = [self.registration(nil)]
                state.observation = .running(original)
            case 2:
                state.observation = .unresolved
            case 3:
                // Positive kernel exit still does not make this stale entry a
                // new app. Wait for the next registry read to discard it.
                state.observation = .exited
            default:
                state.exit()
            }
        }
        let service = RuntimeLauncherRestartService(environment: state.environment)
        try await service.restart(target: target, selected: original) {
            XCTAssertEqual(observations, 4)
            XCTAssertTrue(state.registrations.isEmpty)
            state.events.append("launch")
        }
        XCTAssertEqual(state.terminated, [original])
        XCTAssertEqual(state.events, ["quit", "exited", "launch"])
    }

    func testPersistentlyUnreadableOldRegistrationTimesOutWithoutAnotherQuitOrLaunch() async {
        let original = process(), state = state(process())
        state.onSleep = { state in
            state.registrations = [self.registration(nil)]
            state.observation = .unresolved
        }
        let service = RuntimeLauncherRestartService(environment: state.environment, timeout: 0.6)
        await expectError(.timedOut) {
            try await service.restart(target: target, selected: original) { state.events.append("launch") }
        }
        XCTAssertEqual(state.time, 0.6, accuracy: 0.0001)
        XCTAssertEqual(state.terminated, [original])
        XCTAssertEqual(state.events, ["quit"])
    }

    func testStaleRegistrationDoesNotHideKernelIdentityChange() async {
        let original = process()
        for replacement in [process(started: 1_001), process(uid: 502),
                            process(executable: URL(fileURLWithPath: "/Applications/Other.app/Contents/MacOS/Other"))] {
            let state = state(original)
            state.onSleep = { state in
                state.registrations = [self.registration(nil)]
                state.observation = .running(replacement)
            }
            let service = RuntimeLauncherRestartService(environment: state.environment)
            await expectError(.identityChanged) {
                try await service.restart(target: target, selected: original) { state.events.append("launch") }
            }
            XCTAssertEqual(state.terminated, [original])
            XCTAssertEqual(state.events, ["quit"])
        }
    }

    func testUnidentifiedReplacementRegistrationIsNotTreatedAsTheOldAppExiting() async {
        let original = process()
        let replacements = [registration(nil, pid: 99),
                            registration(nil, identifier: "different.identifier"),
                            registration(nil, bundleURL: URL(fileURLWithPath: "/Users/test/Style Lab.app"))]
        for replacement in replacements {
            let state = state(original)
            state.onSleep = { state in
                state.registrations = [replacement]
                state.observation = .exited
            }
            let service = RuntimeLauncherRestartService(environment: state.environment)
            await expectError(.ambiguousApp) {
                try await service.restart(target: target, selected: original) { state.events.append("launch") }
            }
            XCTAssertEqual(state.terminated, [original])
            XCTAssertEqual(state.events, ["quit"])
        }
    }

    func testTimeoutIsCappedAtThirtySecondsAndNeverRepeatsQuit() async {
        let original = process(), state = state(process())
        let service = RuntimeLauncherRestartService(environment: state.environment, timeout: 500)
        await expectError(.timedOut) {
            try await service.restart(target: target, selected: original) { state.events.append("launch") }
        }
        XCTAssertEqual(state.time, 30, accuracy: 0.0001)
        XCTAssertEqual(state.terminated, [original])
    }

    func testKernelPIDReuseOrUnreadableIdentityDuringQuitPreventsLaunch() async {
        for next in [RuntimeRestartObservation.running(process(started: 1_001)), .unresolved] {
            let original = process(), state = state(process())
            state.onSleep = { $0.registrations = []; $0.observation = next }
            let service = RuntimeLauncherRestartService(environment: state.environment)
            await expectError(.identityChanged) {
                try await service.restart(target: target, selected: original) { state.events.append("launch") }
            }
            XCTAssertEqual(state.terminated, [original])
            XCTAssertFalse(state.events.contains("launch"))
        }
    }

    func testNewInstanceDuringQuitIsPreservedAndNoAdditionalInstanceOpens() async {
        let original = process(), state = state(process()), replacement = process(pid: 99)
        state.onSleep = { state in
            state.observation = .exited
            state.registrations = [self.registration(replacement)]
        }
        let service = RuntimeLauncherRestartService(environment: state.environment)
        await expectError(.ambiguousApp) {
            try await service.restart(target: target, selected: original) { state.events.append("launch") }
        }
        XCTAssertEqual(state.terminated, [original])
        XCTAssertEqual(state.registrations.first?.process, replacement)
        XCTAssertFalse(state.events.contains("launch"))
    }

    func testCancellationBeforeRestartLeavesOriginalUntouched() async {
        let original = process(), state = state(process())
        let service = RuntimeLauncherRestartService(environment: state.environment)
        let task = Task { @MainActor in
            try await service.restart(target: target, selected: original) { state.events.append("launch") }
        }
        task.cancel()
        do { try await task.value; XCTFail("Expected cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(state.terminated.isEmpty)
        XCTAssertTrue(state.events.isEmpty)
    }

    func testCancellationDuringWaitCannotLaunchEvenIfTargetExitsAtTheSameTime() async {
        let original = process(), state = state(process())
        let service = RuntimeLauncherRestartService(environment: state.environment)
        state.onSleep = { state in
            state.exit()
            withUnsafeCurrentTask { $0?.cancel() }
        }
        let task = Task { @MainActor in
            try await service.restart(target: target, selected: original) { state.events.append("launch") }
        }
        do { try await task.value; XCTFail("Expected cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(state.terminated, [original])
        XCTAssertEqual(state.events, ["quit", "exited"])
    }

    func testFinalRecheckCatchesReplacementAfterFirstExitObservation() async {
        let original = process(), state = state(process()), replacement = process(pid: 99)
        state.onSleep = { state in
            state.exit()
            state.onObserve = { state in
                state.registrations = [self.registration(replacement)]
                return .exited
            }
        }
        let service = RuntimeLauncherRestartService(environment: state.environment)
        await expectError(.ambiguousApp) {
            try await service.restart(target: target, selected: original) { state.events.append("launch") }
        }
        XCTAssertEqual(state.terminated, [original])
        XCTAssertFalse(state.events.contains("launch"))
    }

    func testRelaunchValidationErrorIsPropagatedWithoutASecondQuit() async {
        enum Failure: Error { case configurationChanged }
        let original = process(), state = state(process())
        state.onSleep = { $0.exit() }
        let service = RuntimeLauncherRestartService(environment: state.environment)
        do {
            try await service.restart(target: target, selected: original) { throw Failure.configurationChanged }
            XCTFail("Expected configuration validation failure")
        } catch { XCTAssertTrue(error is Failure) }
        XCTAssertEqual(state.terminated, [original])
    }
}
