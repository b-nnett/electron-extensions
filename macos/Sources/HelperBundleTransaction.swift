import CryptoKit
import Darwin
import Foundation

/// Commits all signed helper contents at once while retaining the .app root's
/// inode: Finder aliases otherwise follow the old bundle into its backup path.
@MainActor
struct HelperBundleTransaction {
    enum Checkpoint: CaseIterable, Equatable { case receiptSaved, contentsCommitted, installedVerified }
    enum Result: Equatable { case complete, deferred }
    let installed: URL
    let identifier: String
    var verify: (URL) throws -> Void
    var isActive: () throws -> Bool
    var checkpoint: (Checkpoint) throws -> Void = { _ in }

    private struct Receipt: Codable {
        let version: Int
        let transaction: UUID
        let destination: String
        let identifier: String
        let previousDigest: String?
        let nextDigest: String
    }
    private let manager = FileManager.default
    private var folder: URL { installed.deletingLastPathComponent() }
    var receiptURL: URL { folder.appendingPathComponent(".helper-update.json") }

    func hasPendingCommit() throws -> Bool { try exists(receiptURL) }

    @discardableResult
    func install(build: (URL) throws -> Void) throws -> Result {
        guard try recover() == .complete, !(try isActive()) else { return .deferred }
        try validateLocation()
        if try exists(installed) { try recognize(installed) }
        let transaction = UUID()
        let stage = stageURL(transaction)
        var retained = false
        defer { if !retained { try? manager.removeItem(at: stage) } }
        try build(stage)
        try recognize(stage)
        try verify(stage)
        let nextDigest = try contentsDigest(stage)
        guard !(try isActive()) else { return .deferred }
        let previousDigest = try exists(installed) ? contentsDigest(installed) : nil
        let receipt = Receipt(version: 1, transaction: transaction, destination: installed.lastPathComponent,
                              identifier: identifier, previousDigest: previousDigest, nextDigest: nextDigest)
        guard !(try exists(receiptURL)) else { throw failure("Another launcher update is pending.") }
        try JSONEncoder().encode(receipt).write(to: receiptURL, options: .atomic)
        retained = true
        let file = try FileHandle(forWritingTo: receiptURL)
        try file.synchronize()
        try file.close()
        try synchronizeFolder()
        try checkpoint(.receiptSaved)
        return try finish(receipt)
    }

    /// A crash can leave a verified stage plus the old installation, or an
    /// already-committed installation plus its old contents in the stage.
    @discardableResult
    func recover() throws -> Result {
        try validateLocation()
        guard try exists(receiptURL) else { return .complete }
        guard !(try isActive()) else { return .deferred }
        let attributes = try manager.attributesOfItem(atPath: receiptURL.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((attributes[.size] as? NSNumber)?.intValue ?? Int.max) <= 4096 else {
            throw failure("The launcher update receipt could not be identified. It was preserved.")
        }
        let data = try Data(contentsOf: receiptURL)
        guard data.count <= 4096, let receipt = try? JSONDecoder().decode(Receipt.self, from: data),
              receipt.version == 1, receipt.destination == installed.lastPathComponent,
              receipt.identifier == identifier, validDigest(receipt.nextDigest),
              receipt.previousDigest == nil || validDigest(receipt.previousDigest!) else {
            throw failure("The launcher update receipt is invalid. It was preserved.")
        }
        return try finish(receipt)
    }

    private func finish(_ receipt: Receipt) throws -> Result {
        let stage = stageURL(receipt.transaction)
        guard !(try isActive()) else { return .deferred }
        let current = try exists(installed) ? contentsDigest(installed) : nil
        if current != receipt.nextDigest {
            guard current == receipt.previousDigest, try exists(stage),
                  try contentsDigest(stage) == receipt.nextDigest else {
                throw failure("The launcher changed during its update. The installation and recovery files were preserved.")
            }
            try recognize(stage)
            try verify(stage)
            guard !(try isActive()) else { return .deferred }
            // Recheck immediately before committing; no external change may be
            // silently folded into a previously approved replacement.
            guard (try exists(installed) ? contentsDigest(installed) : nil) == receipt.previousDigest else {
                throw failure("The installed launcher changed during preparation. It was preserved.")
            }
            guard !(try isActive()) else { return .deferred }
            if receipt.previousDigest != nil {
                try recognize(installed)
                let oldContents = installed.appendingPathComponent("Contents").path
                let newContents = stage.appendingPathComponent("Contents").path
                guard renameatx_np(AT_FDCWD, oldContents, AT_FDCWD, newContents, UInt32(RENAME_SWAP)) == 0 else {
                    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                }
            } else { try manager.moveItem(at: stage, to: installed) }
            try synchronizeFolder()
            try checkpoint(.contentsCommitted)
        }
        try recognize(installed)
        guard try contentsDigest(installed) == receipt.nextDigest else {
            throw failure("The committed launcher could not be verified. Recovery files were preserved.")
        }
        try verify(installed)
        try checkpoint(.installedVerified)
        // The old contents must still be ours before deleting a backup. Remove
        // the receipt before best-effort cleanup so interrupted cleanup cannot
        // make a successfully committed helper permanently fail recovery.
        if try exists(stage) {
            guard let previous = receipt.previousDigest, try contentsDigest(stage) == previous else {
                throw failure("The launcher backup changed. It was preserved.")
            }
        }
        try manager.removeItem(at: receiptURL)
        try synchronizeFolder()
        try? manager.removeItem(at: stage)
        return .complete
    }

    private func validateLocation() throws {
        guard installed.isFileURL, installed.pathExtension == "app",
              installed.path == installed.standardizedFileURL.resolvingSymlinksInPath().path,
              !folder.pathComponents.contains(where: { $0.lowercased().hasSuffix(".app") }) else {
            throw failure("Launcher updates must stay in their own application-support folder.")
        }
    }

    private func recognize(_ app: URL) throws {
        guard try manager.attributesOfItem(atPath: app.path)[.type] as? FileAttributeType == .typeDirectory,
              try manager.attributesOfItem(atPath: app.appendingPathComponent("Contents").path)[.type] as? FileAttributeType == .typeDirectory,
              let data = RuntimeSessionFiles.read(app.appendingPathComponent("Contents/Info.plist"), limit: 64 * 1024),
              let info = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
              info["CFBundleIdentifier"] as? String == identifier,
              info["CFBundleExecutable"] as? String == "ExtensionLauncher" else {
            throw failure("The existing launcher could not be identified. It was preserved.")
        }
    }

    private func stageURL(_ id: UUID) -> URL { folder.appendingPathComponent(".helper-stage-\(id.uuidString).app") }
    private func exists(_ url: URL) throws -> Bool {
        do { _ = try manager.attributesOfItem(atPath: url.path); return true }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return false }
    }
    private func validDigest(_ digest: String) -> Bool {
        digest.count == 64 && digest.allSatisfy { $0.isASCII && ($0.isNumber || ("a"..."f").contains(String($0))) }
    }
    private func synchronizeFolder() throws {
        let descriptor = Darwin.open(folder.path, O_RDONLY)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { Darwin.close(descriptor) }
        guard fsync(descriptor) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
    private func failure(_ message: String) -> Error { ElectronLaunchError.shortcut(message) }

    /// Streaming hash avoids loading a bundled Node runtime into memory. Files,
    /// modes and symlink destinations participate; symlinks are never followed.
    private func contentsDigest(_ app: URL) throws -> String {
        let root = app.appendingPathComponent("Contents")
        guard try manager.attributesOfItem(atPath: root.path)[.type] as? FileAttributeType == .typeDirectory,
              let enumerator = manager.enumerator(at: root, includingPropertiesForKeys: nil) else {
            throw failure("The launcher contents are missing or invalid.")
        }
        var paths = [URL]()
        for case let url as URL in enumerator { paths.append(url) }
        var hash = SHA256()
        for url in paths.sorted(by: { $0.path < $1.path }) {
            let attributes = try manager.attributesOfItem(atPath: url.path)
            let type = attributes[.type] as? FileAttributeType
            let relative = String(url.path.dropFirst(root.path.count))
            hash.update(data: Data("\(relative)\0\(type?.rawValue ?? "")\0\(attributes[.posixPermissions] ?? "")\0\(type == .typeDirectory ? "" : String(describing: attributes[.size] ?? ""))\0".utf8))
            switch type {
            case .typeDirectory: break
            case .typeSymbolicLink:
                hash.update(data: Data(try manager.destinationOfSymbolicLink(atPath: url.path).utf8))
            case .typeRegular:
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                while let bytes = try handle.read(upToCount: 1024 * 1024), !bytes.isEmpty { hash.update(data: bytes) }
            default: throw failure("The launcher contains an unsupported file type.")
            }
            hash.update(data: Data([0]))
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
