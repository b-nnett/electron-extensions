import AppKit
import Darwin
import Foundation
import XCTest
@testable import ExtensionsAnywhere

final class RunningApplicationIdentityTests: XCTestCase {
    func testExitEvidenceRequiresStableZombieAndNeverTreatsLiveOrReusedPIDAsExited() {
        let dead = RunningApplicationIdentity.KernelSnapshot(pid: 42, uid: 501, status: 5, seconds: 100, microseconds: 1)
        XCTAssertTrue(RunningApplicationIdentity.confirmsExited(before: dead, after: dead, expectedPID: 42))
        for status: UInt32 in 1...4 {
            let live = RunningApplicationIdentity.KernelSnapshot(pid: 42, uid: 501, status: status, seconds: 100, microseconds: 1)
            XCTAssertFalse(RunningApplicationIdentity.confirmsExited(before: dead, after: live, expectedPID: 42))
        }
        let reused = RunningApplicationIdentity.KernelSnapshot(pid: 42, uid: 501, status: 5, seconds: 101, microseconds: 1)
        XCTAssertFalse(RunningApplicationIdentity.confirmsExited(before: dead, after: reused, expectedPID: 42))
        XCTAssertFalse(RunningApplicationIdentity.confirmsExited(before: dead, after: dead, expectedPID: 43))
        XCTAssertFalse(RunningApplicationIdentity.hasDefinitelyExited(processIdentifier: getpid()))
    }
    private let executable = URL(fileURLWithPath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT")

    private func snapshot(pid: Int32 = 42, uid: UInt32 = 501, status: UInt32 = 2,
                          seconds: UInt64 = 1_800_000_000, microseconds: UInt64 = 123_456) -> RunningApplicationIdentity.KernelSnapshot {
        .init(pid: pid, uid: uid, status: status, seconds: seconds, microseconds: microseconds)
    }

    private func date(before: RunningApplicationIdentity.KernelSnapshot, after: RunningApplicationIdentity.KernelSnapshot,
                      path: URL? = nil) -> Date? {
        RunningApplicationIdentity.validatedStartDate(before: before, after: after, expectedPID: 42,
                                                      expectedUID: 501, kernelExecutable: path ?? executable,
                                                      expectedExecutable: executable)
    }

    func testStableKernelStartRetainsMicrosecondsAcrossLiveStateChanges() {
        let expected = Date(timeIntervalSince1970: 1_800_000_000.123456)
        XCTAssertEqual(date(before: snapshot(), after: snapshot()), expected)
        XCTAssertEqual(date(before: snapshot(status: 2), after: snapshot(status: 3)), expected)
        XCTAssertEqual(date(before: snapshot(status: 4), after: snapshot(status: 2)), expected)
    }

    func testPIDReuseUserChangesAndUnknownOrZombieStateRejectIdentity() {
        let changed = [
            snapshot(pid: 43), snapshot(uid: 502), snapshot(seconds: 1_800_000_001),
            snapshot(microseconds: 123_457), snapshot(status: 0), snapshot(status: 5), snapshot(status: 6)
        ]
        for value in changed {
            XCTAssertNil(date(before: snapshot(), after: value))
            XCTAssertNil(date(before: value, after: snapshot()))
        }
        XCTAssertNil(date(before: snapshot(seconds: 0), after: snapshot(seconds: 0)))
        XCTAssertNil(date(before: snapshot(microseconds: 1_000_000), after: snapshot(microseconds: 1_000_000)))
    }

    func testExecutableMustMatchExactlyAndBeLocal() {
        XCTAssertNil(date(before: snapshot(), after: snapshot(), path: URL(fileURLWithPath: executable.path + " Helper")))
        XCTAssertNil(date(before: snapshot(), after: snapshot(), path: URL(string: "https://example.com/ChatGPT")!))
    }

    func testLiveKernelIdentityOfCurrentTestProcessWithoutAppKitRegistration() throws {
        let currentExecutable = try XCTUnwrap(Bundle.main.executableURL)
        let first = try XCTUnwrap(RunningApplicationIdentity.kernelStartDate(processIdentifier: getpid(), expectedExecutable: currentExecutable))
        let second = RunningApplicationIdentity.kernelStartDate(processIdentifier: getpid(), expectedExecutable: currentExecutable)
        XCTAssertEqual(first, second)
        XCTAssertLessThanOrEqual(first, Date())
        XCTAssertNil(RunningApplicationIdentity.kernelStartDate(processIdentifier: getpid(), expectedExecutable: executable))
        XCTAssertNil(RunningApplicationIdentity.kernelStartDate(processIdentifier: -1, expectedExecutable: currentExecutable))
    }

    @MainActor
    func testAlreadyRunningSupportedGUIAppUsesKernelDateEvenWhenAppKitDateIsMissing() throws {
        let candidates = NSWorkspace.shared.runningApplications.filter {
            guard let path = $0.bundleURL?.standardizedFileURL.resolvingSymlinksInPath().path else { return false }
            return ($0.bundleIdentifier == "com.openai.codex" && path == "/Applications/ChatGPT.app") ||
                ($0.bundleIdentifier == "dev.extensionsanywhere.stylelab" && path == "/Applications/Style Lab.app")
        }
        guard let app = candidates.first else { throw XCTSkip("No supported GUI app is already running; this test never launches one.") }
        let expectedExecutable = try XCTUnwrap(app.executableURL ?? app.bundleURL.flatMap { Bundle(url: $0)?.executableURL })
        let expected = try XCTUnwrap(RunningApplicationIdentity.kernelStartDate(processIdentifier: app.processIdentifier,
                                                                              expectedExecutable: expectedExecutable))
        XCTAssertEqual(RunningApplicationIdentity.startDate(of: app), expected)
        // No assertion depends on NSRunningApplication.launchDate being present.
    }
}
