import Darwin
import Foundation

struct ExtensionRuntimeLog: Identifiable, Equatable, Sendable {
    enum Level: String, Decodable, Sendable { case log, info, warn, error }

    let sequence: Int
    let extensionID: UUID
    let fileName: String
    let revision: String
    let level: Level
    let message: String
    let timestamp: Date

    var id: Int { sequence }
    var copiedLine: String {
        "[\(timestamp.formatted(date: .numeric, time: .standard))] [\(level.rawValue)] [\(fileName) @ \(revision)] \(message)"
    }
}

struct ExtensionRuntimeLogSnapshot: Equatable, Sendable {
    let events: [ExtensionRuntimeLog]
    let issue: String?
    static let empty = Self(events: [], issue: nil)
    static let invalid = Self(events: [], issue: "Runtime logs couldn’t be read. The file is invalid or doesn’t match this app and session.")
}

/// A read-only presentation boundary. A matching app/session is metadata
/// consistency, not authentication or proof that an extension is connected.
enum ExtensionRuntimeLogs {
    static let maximumBytes = 512 * 1024
    static let maximumEvents = 500
    static let maximumMessageBytes = 4096
    static let fileName = "extension-logs.json"

    struct Request: Equatable, Sendable {
        let sessionDirectory: URL?
        let appKey: String
        let extensionID: UUID
        let sourceFileNames: Set<String>
    }

    private struct Envelope: Decodable {
        let schema: Int
        let appKey: String
        let sessionID: UUID
        let events: [Event]
    }

    private struct Event: Decodable {
        let sequence: Int
        let extensionID: UUID
        let fileName: String
        let revision: String
        let level: ExtensionRuntimeLog.Level
        let message: String
        let timestamp: String
    }

    static func load(_ request: Request) -> ExtensionRuntimeLogSnapshot {
        guard let session = request.sessionDirectory else { return .empty }
        do {
            let components = session.path.split(separator: "/", omittingEmptySubsequences: false)
            guard session.isFileURL,
                  session.path.utf8.count <= 4096,
                  !session.path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                  components.first == "", components.count > 1,
                  components.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
                  session.deletingLastPathComponent().lastPathComponent == "Sessions",
                  !session.pathComponents.contains(where: { $0.lowercased().hasSuffix(".app") }),
                  let sessionID = UUID(uuidString: session.lastPathComponent) else { return .invalid }
            guard let data = try readFile(in: session) else { return .empty }
            return .init(events: try decode(data, request: request, sessionID: sessionID), issue: nil)
        } catch {
            return .invalid
        }
    }

    static func decode(_ data: Data, request: Request, sessionID: UUID) throws -> [ExtensionRuntimeLog] {
        guard data.count <= maximumBytes else { throw invalid() }
        let envelope = try JSONDecoder().decode(Envelope.self, from: data)
        guard envelope.schema == 1, envelope.appKey == request.appKey,
              envelope.sessionID == sessionID, envelope.events.count <= maximumEvents else { throw invalid() }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let standard = ISO8601DateFormatter()
        var previousSequence = 0
        var result: [ExtensionRuntimeLog] = []
        for event in envelope.events {
            guard event.sequence > previousSequence,
                  validSourcePath(event.fileName),
                  validRevision(event.revision),
                  event.message.utf8.count <= maximumMessageBytes,
                  event.timestamp.utf8.count <= 64,
                  let timestamp = fractional.date(from: event.timestamp) ?? standard.date(from: event.timestamp) else {
                throw invalid()
            }
            previousSequence = event.sequence
            // A session may contain several extensions. Never display another
            // record's output in this sheet, including removed records' events.
            guard event.extensionID == request.extensionID else { continue }
            guard request.sourceFileNames.contains(event.fileName) else { throw invalid() }
            result.append(.init(sequence: event.sequence, extensionID: event.extensionID,
                                fileName: event.fileName, revision: event.revision, level: event.level,
                                message: event.message, timestamp: timestamp))
        }
        return result
    }

    private static func validSourcePath(_ path: String) -> Bool {
        guard !path.isEmpty, path.utf16.count <= 256, path.lowercased().hasSuffix(".js"),
              !path.contains("\\"), !path.contains(":"),
              !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return false }
        return path.split(separator: "/", omittingEmptySubsequences: false)
            .allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    private static func validRevision(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 128 else { return false }
        let bytes = Array(value.utf8)
        func alphaNumeric(_ byte: UInt8) -> Bool {
            (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
        }
        return alphaNumeric(bytes[0]) && bytes.allSatisfy { alphaNumeric($0) || [46, 95, 58, 45].contains($0) }
    }

    /// Foundation can rewrite macOS's real /private/var path to its /var alias,
    /// even in resolvingSymlinksInPath(). Descriptor traversal is authoritative.
    /// Open each directory relative to the previous descriptor so a symlink
    /// substituted in an ancestor cannot redirect the fixed log filename.
    /// O_NONBLOCK and descriptor type checks also reject FIFOs without waiting.
    private static func readFile(in session: URL) throws -> Data? {
        var directory = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard directory >= 0 else { throw invalid() }
        defer { Darwin.close(directory) }
        let components = session.pathComponents.dropFirst()
        guard components.count <= 128 else { throw invalid() }
        for component in components {
            let next = openat(directory, component, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
            guard next >= 0 else {
                if errno == ENOENT { return nil }
                throw invalid()
            }
            Darwin.close(directory)
            directory = next
        }
        let descriptor = openat(directory, fileName, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else {
            if errno == ENOENT { return nil }
            throw invalid()
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var before = stat()
        guard fstat(descriptor, &before) == 0,
              before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              before.st_size >= 0, before.st_size <= maximumBytes else { throw invalid() }
        let data = try handle.read(upToCount: maximumBytes + 1) ?? Data()
        var after = stat()
        guard data.count <= maximumBytes, data.count == before.st_size,
              fstat(descriptor, &after) == 0, before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else { throw invalid() }
        return data
    }

    private static func invalid() -> NSError {
        NSError(domain: "ExtensionsAnywhere.RuntimeLogs", code: 1)
    }
}
