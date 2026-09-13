import Darwin
import Foundation

/// Opt-in ownership markers cover only sessions created by this launcher build.
/// Legacy, active, uncertain and structurally unexpected directories are kept.
public struct RuntimeSessionRetention {
    public static let markerName = ".ea-session-owner.json"
    public static let keepNewest = 10
    public static let maximumAge: TimeInterval = 14 * 24 * 60 * 60
    public static let maximumSessions = 512
    private static let maximumNodes = 512
    private static let maximumTreeBytes: Int64 = 128 * 1024 * 1024

    public enum Observation {
        case running(pid: Int32, uid: UInt32, started: String)
        case absent
        case unknown
    }

    public struct Environment {
        public var uid: () -> UInt32
        public var now: () -> Date
        public var observe: (Int32) -> Observation

        public init(uid: @escaping () -> UInt32, now: @escaping () -> Date, observe: @escaping (Int32) -> Observation) {
            self.uid = uid; self.now = now; self.observe = observe
        }

        public static var live: Self {
            Self(uid: { getuid() }, now: { Date() }, observe: { pid in
                let record = RuntimeProcessIdentity.processRecord(processIdentifier: pid)
                if record.status == "absent", record.confirmedBy == "kill-0" { return .absent }
                if record.status == "ok", let uid = record.uid, let started = record.started {
                    return .running(pid: pid, uid: uid, started: started)
                }
                return .unknown
            })
        }
    }

    public struct Result {
        public var removed: [String] = []
        public var preserved = 0
        public var scanLimitReached = false
    }

    private struct Identity: Codable, Equatable {
        var pid: Int32
        var uid: UInt32
        var started: String
    }

    private struct Marker: Codable, Equatable {
        var schemaVersion = 1
        var owner = "dev.extensions-anywhere.session"
        var launcherIdentifier: String
        var sessionID: String
        var directoryDevice: Int32
        var directoryInode: UInt64
        var createdAt: Date
        var launcher: Identity
        var broker: Identity?
        var closedAt: Date?
    }

    private let environment: Environment
    public init(environment: Environment = .live) { self.environment = environment }

    public func markCreated(_ session: URL, launcherIdentifier: String, launcherPID: Int32 = getpid()) throws {
        let directory = try Directory(url: session, uid: environment.uid())
        guard Self.validSessionName(session.lastPathComponent), session.deletingLastPathComponent().lastPathComponent == "Sessions",
              try directory.names(limit: 1).isEmpty,
              let launcher = identity(launcherPID), launcher.uid == environment.uid(),
              launcherIdentifier.hasPrefix("dev.extensionsanywhere.launcher.") else { throw invalid() }
        let marker = Marker(launcherIdentifier: launcherIdentifier, sessionID: session.lastPathComponent,
                            directoryDevice: directory.metadata.st_dev, directoryInode: directory.metadata.st_ino,
                            createdAt: environment.now(), launcher: launcher)
        try directory.writeExclusive(Self.markerName, data: JSONEncoder().encode(marker))
    }

    public func markBroker(_ session: URL, launcherIdentifier: String, brokerPID: Int32) throws {
        guard let broker = identity(brokerPID), broker.uid == environment.uid() else { throw invalid() }
        try update(session, launcherIdentifier: launcherIdentifier) { marker in
            guard marker.broker == nil, marker.closedAt == nil else { throw invalid() }
            marker.broker = broker
        }
    }

    public func markClosed(_ session: URL, launcherIdentifier: String) throws {
        try update(session, launcherIdentifier: launcherIdentifier) { marker in
            // The caller uses the owned Process termination callback. Missing
            // broker identity still prevents later deletion of this session.
            marker.closedAt = environment.now()
        }
    }

    public func prune(in sessions: URL, launcherIdentifier: String, excluding current: URL) throws -> Result {
        guard sessions.lastPathComponent == "Sessions", current.deletingLastPathComponent().path == sessions.path,
              Self.validSessionName(current.lastPathComponent) else { throw invalid() }
        let root = try Directory(url: sessions, uid: environment.uid())
        var result = Result()
        let names: [String]
        do { names = try root.names(limit: Self.maximumSessions) }
        catch RetentionError.limit { result.scanLimitReached = true; return result }
        struct Candidate { var name: String; var marker: Marker; var data: Data; var directory: Directory }
        var candidates: [Candidate] = []
        for name in names {
            guard name != current.lastPathComponent, Self.validSessionName(name) else { result.preserved += 1; continue }
            do {
                let directory = try Directory(parent: root, name: name)
                let data = try directory.read(Self.markerName, limit: 8192)
                let marker = try checkedMarker(data, directory: directory, name: name, launcherIdentifier: launcherIdentifier)
                guard inactive(marker) else { result.preserved += 1; continue }
                candidates.append(Candidate(name: name, marker: marker, data: data, directory: directory))
            } catch { result.preserved += 1 }
        }
        candidates.sort { $0.marker.createdAt > $1.marker.createdAt }
        for (index, candidate) in candidates.enumerated() {
            guard index >= Self.keepNewest || environment.now().timeIntervalSince(candidate.marker.createdAt) > Self.maximumAge else {
                result.preserved += 1; continue
            }
            do {
                var nodes = 0
                var bytes: Int64 = 0
                let tree = try snapshot(candidate.directory, relative: "", nodes: &nodes, bytes: &bytes)
                // Recheck process and filesystem identities after the bounded
                // scan and immediately before any deletion. An error keeps it.
                guard inactive(candidate.marker),
                      try candidate.directory.read(Self.markerName, limit: 8192) == candidate.data else { throw invalid() }
                try root.requireLocation()
                try candidate.directory.requireLocation()
                try validate(tree)
                try remove(tree, root: root)
                try candidate.directory.requireLocation()
                guard unlinkat(root.fd, candidate.name, AT_REMOVEDIR) == 0 else { throw posix() }
                result.removed.append(candidate.name)
            } catch { result.preserved += 1 }
        }
        return result
    }

    private func update(_ session: URL, launcherIdentifier: String, change: (inout Marker) throws -> Void) throws {
        let directory = try Directory(url: session, uid: environment.uid())
        let original = try directory.read(Self.markerName, limit: 8192)
        var marker = try checkedMarker(original, directory: directory, name: session.lastPathComponent, launcherIdentifier: launcherIdentifier)
        guard identity(getpid()) == marker.launcher else { throw invalid() }
        try change(&marker)
        let temporary = ".ea-session-owner-\(UUID().uuidString).tmp"
        try directory.writeExclusive(temporary, data: JSONEncoder().encode(marker))
        defer { _ = unlinkat(directory.fd, temporary, 0) }
        try directory.requireLocation()
        guard try directory.read(Self.markerName, limit: 8192) == original else { throw invalid() }
        guard renameat(directory.fd, temporary, directory.fd, Self.markerName) == 0 else { throw posix() }
    }

    private func checkedMarker(_ data: Data, directory: Directory, name: String, launcherIdentifier: String) throws -> Marker {
        let marker = try JSONDecoder().decode(Marker.self, from: data)
        guard marker.schemaVersion == 1, marker.owner == "dev.extensions-anywhere.session",
              marker.launcherIdentifier == launcherIdentifier, Self.validSessionName(name), marker.sessionID == name,
              marker.directoryDevice == directory.metadata.st_dev, marker.directoryInode == directory.metadata.st_ino,
              valid(marker.launcher), marker.broker.map(valid) ?? true,
              marker.createdAt.timeIntervalSince1970 > 0, marker.createdAt <= environment.now(),
              marker.closedAt.map({ $0 >= marker.createdAt && $0 <= environment.now() }) ?? true else { throw invalid() }
        return marker
    }

    private func identity(_ pid: Int32) -> Identity? {
        guard pid > 0, case let .running(observedPID, uid, started) = environment.observe(pid), observedPID == pid else { return nil }
        let value = Identity(pid: pid, uid: uid, started: started)
        return valid(value) ? value : nil
    }

    private func valid(_ value: Identity) -> Bool {
        value.pid > 0 && value.uid == environment.uid() && value.started.range(of: #"^[1-9][0-9]{0,11}\.[0-9]{6}$"#, options: .regularExpression) != nil
    }

    private func ended(_ value: Identity) -> Bool {
        switch environment.observe(value.pid) {
        case .absent: return true
        case let .running(pid, _, started):
            // A positively identified different start means the original ended;
            // no signal is ever sent to this replacement process.
            return pid == value.pid && started != value.started && started.range(of: #"^[1-9][0-9]{0,11}\.[0-9]{6}$"#, options: .regularExpression) != nil
        case .unknown: return false
        }
    }

    private func inactive(_ marker: Marker) -> Bool {
        // Never infer inactivity from closedAt alone: both exact owners must end.
        guard let broker = marker.broker else { return false }
        return ended(marker.launcher) && ended(broker)
    }

    private struct Tree {
        var directory: Directory
        var files: [(String, stat)]
        var children: [Tree]
    }

    private func snapshot(_ directory: Directory, relative: String, nodes: inout Int, bytes: inout Int64) throws -> Tree {
        var tree = Tree(directory: directory, files: [], children: [])
        for name in try directory.names(limit: Self.maximumNodes) {
            nodes += 1
            guard nodes <= Self.maximumNodes else { throw RetentionError.limit }
            let info = try directory.childMetadata(name)
            let next = relative.isEmpty ? name : relative + "/" + name
            if info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) {
                guard next == "evidence" || (relative == "evidence" && name.range(of: #"^[0-9]{4}-[0-9TZ.:-]+-[1-9][0-9]*$"#, options: .regularExpression) != nil) else { throw invalid() }
                tree.children.append(try snapshot(Directory(parent: directory, name: name), relative: next, nodes: &nodes, bytes: &bytes))
            } else {
                guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_nlink == 1,
                      info.st_uid == environment.uid(), info.st_size >= 0, info.st_size <= 16 * 1024 * 1024,
                      Self.allowedFile(name, relative: relative) else { throw invalid() }
                bytes += info.st_size
                guard bytes <= Self.maximumTreeBytes else { throw RetentionError.limit }
                tree.files.append((name, info))
            }
        }
        return tree
    }

    private static func allowedFile(_ name: String, relative: String) -> Bool {
        if relative.isEmpty {
            return [markerName, "launcher.log", "status.json", "report.json"].contains(name) ||
                name.range(of: #"^revision-[1-9][0-9]*-(before|after|styled|restored)\.png$"#, options: .regularExpression) != nil
        }
        return relative.hasPrefix("evidence/") && ["before.png", "styled.png", "restored.png"].contains(name)
    }

    private func validate(_ tree: Tree) throws {
        try tree.directory.requireLocation()
        let names = try tree.directory.names(limit: Self.maximumNodes).sorted()
        guard names == (tree.files.map(\.0) + tree.children.map { $0.directory.name! }).sorted() else { throw invalid() }
        for (name, info) in tree.files { guard sameFile(info, try tree.directory.childMetadata(name)) else { throw invalid() } }
        for child in tree.children { try validate(child) }
    }

    private func remove(_ tree: Tree, root: Directory) throws {
        for child in tree.children {
            try remove(child, root: root)
            try root.requireLocation(); try child.directory.requireLocation()
            guard unlinkat(tree.directory.fd, child.directory.name!, AT_REMOVEDIR) == 0 else { throw posix() }
        }
        // Keep the marker until every other owned file was removed successfully.
        for (name, info) in tree.files.sorted(by: { ($0.0 == Self.markerName ? 1 : 0) < ($1.0 == Self.markerName ? 1 : 0) }) {
            try root.requireLocation(); try tree.directory.requireLocation()
            guard sameFile(info, try tree.directory.childMetadata(name)) else { throw invalid() }
            guard unlinkat(tree.directory.fd, name, 0) == 0 else { throw posix() }
        }
    }

    private static func validSessionName(_ name: String) -> Bool { UUID(uuidString: name)?.uuidString == name }
    private enum RetentionError: Error { case invalid, limit }
    private func invalid() -> Error { RetentionError.invalid }
    private func posix() -> Error { NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }

    private final class Directory {
        private(set) var fd: Int32
        let metadata: stat
        let url: URL?
        let parent: Directory?
        let name: String?
        let uid: UInt32

        init(url: URL, uid: UInt32) throws {
            guard url.isFileURL, url.path.utf8.count < 4096,
                  url.path == url.standardizedFileURL.resolvingSymlinksInPath().path,
                  !url.pathComponents.contains(where: { $0.lowercased().hasSuffix(".app") }) else { throw RetentionError.invalid }
            self.url = url; parent = nil; name = nil; self.uid = uid
            fd = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard fd >= 0 else { throw RetentionError.invalid }
            var info = stat()
            guard fstat(fd, &info) == 0 else { Darwin.close(fd); throw RetentionError.invalid }
            metadata = info
            do { try requireLocation() } catch { Darwin.close(fd); fd = -1; throw error }
        }

        init(parent: Directory, name: String) throws {
            guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\0") else { throw RetentionError.invalid }
            self.parent = parent; self.name = name; url = nil; uid = parent.uid
            fd = openat(parent.fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard fd >= 0 else { throw RetentionError.invalid }
            var info = stat()
            guard fstat(fd, &info) == 0 else { Darwin.close(fd); throw RetentionError.invalid }
            metadata = info
            do { try requireLocation() } catch { Darwin.close(fd); fd = -1; throw error }
        }

        deinit { if fd >= 0 { Darwin.close(fd) } }

        func requireLocation() throws {
            var current = stat()
            if let parent, let name { try parent.requireLocation(); current = try parent.childMetadata(name) }
            else if let url {
                guard url.path == url.standardizedFileURL.resolvingSymlinksInPath().path, lstat(url.path, &current) == 0 else { throw RetentionError.invalid }
            } else { throw RetentionError.invalid }
            guard current.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), current.st_uid == uid,
                  current.st_mode & 0o022 == 0, current.st_dev == metadata.st_dev, current.st_ino == metadata.st_ino else { throw RetentionError.invalid }
        }

        func childMetadata(_ name: String) throws -> stat {
            var info = stat()
            guard fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw RetentionError.invalid }
            return info
        }

        func names(limit: Int) throws -> [String] {
            let copy = dup(fd)
            guard copy >= 0, let stream = fdopendir(copy) else { if copy >= 0 { Darwin.close(copy) }; throw RetentionError.invalid }
            defer { closedir(stream) }
            rewinddir(stream)
            var names: [String] = []
            while true {
                errno = 0
                guard let entry = readdir(stream) else {
                    guard errno == 0 else { throw RetentionError.invalid }
                    break
                }
                let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                    pointer.withMemoryRebound(to: CChar.self, capacity: 1024) { String(validatingCString: $0) }
                }
                guard let name else { throw RetentionError.invalid }
                if name == "." || name == ".." { continue }
                guard names.count < limit else { throw RetentionError.limit }
                names.append(name)
            }
            return names
        }

        func read(_ name: String, limit: Int) throws -> Data {
            let descriptor = openat(fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
            guard descriptor >= 0 else { throw RetentionError.invalid }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            defer { try? handle.close() }
            var info = stat()
            guard fstat(descriptor, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  info.st_nlink == 1, info.st_uid == uid, info.st_size >= 0, info.st_size <= limit else { throw RetentionError.invalid }
            let data = try handle.read(upToCount: limit + 1) ?? Data()
            guard data.count == info.st_size, sameFile(info, try childMetadata(name)) else { throw RetentionError.invalid }
            return data
        }

        func writeExclusive(_ name: String, data: Data) throws {
            guard data.count <= 8192 else { throw RetentionError.limit }
            try requireLocation()
            let descriptor = openat(fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard descriptor >= 0 else { throw RetentionError.invalid }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            defer { try? handle.close() }
            try handle.write(contentsOf: data)
        }
    }
}

private func sameFile(_ lhs: stat, _ rhs: stat) -> Bool {
    lhs.st_dev == rhs.st_dev && lhs.st_ino == rhs.st_ino && lhs.st_mode == rhs.st_mode && lhs.st_uid == rhs.st_uid &&
        lhs.st_nlink == rhs.st_nlink && lhs.st_size == rhs.st_size &&
        lhs.st_mtimespec.tv_sec == rhs.st_mtimespec.tv_sec && lhs.st_mtimespec.tv_nsec == rhs.st_mtimespec.tv_nsec &&
        lhs.st_ctimespec.tv_sec == rhs.st_ctimespec.tv_sec && lhs.st_ctimespec.tv_nsec == rhs.st_ctimespec.tv_nsec
}
