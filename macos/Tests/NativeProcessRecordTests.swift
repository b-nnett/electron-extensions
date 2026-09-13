import Darwin
import Foundation
import XCTest
@testable import RuntimeCatalog

final class NativeProcessRecordTests: XCTestCase {
    private func snapshot(pid: Int32 = 42, uid: UInt32 = 501, status: UInt32 = 2,
                          seconds: UInt64 = 1_800_000_000, microseconds: UInt64 = 7,
                          parentPID: UInt32 = 1) -> RuntimeProcessIdentity.KernelSnapshot {
        .init(pid: pid, uid: uid, status: status, seconds: seconds, microseconds: microseconds, parentPID: parentPID)
    }

    private func record(_ before: RuntimeProcessIdentity.KernelSnapshot,
                        _ after: RuntimeProcessIdentity.KernelSnapshot, path: String = "/usr/bin/owned-fixture") -> RuntimeProcessIdentity.ProcessRecord {
        RuntimeProcessIdentity.validatedProcessRecord(before: before, after: after, expectedPID: 42, kernelPath: path)
    }

    func testStableIdentityPreservesExactMicrosecondsAndParentPID() throws {
        let result = record(snapshot(), snapshot(status: 3, parentPID: 12))
        XCTAssertEqual(result.status, "ok")
        XCTAssertEqual(result.started, "1800000000.000007")
        XCTAssertEqual(result.pid, 42)
        XCTAssertEqual(result.uid, 501)
        XCTAssertEqual(result.ppid, 12)
        XCTAssertEqual(result.executable, "/usr/bin/owned-fixture")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(result)) as? [String: Any])
        XCTAssertNil(object["errno"])
        XCTAssertNil(object["confirmedBy"])
    }

    func testChangedPIDUserAndStartRemainExplicitErrors() {
        for changed in [snapshot(pid: 43), snapshot(uid: 502), snapshot(seconds: 1_800_000_001), snapshot(microseconds: 8)] {
            for result in [record(snapshot(), changed), record(changed, snapshot())] {
                XCTAssertEqual(result.status, "error")
                XCTAssertEqual(result.code, "PROCESS_CHANGED")
                XCTAssertNil(result.started)
                XCTAssertNil(result.confirmedBy)
            }
        }
    }

    func testZombieUnknownStateAndMalformedFieldsDoNotBecomeAbsence() {
        for changed in [snapshot(status: 0), snapshot(status: 5), snapshot(status: 6),
                        snapshot(seconds: 0), snapshot(microseconds: 1_000_000), snapshot(parentPID: UInt32.max)] {
            let result = record(changed, changed)
            XCTAssertEqual(result.status, "error")
            XCTAssertEqual(result.code, "PROCESS_NOT_RUNNING")
            XCTAssertNil(result.confirmedBy)
        }
    }

    func testInvalidKernelPathsFailClosed() {
        for path in ["relative", "/tmp/invalid\npath", "/tmp/invalid\rpath", "/tmp/invalid\0path", "/" + String(repeating: "a", count: 4096)] {
            let result = record(snapshot(), snapshot(), path: path)
            XCTAssertEqual(result.status, "error")
            XCTAssertEqual(result.code, "INVALID_EXECUTABLE_PATH")
        }
    }

    func testOnlyConfirmedKillZeroAbsenceProducesAbsentRecord() {
        for number in [Int32(0), EPERM, EACCES, ESRCH] {
            let uncertain = RuntimeProcessIdentity.failedProcessRecord(pid: 42, operation: "proc_pidpath", errorNumber: number, absenceConfirmed: false)
            XCTAssertEqual(uncertain.status, "error")
            XCTAssertEqual(uncertain.errno, number)
            XCTAssertNil(uncertain.confirmedBy)
            let absent = RuntimeProcessIdentity.failedProcessRecord(pid: 42, operation: "proc_pidpath", errorNumber: number, absenceConfirmed: true)
            XCTAssertEqual(absent.status, "absent")
            XCTAssertEqual(absent.errno, ESRCH)
            XCTAssertEqual(absent.confirmedBy, "kill-0")
        }
        XCTAssertEqual(RuntimeProcessIdentity.processRecord(processIdentifier: -1).code, "INVALID_PID")
        XCTAssertEqual(RuntimeProcessIdentity.processRecord(processIdentifier: 0).code, "INVALID_PID")
    }

    func testLiveNativeReaderInspectsOnlyCurrentOwnedTestProcess() throws {
        let first = RuntimeProcessIdentity.processRecord(processIdentifier: getpid())
        let second = RuntimeProcessIdentity.processRecord(processIdentifier: getpid())
        XCTAssertEqual(first.status, "ok")
        XCTAssertEqual(first, second)
        XCTAssertEqual(first.uid, getuid())
        XCTAssertEqual(first.ppid, UInt32(getppid()))
        let path = try XCTUnwrap(first.executable)
        let expected = try XCTUnwrap(Bundle.main.executableURL).standardizedFileURL.resolvingSymlinksInPath().path
        XCTAssertEqual(URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path, expected)
    }
}
