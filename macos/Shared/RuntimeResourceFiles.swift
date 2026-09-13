import Foundation
import CryptoKit
import Darwin

/// Validates only our packaged runtime resources. No checkout fallback or app
/// launch occurs here; callers supply their own bundle's Resources directory.
public enum RuntimeResourceFiles {
    public static let maximumFiles = 512
    // The official standalone Node executable is larger than the old JS-only bound.
    public static let maximumBytes: UInt64 = 256 * 1024 * 1024
    private static let maximumNodes = 4096
    private static let maximumDepth = 64
    private static let brokerNames: Set<String> = [
        "dock-fixture-session.mjs", "dock-chatgpt-session.mjs", "dock-catalog-session.mjs", "dock-claude-session.mjs"
    ]

    public static func brokerURL(in resources: URL, filename: String) throws -> URL {
        guard brokerNames.contains(filename) else { throw invalid("Unknown packaged broker filename.") }
        let base = try checkedMetadata(resources)
        guard kind(base) == mode_t(S_IFDIR) else { throw invalid("Resources must be a directory.") }
        let file = resources.appendingPathComponent("Runtime/scripts", isDirectory: true).appendingPathComponent(filename)
        let metadata = try checkedMetadata(file)
        guard kind(metadata) == mode_t(S_IFREG), metadata.st_size >= 0,
              UInt64(metadata.st_size) <= maximumBytes,
              file.path.hasPrefix(resources.path + "/Runtime/scripts/") else {
            throw invalid("Packaged broker must be a contained regular file.")
        }
        return file
    }

    public static func nativeExecutable(in resources: URL, filename: String) throws -> URL {
        guard ["node", "ProcessIdentity", "CatalogAppLaunch"].contains(filename) else {
            throw invalid("Unknown packaged native executable.")
        }
        let file = resources.appendingPathComponent("Runtime/native", isDirectory: true).appendingPathComponent(filename)
        let metadata = try checkedMetadata(file)
        guard kind(metadata) == mode_t(S_IFREG), metadata.st_size > 0,
              UInt64(metadata.st_size) <= maximumBytes, metadata.st_mode & 0o111 != 0 else {
            throw invalid("Packaged native runtime must be an executable regular file.")
        }
        return file
    }

    /// SHA-256 over a versioned, length-delimited stream of sorted relative
    /// UTF-8 names, node types, POSIX mode bits, sizes and file contents.
    /// Timestamps, owner, absolute location and enumeration order are excluded.
    public static func digest(in runtimeRoot: URL) throws -> String {
        guard kind(try checkedMetadata(runtimeRoot)) == mode_t(S_IFDIR) else {
            throw invalid("Runtime root must be a canonical directory.")
        }
        var hasher = SHA256()
        hasher.update(data: Data("ExtensionsAnywhere.RuntimeTree.v1\0".utf8))
        var fileCount = 0, nodeCount = 0
        var totalBytes: UInt64 = 0

        func number(_ value: UInt64) {
            var bigEndian = value.bigEndian
            withUnsafeBytes(of: &bigEndian) { hasher.update(data: Data($0)) }
        }
        func visit(_ url: URL, relative: String, depth: Int) throws {
            nodeCount += 1
            guard depth <= maximumDepth, nodeCount <= maximumNodes,
                  relative.utf8.count <= 4096 else { throw invalid("Runtime tree exceeds its structural bounds.") }
            let initial = try checkedMetadata(url)
            let type = kind(initial)
            guard type == mode_t(S_IFREG) || type == mode_t(S_IFDIR) else {
                throw invalid("Runtime contains a symlink or nonregular filesystem node.")
            }
            let flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (type == mode_t(S_IFDIR) ? O_DIRECTORY : 0)
            let descriptor = Darwin.open(url.path, flags)
            guard descriptor >= 0 else { throw posixError() }
            defer { Darwin.close(descriptor) }
            var opened = stat()
            guard fstat(descriptor, &opened) == 0 else { throw posixError() }
            guard sameNode(initial, opened) else { throw invalid("Runtime node changed while opening.") }
            let name = Data(relative.utf8)
            number(type == mode_t(S_IFDIR) ? 1 : 2)
            number(UInt64(name.count)); hasher.update(data: name)
            number(UInt64(initial.st_mode & 0o7777))
            if type == mode_t(S_IFDIR) {
                let names = try childNames(url)
                number(UInt64(names.count))
                for name in names {
                    try visit(url.appendingPathComponent(name), relative: relative.isEmpty ? name : relative + "/" + name, depth: depth + 1)
                }
                guard try childNames(url) == names else { throw invalid("Runtime directory changed while hashing.") }
            } else {
                fileCount += 1
                guard fileCount <= maximumFiles, initial.st_size >= 0,
                      UInt64(initial.st_size) <= maximumBytes - totalBytes else {
                    throw invalid("Runtime exceeds 512 files or 256 MiB of content.")
                }
                number(UInt64(initial.st_size))
                var consumed: UInt64 = 0
                var buffer = [UInt8](repeating: 0, count: 64 * 1024)
                while true {
                    let count = buffer.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, $0.count) }
                    if count < 0 { if errno == EINTR { continue }; throw posixError() }
                    if count == 0 { break }
                    guard UInt64(count) <= maximumBytes - totalBytes else { throw invalid("Runtime grew beyond 256 MiB.") }
                    consumed += UInt64(count); totalBytes += UInt64(count)
                    hasher.update(data: Data(buffer.prefix(count)))
                }
                guard consumed == UInt64(initial.st_size) else { throw invalid("Runtime file size changed while hashing.") }
            }
            var finished = stat()
            guard fstat(descriptor, &finished) == 0 else { throw posixError() }
            guard sameNode(initial, finished), sameNode(initial, try checkedMetadata(url)) else {
                throw invalid("Runtime node changed while hashing.")
            }
        }
        try visit(runtimeRoot, relative: "", depth: 0)
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func childNames(_ directory: URL) throws -> [String] {
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        guard names.count <= maximumNodes,
              names.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("/") && !$0.contains("\0") }) else {
            throw invalid("Invalid or oversized runtime directory.")
        }
        return names.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
    }

    private static func checkedMetadata(_ url: URL) throws -> stat {
        guard url.isFileURL, url.path.hasPrefix("/"), !url.path.contains("\0"),
              url.path == url.standardizedFileURL.resolvingSymlinksInPath().path else {
            throw invalid("Runtime paths must be canonical and contain no symlinks.")
        }
        var result = stat()
        guard lstat(url.path, &result) == 0 else { throw posixError() }
        guard kind(result) != mode_t(S_IFLNK) else { throw invalid("Runtime symlinks are not allowed.") }
        return result
    }

    private static func kind(_ metadata: stat) -> mode_t { metadata.st_mode & mode_t(S_IFMT) }
    private static func sameNode(_ lhs: stat, _ rhs: stat) -> Bool {
        lhs.st_dev == rhs.st_dev && lhs.st_ino == rhs.st_ino && lhs.st_mode == rhs.st_mode && lhs.st_size == rhs.st_size &&
        lhs.st_mtimespec.tv_sec == rhs.st_mtimespec.tv_sec && lhs.st_mtimespec.tv_nsec == rhs.st_mtimespec.tv_nsec &&
        lhs.st_ctimespec.tv_sec == rhs.st_ctimespec.tv_sec && lhs.st_ctimespec.tv_nsec == rhs.st_ctimespec.tv_nsec
    }
    private static func invalid(_ description: String) -> NSError {
        NSError(domain: "ExtensionsAnywhere.RuntimeResources", code: 1, userInfo: [NSLocalizedDescriptionKey: description])
    }
    private static func posixError() -> NSError { NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
}
