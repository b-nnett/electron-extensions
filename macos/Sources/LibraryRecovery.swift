import AppKit
import Darwin
import Foundation
import RuntimeCatalog

enum LibraryRecoveryError: LocalizedError {
    case changed, unsafeFile, activeSessions, sameFile
    case uncertainSessions(URL)

    var errorDescription: String? {
        switch self {
        case .changed: "The library changed while you were reviewing the restore. Choose the backup again."
        case .unsafeFile: "Use a regular library file in a folder you own, outside app bundles. Existing files were preserved."
        case .activeSessions: "Quit your managed apps normally and wait for their launchers to finish before restoring the library."
        case .uncertainSessions(let url): "The session evidence at \(url.path) could not be confirmed inactive. No restore was performed. Preserve this folder and have support verify its recorded process before moving any evidence; do not terminate a process based on its saved PID alone."
        case .sameFile: "Choose a separate export file. The live library and its automatic backup are reserved."
        }
    }
}

/// All saved library/backup bytes are private from creation, not only after a
/// chmod. Rename replaces one directory entry and never follows a target link.
enum LibraryRecoveryFiles {
    static func write(_ data: Data, to url: URL, expected: Data? = nil, checkExpected: Bool = false) throws {
        guard data.count <= ExtensionLibrary.maximumBytes, url.isFileURL,
              !url.pathComponents.contains(where: { $0.lowercased().hasSuffix(".app") }) else { throw LibraryRecoveryError.unsafeFile }
        let manager = FileManager.default
        let parent = url.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
        guard !parent.pathComponents.contains(where: { $0.lowercased().hasSuffix(".app") }) else { throw LibraryRecoveryError.unsafeFile }
        try manager.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let fd = Darwin.open(parent.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { throw posix() }
        defer { Darwin.close(fd) }
        var directory = stat()
        guard fstat(fd, &directory) == 0, directory.st_uid == getuid() else { throw LibraryRecoveryError.unsafeFile }
        let name = url.lastPathComponent
        guard !name.isEmpty, name != ".", name != ".." else { throw LibraryRecoveryError.unsafeFile }
        try checkDestination(fd, name)
        let temporary = ".ea-library-\(UUID().uuidString).tmp"
        let output = openat(fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard output >= 0 else { throw posix() }
        let handle = FileHandle(fileDescriptor: output, closeOnDealloc: true)
        defer { try? handle.close(); unlinkat(fd, temporary, 0) }
        try handle.write(contentsOf: data)
        try handle.synchronize()
        var currentDirectory = stat()
        guard lstat(parent.path, &currentDirectory) == 0,
              currentDirectory.st_dev == directory.st_dev, currentDirectory.st_ino == directory.st_ino else { throw LibraryRecoveryError.unsafeFile }
        if checkExpected {
            guard try ExtensionLibrary.readData(from: parent.appendingPathComponent(name)) == expected else { throw LibraryRecoveryError.changed }
        }
        try checkDestination(fd, name)
        guard renameat(fd, temporary, fd, name) == 0 else { throw posix() }
        _ = fsync(fd)
    }

    private static func checkDestination(_ fd: Int32, _ name: String) throws {
        var value = stat()
        if fstatat(fd, name, &value, AT_SYMLINK_NOFOLLOW) != 0 {
            if errno == ENOENT { return }
            throw posix()
        }
        guard value.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), value.st_nlink == 1,
              value.st_uid == getuid() else { throw LibraryRecoveryError.unsafeFile }
    }

    private static func posix() -> NSError { NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
}

@MainActor
struct LibraryRecovery {
    struct RestorePlan {
        let sourceName: String
        let library: ExtensionLibrary
        let originalData: Data?
        let restoredData: Data
        var recordCount: Int { library.records.count }
    }

    struct RestoreResult {
        let preservedOriginal: URL?
        let recordCount: Int
    }

    let storageURL: URL
    private let requireNoActiveSessions: @MainActor () throws -> Void

    init(storageURL: URL = ExtensionLibrary.defaultURL,
         requireNoActiveSessions: (@MainActor () throws -> Void)? = nil) {
        self.storageURL = storageURL
        self.requireNoActiveSessions = requireNoActiveSessions ?? {
            try LibraryRecoverySessionGuard.check(in: storageURL.deletingLastPathComponent().appendingPathComponent("Launchers"))
        }
    }

    var backupURL: URL { ExtensionLibrary.backupURL(for: storageURL) }
    var recoveryDirectory: URL { storageURL.deletingLastPathComponent().appendingPathComponent("Recovery Backups", isDirectory: true) }

    func export(to destination: URL) throws {
        let target = destination.standardizedFileURL.resolvingSymlinksInPath()
        guard target != storageURL.standardizedFileURL.resolvingSymlinksInPath(),
              target != backupURL.standardizedFileURL.resolvingSymlinksInPath() else { throw LibraryRecoveryError.sameFile }
        guard let bytes = try ExtensionLibrary.readData(from: storageURL) else { throw ExtensionLibraryError.missingRecord }
        _ = try ExtensionLibrary.decode(bytes)
        try LibraryRecoveryFiles.write(bytes, to: destination)
    }

    func prepareRestore(from source: URL) throws -> RestorePlan {
        try requireNoActiveSessions()
        guard let bytes = try ExtensionLibrary.readData(from: source) else { throw ExtensionLibraryError.missingRecord }
        let library = try ExtensionLibrary.decode(bytes).disabledForRestore()
        return RestorePlan(sourceName: source.lastPathComponent, library: library,
                           originalData: try ExtensionLibrary.readData(from: storageURL), restoredData: try library.encodedData())
    }

    /// Only call after explicit confirmation of this exact immutable plan.
    /// No launcher, extension-manager mutation, or Dock API is called here.
    func restore(_ plan: RestorePlan) throws -> RestoreResult {
        try requireNoActiveSessions()
        guard try ExtensionLibrary.readData(from: storageURL) == plan.originalData else { throw LibraryRecoveryError.changed }
        let decoded = try ExtensionLibrary.decode(plan.restoredData)
        guard decoded.records.allSatisfy({ !$0.isEnabled }) else { throw ExtensionLibraryError.invalidLibrary }
        var preserved: URL?
        if let original = plan.originalData {
            let archive = recoveryDirectory.appendingPathComponent("library-before-restore-\(UUID().uuidString).json")
            try LibraryRecoveryFiles.write(original, to: archive, expected: nil, checkExpected: true)
            preserved = archive
            // Explicit restore leaves the selected last-good snapshot intact.
            // Its current original is already preserved in the unique archive.
        }
        try requireNoActiveSessions()
        try LibraryRecoveryFiles.write(plan.restoredData, to: storageURL, expected: plan.originalData, checkExpected: true)
        return RestoreResult(preservedOriginal: preserved, recordCount: plan.recordCount)
    }
}

@MainActor
enum LibraryRecoverySessionGuard {
    /// Conservative recovery-only inspection. It never terminates a process.
    static func check(in launchers: URL) throws {
        if NSWorkspace.shared.runningApplications.contains(where: {
            $0.bundleIdentifier?.hasPrefix("dev.extensionsanywhere.launcher.") == true
        }) { throw LibraryRecoveryError.activeSessions }
        try checkRecordedSessions(in: launchers) { pid in
            let result = RuntimeProcessIdentity.processRecord(processIdentifier: pid)
            if result.status == "absent", result.confirmedBy == "kill-0" { return .absent }
            return result.status == "ok" ? .running : .unknown
        }
    }

    enum ProcessObservation { case absent, running, unknown }

    static func checkRecordedSessions(in launchers: URL, observe: (Int32) -> ProcessObservation) throws {
        let manager = FileManager.default
        guard manager.fileExists(atPath: launchers.path) else { return }
        var inspected = 0
        for launcher in try children(of: launchers) {
            if launcher.lastPathComponent == ".DS_Store" { continue }
            guard launcher.lastPathComponent.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
                throw LibraryRecoveryError.uncertainSessions(launcher)
            }
            try requireDirectory(launcher)
            let sessions = launcher.appendingPathComponent("Sessions")
            guard manager.fileExists(atPath: sessions.path) else { continue }
            for session in try children(of: sessions) {
                if session.lastPathComponent == ".DS_Store" { continue }
                inspected += 1
                guard inspected <= 512, UUID(uuidString: session.lastPathComponent) != nil else {
                    throw LibraryRecoveryError.uncertainSessions(session)
                }
                try requireDirectory(session)
                let recorded: RecordedBroker
                do {
                    guard let data = try ExtensionLibrarySessionFile.read(session.appendingPathComponent("status.json")) else {
                        throw LibraryRecoveryError.uncertainSessions(session)
                    }
                    recorded = try JSONDecoder().decode(RecordedBroker.self, from: data)
                    guard recorded.brokerPid > 0 else { throw LibraryRecoveryError.uncertainSessions(session) }
                } catch { throw LibraryRecoveryError.uncertainSessions(session) }
                switch observe(recorded.brokerPid) {
                case .absent: break
                // A legacy saved PID may have been reused. Without its exact
                // broker start identity, refuse rather than asking to quit it.
                case .running, .unknown: throw LibraryRecoveryError.uncertainSessions(session)
                }
            }
        }
    }

    private static func children(of url: URL) throws -> [URL] {
        try requireDirectory(url)
        var failed = false
        guard let iterator = FileManager.default.enumerator(at: url, includingPropertiesForKeys: nil,
            options: [.skipsSubdirectoryDescendants], errorHandler: { _, _ in failed = true; return false }) else {
            throw LibraryRecoveryError.uncertainSessions(url)
        }
        var children: [URL] = []
        for case let child as URL in iterator {
            iterator.skipDescendants()
            guard children.count < 512 else { throw LibraryRecoveryError.uncertainSessions(url) }
            children.append(child)
        }
        guard !failed else { throw LibraryRecoveryError.uncertainSessions(url) }
        return children
    }

    private static func requireDirectory(_ url: URL) throws {
        var value = stat()
        let normalized = url.standardizedFileURL
        guard url.isFileURL, lstat(url.path, &value) == 0,
              normalized.path == normalized.resolvingSymlinksInPath().path,
              value.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else {
            throw LibraryRecoveryError.uncertainSessions(url)
        }
    }

    private struct RecordedBroker: Decodable { let brokerPid: Int32 }
}

private enum ExtensionLibrarySessionFile {
    static func read(_ url: URL) throws -> Data? {
        try RuntimeBoundedFile.read(url, maximumBytes: 64 * 1024)
    }
}
