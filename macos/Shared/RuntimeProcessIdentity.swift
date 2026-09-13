import AppKit
import Darwin
import Foundation

public enum RuntimeProcessIdentity {
    public struct KernelSnapshot: Sendable {
        public let pid: Int32
        public let uid: UInt32
        public let status: UInt32
        public let seconds: UInt64
        public let microseconds: UInt64
        public let parentPID: UInt32

        public init(pid: Int32, uid: UInt32, status: UInt32, seconds: UInt64, microseconds: UInt64, parentPID: UInt32 = 0) {
            self.pid = pid
            self.uid = uid
            self.status = status
            self.seconds = seconds
            self.microseconds = microseconds
            self.parentPID = parentPID
        }
    }

    /// The broker's bounded native CLI uses the same SDK/libproc reader as the
    /// AppKit lifecycle checks. Missing processes and unreadable identities are
    /// separate results; only kill(pid, 0) returning ESRCH establishes absence.
    public struct ProcessRecord: Codable, Equatable, Sendable {
        public let pid: Int32
        public let status: String
        public var executable: String?
        public var started: String?
        public var uid: UInt32?
        public var ppid: UInt32?
        public var errno: Int32?
        public var code: String?
        public var message: String?
        public var confirmedBy: String?
    }

    public static func processRecord(processIdentifier pid: Int32) -> ProcessRecord {
        guard pid > 0 else {
            return ProcessRecord(pid: pid, status: "error", code: "INVALID_PID", message: "PID must be positive.")
        }
        do {
            let before = try readSnapshot(pid)
            var buffer = [UInt8](repeating: 0, count: 4096)
            errno = 0
            let count = buffer.withUnsafeMutableBytes {
                proc_pidpath(pid, $0.baseAddress, UInt32($0.count))
            }
            guard count > 0 else { throw LookupFailure(operation: "proc_pidpath", number: errno) }
            guard count < buffer.count, let end = buffer.firstIndex(of: 0), end > 0,
                  let kernelPath = String(bytes: buffer[..<end], encoding: .utf8) else {
                return ProcessRecord(pid: pid, status: "error", code: "INVALID_EXECUTABLE_PATH",
                                     message: "Kernel executable path is not bounded UTF-8.")
            }
            let after = try readSnapshot(pid)
            return validatedProcessRecord(before: before, after: after, expectedPID: pid, kernelPath: kernelPath)
        } catch let failure as LookupFailure {
            let absent = Darwin.kill(pid, 0) == -1 && errno == ESRCH
            return failedProcessRecord(pid: pid, operation: failure.operation, errorNumber: failure.number,
                                       absenceConfirmed: absent)
        } catch {
            return ProcessRecord(pid: pid, status: "error", code: "PROCESS_LOOKUP_FAILED", message: "Kernel process inspection failed.")
        }
    }

    static func validatedProcessRecord(before: KernelSnapshot, after: KernelSnapshot, expectedPID: Int32,
                                       kernelPath: String) -> ProcessRecord {
        guard expectedPID > 0, before.pid == expectedPID, after.pid == expectedPID,
              before.uid == after.uid, before.seconds == after.seconds,
              before.microseconds == after.microseconds else {
            return ProcessRecord(pid: expectedPID, status: "error", code: "PROCESS_CHANGED",
                                 message: "PID identity changed during inspection.")
        }
        guard (1...4).contains(before.status), (1...4).contains(after.status),
              after.seconds > 0, after.microseconds < 1_000_000,
              after.parentPID <= UInt32(Int32.max) else {
            return ProcessRecord(pid: expectedPID, status: "error", code: "PROCESS_NOT_RUNNING",
                                 message: "A complete live process identity could not be established.")
        }
        guard kernelPath.hasPrefix("/"), !kernelPath.contains("\0"),
              !kernelPath.contains("\r"), !kernelPath.contains("\n"), kernelPath.utf8.count < 4096 else {
            return ProcessRecord(pid: expectedPID, status: "error", code: "INVALID_EXECUTABLE_PATH",
                                 message: "Kernel executable path is invalid.")
        }
        let microseconds = String(after.microseconds)
        let started = String(after.seconds) + "." + String(repeating: "0", count: 6 - microseconds.count) + microseconds
        return ProcessRecord(pid: expectedPID, status: "ok", executable: kernelPath,
                             started: started, uid: after.uid, ppid: after.parentPID)
    }

    static func failedProcessRecord(pid: Int32, operation: String, errorNumber: Int32,
                                    absenceConfirmed: Bool) -> ProcessRecord {
        if pid > 0 && absenceConfirmed {
            return ProcessRecord(pid: pid, status: "absent", errno: ESRCH, confirmedBy: "kill-0")
        }
        let code: String
        switch errorNumber {
        case EPERM: code = "EPERM"
        case EACCES: code = "EACCES"
        case ESRCH: code = "ESRCH"
        default: code = "PROCESS_LOOKUP_FAILED"
        }
        return ProcessRecord(pid: pid, status: "error", errno: errorNumber, code: code,
                             message: operation + " failed; process absence not confirmed.")
    }

    /// AppKit can retain an entry after exit. Absence and a stable zombie are
    /// positive exit evidence; an inaccessible identity is still uncertainty.
    public static func hasDefinitelyExited(processIdentifier pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        if Darwin.kill(pid, 0) == -1 && errno == ESRCH { return true }
        guard let before = read(pid), let after = read(pid) else {
            return Darwin.kill(pid, 0) == -1 && errno == ESRCH
        }
        return confirmsExited(before: before, after: after, expectedPID: pid)
    }

    public static func confirmsExited(before: KernelSnapshot, after: KernelSnapshot, expectedPID: Int32) -> Bool {
        expectedPID > 0 && before.pid == expectedPID && after.pid == expectedPID &&
        before.status == 5 && after.status == 5 && before.uid == after.uid &&
        before.seconds == after.seconds && before.microseconds == after.microseconds
    }

    /// Read-only kernel identity. AppKit launchDate can be nil for spawned apps.
    /// An inaccessible path or changed PID is uncertainty, never a date fallback.
    @MainActor
    public static func startDate(of app: NSRunningApplication) -> Date? {
        let pid = app.processIdentifier
        guard pid > 0, !app.isTerminated else { return nil }
        let bundle = app.bundleURL?.standardizedFileURL.resolvingSymlinksInPath()
        let executable = app.executableURL ?? bundle.flatMap { Bundle(url: $0)?.executableURL }
        guard let executable, executable.isFileURL else { return nil }
        let expected = executable.standardizedFileURL.resolvingSymlinksInPath()
        if let bundle {
            guard bundle.isFileURL, expected.path.hasPrefix(bundle.path + "/") else { return nil }
            if let identifier = app.bundleIdentifier,
               Bundle(url: bundle)?.bundleIdentifier != identifier { return nil }
        }
        let date = kernelStartDate(processIdentifier: pid, expectedExecutable: expected)
        return app.isTerminated ? nil : date
    }

    public static func kernelStartDate(processIdentifier pid: Int32, expectedExecutable: URL) -> Date? {
        guard pid > 0, expectedExecutable.isFileURL else { return nil }
        let expected = expectedExecutable.standardizedFileURL.resolvingSymlinksInPath()
        guard let before = read(pid) else { return nil }
        // SDK PROC_PIDPATHINFO_MAXSIZE is (4 * MAXPATHLEN), or 4096 bytes.
        var buffer = [UInt8](repeating: 0, count: 4096)
        let count = buffer.withUnsafeMutableBytes {
            proc_pidpath(pid, $0.baseAddress, UInt32($0.count))
        }
        guard count > 0, count < buffer.count,
              let end = buffer.firstIndex(of: 0), end > 0,
              let kernelPath = String(bytes: buffer[..<end], encoding: .utf8),
              kernelPath.hasPrefix("/"),
              let after = read(pid) else { return nil }
        let kernelExecutable = URL(fileURLWithPath: kernelPath).standardizedFileURL.resolvingSymlinksInPath()
        return validatedStartDate(before: before, after: after, expectedPID: pid,
                                  expectedUID: getuid(), kernelExecutable: kernelExecutable, expectedExecutable: expected)
    }

    public static func validatedStartDate(
        before: KernelSnapshot, after: KernelSnapshot, expectedPID: Int32, expectedUID: UInt32,
        kernelExecutable: URL, expectedExecutable: URL
    ) -> Date? {
        guard expectedPID > 0, before.pid == expectedPID, after.pid == expectedPID,
              before.uid == expectedUID, after.uid == expectedUID,
              // sys/proc.h: SIDL=1, SRUN=2, SSLEEP=3, SSTOP=4, SZOMB=5.
              (1...4).contains(before.status), (1...4).contains(after.status),
              before.seconds == after.seconds, before.microseconds == after.microseconds,
              after.seconds > 0, after.microseconds < 1_000_000,
              kernelExecutable.isFileURL, expectedExecutable.isFileURL,
              kernelExecutable.path == expectedExecutable.path else { return nil }
        let epoch = Double(after.seconds) + Double(after.microseconds) / 1_000_000
        guard epoch.isFinite else { return nil }
        return Date(timeIntervalSince1970: epoch)
    }

    private struct LookupFailure: Error {
        let operation: String
        let number: Int32
    }

    private static func read(_ pid: Int32) -> KernelSnapshot? { try? readSnapshot(pid) }

    private static func readSnapshot(_ pid: Int32) throws -> KernelSnapshot {
        // Use the imported SDK structure, checking complete reads before fields.
        var info = proc_bsdinfo()
        let size = MemoryLayout<proc_bsdinfo>.size
        guard size == 136 else { throw LookupFailure(operation: "libproc ABI validation", number: 0) }
        errno = 0
        let count = withUnsafeMutablePointer(to: &info) {
            proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, $0, Int32(size))
        }
        guard count == size, info.pbi_pid <= UInt32(Int32.max) else {
            throw LookupFailure(operation: "proc_pidinfo", number: errno)
        }
        return KernelSnapshot(pid: Int32(info.pbi_pid), uid: info.pbi_uid, status: info.pbi_status,
                              seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec,
                              parentPID: info.pbi_ppid)
    }
}
