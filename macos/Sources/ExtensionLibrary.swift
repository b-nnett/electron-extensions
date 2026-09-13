import Foundation
import RuntimeCatalog

enum ExtensionSourceType: String, Codable, CaseIterable, Sendable {
    case css, js
}

enum ExtensionLibraryError: LocalizedError {
    case invalidSource, sourceTooLarge, invalidUTF8, emptyName, emptyAppKey, missingRecord, invalidLibrary
    case invalidManifest, manifestTooLarge, unsafeSourcePath, packageTooLarge, changedDuringSave

    var errorDescription: String? {
        switch self {
        case .invalidSource: "Choose a regular .css or .js file."
        case .sourceTooLarge: "Extension files must be 2 MiB or smaller."
        case .invalidUTF8: "The extension file must contain UTF-8 text."
        case .emptyName: "Enter a name for the extension."
        case .emptyAppKey: "The extension needs an application identifier."
        case .missingRecord: "This extension is no longer available for the selected app."
        case .invalidLibrary: "The extension library is invalid. Its existing file has been preserved."
        case .invalidManifest: "Use a version 1 manifest with a name, description, version, and at least one CSS or JS file."
        case .manifestTooLarge: "The manifest must be 64 KiB or smaller."
        case .unsafeSourcePath: "Source paths must be relative files contained in the manifest folder."
        case .packageTooLarge: "An extension can include up to 32 files and 8 MiB of source text."
        case .changedDuringSave: "The extension library changed while saving. Its newer contents were preserved. Refresh and try again."
        }
    }
}

struct ImportedExtensionSource: Sendable {
    static let maximumBytes = 2 * 1024 * 1024
    let fileName: String
    let type: ExtensionSourceType
    let text: String

    static func load(from url: URL) throws -> ImportedExtensionSource {
        guard url.isFileURL,
              let type = ExtensionSourceType(rawValue: url.pathExtension.lowercased()) else {
            throw ExtensionLibraryError.invalidSource
        }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw ExtensionLibraryError.invalidSource
        }
        guard let size = values.fileSize, size <= maximumBytes else {
            throw ExtensionLibraryError.sourceTooLarge
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maximumBytes + 1) ?? Data()
        guard data.count <= maximumBytes else { throw ExtensionLibraryError.sourceTooLarge }
        guard let text = String(data: data, encoding: .utf8) else { throw ExtensionLibraryError.invalidUTF8 }
        return ImportedExtensionSource(fileName: url.lastPathComponent, type: type, text: text)
    }
}

private func isRelativeSourcePath(_ path: String) -> Bool {
    guard !path.isEmpty, !(path as NSString).isAbsolutePath,
          !path.contains("\\"), !path.contains(":"),
          !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return false }
    return path.split(separator: "/", omittingEmptySubsequences: false)
        .allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
}

struct ExtensionManifest: Codable, Sendable {
    let manifest_version: Int
    let name: String
    let description: String
    let version: String
    let css: [String]
    let js: [String]

    init(manifest_version: Int = 1, name: String, description: String, version: String, css: [String] = [], js: [String] = []) {
        self.manifest_version = manifest_version
        self.name = name
        self.description = description
        self.version = version
        self.css = css
        self.js = js
    }

    private enum CodingKeys: String, CodingKey { case manifest_version, name, description, version, css, js }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        manifest_version = try values.decode(Int.self, forKey: .manifest_version)
        name = try values.decode(String.self, forKey: .name)
        description = try values.decode(String.self, forKey: .description)
        version = try values.decode(String.self, forKey: .version)
        css = try values.decodeIfPresent([String].self, forKey: .css) ?? []
        js = try values.decodeIfPresent([String].self, forKey: .js) ?? []
        try validate()
    }

    func validate() throws {
        guard manifest_version == 1,
              [name, description, version].allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }),
              !(css + js).isEmpty else { throw ExtensionLibraryError.invalidManifest }
        guard css.count + js.count <= ImportedExtensionPackage.maximumFiles else { throw ExtensionLibraryError.packageTooLarge }
        for (paths, type) in [(css, ExtensionSourceType.css), (js, .js)] {
            for path in paths {
                guard isRelativeSourcePath(path) else { throw ExtensionLibraryError.unsafeSourcePath }
                guard (path as NSString).pathExtension.lowercased() == type.rawValue else { throw ExtensionLibraryError.invalidManifest }
            }
        }
        guard Set(css + js).count == css.count + js.count else { throw ExtensionLibraryError.invalidManifest }
    }
}

struct ImportedExtensionPackage: Sendable {
    static let maximumManifestBytes = 64 * 1024
    static let maximumTotalBytes = 8 * 1024 * 1024
    static let maximumFiles = 32
    let manifest: ExtensionManifest
    let sources: [ImportedExtensionSource]
    let manifestFileName: String

    static func load(from url: URL) throws -> ImportedExtensionPackage {
        guard url.isFileURL, url.pathExtension.lowercased() == "json" else { throw ExtensionLibraryError.invalidManifest }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else { throw ExtensionLibraryError.invalidManifest }
        guard let size = values.fileSize, size <= maximumManifestBytes else { throw ExtensionLibraryError.manifestTooLarge }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maximumManifestBytes + 1) ?? Data()
        guard data.count <= maximumManifestBytes else { throw ExtensionLibraryError.manifestTooLarge }
        let manifest = try JSONDecoder().decode(ExtensionManifest.self, from: data)
        let folder = url.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
        var sources: [ImportedExtensionSource] = []
        var totalBytes = 0
        for reference in manifest.css + manifest.js {
            let sourceURL = folder.appendingPathComponent(reference).standardizedFileURL.resolvingSymlinksInPath()
            let prefix = folder.path.hasSuffix("/") ? folder.path : folder.path + "/"
            guard sourceURL.path.hasPrefix(prefix) else { throw ExtensionLibraryError.unsafeSourcePath }
            let source = try ImportedExtensionSource.load(from: sourceURL)
            guard source.type.rawValue == (reference as NSString).pathExtension.lowercased() else { throw ExtensionLibraryError.invalidManifest }
            let bytes = try sourceURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? source.text.utf8.count
            totalBytes += max(bytes, source.text.utf8.count)
            guard totalBytes <= maximumTotalBytes else { throw ExtensionLibraryError.packageTooLarge }
            sources.append(ImportedExtensionSource(fileName: reference, type: source.type, text: source.text))
        }
        return ImportedExtensionPackage(manifest: manifest, sources: sources, manifestFileName: url.lastPathComponent)
    }
}

struct StoredExtensionSource: Codable, Hashable, Sendable {
    let fileName: String
    let type: ExtensionSourceType
    let text: String
}

struct ExtensionRecord: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let appKey: String
    let name: String
    let description: String
    let sourceFileName: String
    let sourceType: ExtensionSourceType
    let sourceText: String
    var isEnabled: Bool
    let createdAt: Date
    var manifestVersion: String? = nil
    var sourceFiles: [StoredExtensionSource]? = nil

    var fileCount: Int { sourceFiles?.count ?? 1 }
    var sourceLabel: String {
        let types = Set(sourceFiles?.map(\.type) ?? [sourceType])
        return ExtensionSourceType.allCases.filter { types.contains($0) }.map { $0.rawValue.uppercased() }.joined(separator: " + ")
    }
}

struct ExtensionManagementLog: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let extensionID: UUID
    let appKey: String
    let timestamp: Date
    let event: String
    let isEnabled: Bool?
}

/// Stores source text and management preferences only. It never executes source.
/// Callers serialize mutations and publish the returned value after saving succeeds.
struct ExtensionLibrary: Codable, Sendable {
    static let maximumLogs = 500
    static let maximumBytes = 64 * 1024 * 1024
    private let schemaVersion = 1
    private(set) var records: [ExtensionRecord]
    private(set) var logs: [ExtensionManagementLog]

    private enum CodingKeys: String, CodingKey { case schemaVersion, records, logs }
    private struct RawKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    init() {
        records = []
        logs = []
    }

    init(from decoder: Decoder) throws {
        let raw = try decoder.container(keyedBy: RawKey.self)
        guard raw.allKeys.allSatisfy({ ["schemaVersion", "records", "logs"].contains($0.stringValue) }) else {
            throw ExtensionLibraryError.invalidLibrary
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let version = try values.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
        guard version == 1 else {
            throw ExtensionLibraryError.invalidLibrary
        }
        records = try values.decode([ExtensionRecord].self, forKey: .records)
        logs = try values.decode([ExtensionManagementLog].self, forKey: .logs)
        try validate()
    }

    static var defaultURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("Extensions Anywhere/library.json")
    }

    static func load(from url: URL = defaultURL) throws -> ExtensionLibrary {
        guard let data = try readData(from: url) else { return ExtensionLibrary() }
        return try decode(data)
    }

    static func decode(_ data: Data) throws -> ExtensionLibrary {
        guard data.count <= maximumBytes else { throw ExtensionLibraryError.invalidLibrary }
        let library = try JSONDecoder().decode(ExtensionLibrary.self, from: data)
        try library.validate()
        return library
    }

    static func readData(from url: URL) throws -> Data? {
        try RuntimeBoundedFile.read(url, maximumBytes: maximumBytes)
    }

    func save(to url: URL = defaultURL, expectedOriginal: Data? = nil, checkExpected: Bool = false) throws {
        let data = try encodedData()
        // Staged, previously absent files do not create temporary backup files.
        // Only a valid existing committed state may replace the last-good copy.
        let original = try Self.readData(from: url)
        // Keep a caller's reviewed snapshot through encoding and the first read;
        // never silently adopt a newer file as the staged mutation's baseline.
        guard !checkExpected || original == expectedOriginal else { throw ExtensionLibraryError.changedDuringSave }
        if let original {
            _ = try Self.decode(original)
            if original == data { return }
            try LibraryRecoveryFiles.write(original, to: Self.backupURL(for: url))
        }
        try LibraryRecoveryFiles.write(data, to: url, expected: original, checkExpected: true)
    }

    static func backupURL(for url: URL = defaultURL) -> URL {
        url.deletingPathExtension().appendingPathExtension("last-good.json")
    }

    func encodedData() throws -> Data {
        try validate()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(self)
        guard data.count <= Self.maximumBytes else { throw ExtensionLibraryError.invalidLibrary }
        return data
    }

    func disabledForRestore() -> ExtensionLibrary {
        var restored = self
        for index in restored.records.indices where restored.records[index].isEnabled {
            restored.records[index].isEnabled = false
            restored.appendLog(for: restored.records[index], event: "Restored from backup with the extension disabled.", isEnabled: false)
        }
        return restored
    }

    static func appKey(for app: InstalledApp) -> String {
        if let identifier = app.bundleIdentifier, !identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return identifier
        }
        return app.url.standardizedFileURL.resolvingSymlinksInPath().path
    }

    func records(for app: InstalledApp) -> [ExtensionRecord] {
        records.filter { $0.appKey == Self.appKey(for: app) }
    }

    func logs(for extensionID: UUID) -> [ExtensionManagementLog] {
        logs.filter { $0.extensionID == extensionID }
    }

    func adding(
        source: ImportedExtensionSource, appKey: String, name: String, description: String,
        isEnabled: Bool = true, to url: URL = defaultURL
    ) throws -> ExtensionLibrary {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw ExtensionLibraryError.emptyName }
        guard !appKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ExtensionLibraryError.emptyAppKey }
        let record = ExtensionRecord(
            id: UUID(), appKey: appKey, name: name, description: description,
            sourceFileName: source.fileName, sourceType: source.type, sourceText: source.text,
            isEnabled: isEnabled, createdAt: Date()
        )
        var next = self
        next.records.append(record)
        next.appendLog(for: record, event: "Added to extension library.", isEnabled: isEnabled)
        try next.save(to: url)
        return next
    }

    func settingEnabled(
        _ enabled: Bool, for id: UUID, appKey: String, to url: URL = defaultURL
    ) throws -> ExtensionLibrary {
        guard let index = records.firstIndex(where: { $0.id == id && $0.appKey == appKey }) else {
            throw ExtensionLibraryError.missingRecord
        }
        if records[index].isEnabled == enabled { return self }
        var next = self
        next.records[index].isEnabled = enabled
        next.appendLog(for: next.records[index], event: enabled ? "Saved enabled preference." : "Saved disabled preference.", isEnabled: enabled)
        try next.save(to: url)
        return next
    }

    func adding(
        package: ImportedExtensionPackage, appKey: String,
        isEnabled: Bool = true, to url: URL = defaultURL
    ) throws -> ExtensionLibrary {
        try package.manifest.validate()
        guard !appKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ExtensionLibraryError.emptyAppKey }
        let paths = package.manifest.css + package.manifest.js
        guard package.sources.map(\.fileName) == paths, let first = package.sources.first else { throw ExtensionLibraryError.invalidManifest }
        let record = ExtensionRecord(
            id: UUID(), appKey: appKey, name: package.manifest.name.trimmingCharacters(in: .whitespacesAndNewlines),
            description: package.manifest.description, sourceFileName: (first.fileName as NSString).lastPathComponent,
            sourceType: first.type, sourceText: first.text, isEnabled: isEnabled, createdAt: Date(),
            manifestVersion: package.manifest.version,
            sourceFiles: package.sources.map { StoredExtensionSource(fileName: $0.fileName, type: $0.type, text: $0.text) }
        )
        var next = self
        next.records.append(record)
        next.appendLog(for: record, event: "Added manifest package to extension library (\(record.fileCount) files).", isEnabled: isEnabled)
        try next.save(to: url)
        return next
    }

    func removing(_ id: UUID, appKey: String, to url: URL = defaultURL) throws -> ExtensionLibrary {
        guard let record = records.first(where: { $0.id == id && $0.appKey == appKey }) else {
            throw ExtensionLibraryError.missingRecord
        }
        var next = self
        next.records.removeAll { $0.id == id && $0.appKey == appKey }
        next.appendLog(for: record, event: "Removed from extension library.", isEnabled: nil)
        try next.save(to: url)
        return next
    }

    private mutating func appendLog(for record: ExtensionRecord, event: String, isEnabled: Bool?) {
        logs.append(ExtensionManagementLog(
            id: UUID(), extensionID: record.id, appKey: record.appKey,
            timestamp: Date(), event: event, isEnabled: isEnabled
        ))
        if logs.count > Self.maximumLogs { logs.removeFirst(logs.count - Self.maximumLogs) }
    }

    private func validate() throws {
        guard Set(records.map(\.id)).count == records.count, logs.count <= Self.maximumLogs else {
            throw ExtensionLibraryError.invalidLibrary
        }
        for record in records {
            guard !record.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !record.appKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !record.sourceFileName.isEmpty,
                  (record.sourceFileName as NSString).lastPathComponent == record.sourceFileName,
                  ExtensionSourceType(rawValue: (record.sourceFileName as NSString).pathExtension.lowercased()) == record.sourceType,
                  record.sourceText.utf8.count <= ImportedExtensionSource.maximumBytes else {
                throw ExtensionLibraryError.invalidLibrary
            }
            if record.manifestVersion != nil || record.sourceFiles != nil {
                guard let version = record.manifestVersion, !version.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      !record.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      let sources = record.sourceFiles, !sources.isEmpty, sources.count <= ImportedExtensionPackage.maximumFiles,
                      Set(sources.map(\.fileName)).count == sources.count,
                      sources.reduce(0, { $0 + $1.text.utf8.count }) <= ImportedExtensionPackage.maximumTotalBytes,
                      let first = sources.first,
                      (first.fileName as NSString).lastPathComponent == record.sourceFileName,
                      first.type == record.sourceType, first.text == record.sourceText else { throw ExtensionLibraryError.invalidLibrary }
                for source in sources {
                    guard isRelativeSourcePath(source.fileName),
                          (source.fileName as NSString).pathExtension.lowercased() == source.type.rawValue,
                          source.text.utf8.count <= ImportedExtensionSource.maximumBytes else { throw ExtensionLibraryError.invalidLibrary }
                }
            }
        }
    }
}
