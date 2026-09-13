import Foundation
import XCTest
@testable import ExtensionsAnywhere

final class ExtensionLibraryTests: XCTestCase {
    private func withDirectory(_ body: (URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ExtensionsAnywhere-ExtensionLibraryTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root)
    }

    private func source(in root: URL) throws -> ImportedExtensionSource {
        let file = root.appendingPathComponent("theme.css")
        try Data("button { color: green; }".utf8).write(to: file)
        return try ImportedExtensionSource.load(from: file)
    }

    func testPersistenceAppIsolationAndManagementLogs() throws {
        try withDirectory { root in
            let file = root.appendingPathComponent("Support/library.json")
            let imported = try source(in: root)
            let empty = try ExtensionLibrary.load(from: file)
            XCTAssertTrue(empty.records.isEmpty)
            var library = try empty.adding(source: imported, appKey: "app.alpha", name: " Theme ", description: "A stylesheet", to: file)
            let alpha = try XCTUnwrap(library.records.first)
            XCTAssertEqual(alpha.name, "Theme")
            XCTAssertTrue(empty.records.isEmpty)
            library = try library.adding(source: imported, appKey: "app.beta", name: "Other theme", description: "", to: file)
            let saved = try Data(contentsOf: file)
            XCTAssertThrowsError(try library.settingEnabled(false, for: alpha.id, appKey: "app.beta", to: file))
            XCTAssertThrowsError(try library.removing(alpha.id, appKey: "app.beta", to: file))
            XCTAssertEqual(try Data(contentsOf: file), saved)

            library = try library.settingEnabled(false, for: alpha.id, appKey: "app.alpha", to: file)
            let loaded = try ExtensionLibrary.load(from: file)
            XCTAssertEqual(loaded.records.first(where: { $0.id == alpha.id })?.isEnabled, false)
            XCTAssertEqual(loaded.records.first(where: { $0.appKey == "app.beta" })?.isEnabled, true)
            XCTAssertEqual(loaded.logs(for: alpha.id).map(\.event), ["Added to extension library.", "Saved disabled preference."])

            try Data("changed original".utf8).write(to: root.appendingPathComponent("theme.css"))
            XCTAssertEqual(loaded.records.first?.sourceText, imported.text)
            library = try loaded.removing(alpha.id, appKey: "app.alpha", to: file)
            XCTAssertEqual(library.records.map(\.appKey), ["app.beta"])
            XCTAssertEqual(library.logs(for: alpha.id).last?.event, "Removed from extension library.")
            XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("theme.css"), encoding: .utf8), "changed original")
            XCTAssertEqual(try ExtensionLibrary.load(from: file).records, library.records)
        }
    }

    func testImportValidationAndEmptyNameDoNotCreateLibrary() throws {
        try withDirectory { root in
            let unsupported = root.appendingPathComponent("notes.txt")
            try Data("text".utf8).write(to: unsupported)
            XCTAssertThrowsError(try ImportedExtensionSource.load(from: unsupported))
            let directory = root.appendingPathComponent("folder.js")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            XCTAssertThrowsError(try ImportedExtensionSource.load(from: directory))
            let invalid = root.appendingPathComponent("invalid.js")
            try Data([0xff, 0xfe]).write(to: invalid)
            XCTAssertThrowsError(try ImportedExtensionSource.load(from: invalid))
            let large = root.appendingPathComponent("large.css")
            try Data(repeating: 65, count: ImportedExtensionSource.maximumBytes + 1).write(to: large)
            XCTAssertThrowsError(try ImportedExtensionSource.load(from: large))

            let imported = try source(in: root)
            let link = root.appendingPathComponent("linked.css")
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: root.appendingPathComponent("theme.css"))
            XCTAssertThrowsError(try ImportedExtensionSource.load(from: link))
            let uppercase = root.appendingPathComponent("script.JS")
            try Data("console.log('local source');".utf8).write(to: uppercase)
            XCTAssertEqual(try ImportedExtensionSource.load(from: uppercase).type, .js)
            let libraryFile = root.appendingPathComponent("library.json")
            XCTAssertThrowsError(try ExtensionLibrary().adding(source: imported, appKey: "app", name: " \n", description: "", to: libraryFile))
            XCTAssertFalse(FileManager.default.fileExists(atPath: libraryFile.path))
        }
    }

    func testMalformedLibraryIsPreservedEvenWhenSavingAnEmptyValue() throws {
        try withDirectory { root in
            let file = root.appendingPathComponent("library.json")
            let invalid = Data("{malformed".utf8)
            try invalid.write(to: file)
            XCTAssertThrowsError(try ExtensionLibrary.load(from: file))
            XCTAssertThrowsError(try ExtensionLibrary().save(to: file))
            XCTAssertThrowsError(try ExtensionLibrary().adding(source: source(in: root), appKey: "app", name: "Theme", description: "", to: file))
            XCTAssertEqual(try Data(contentsOf: file), invalid)
        }
    }

    func testOversizedLibraryIsRejectedWithoutReplacingIt() throws {
        try withDirectory { root in
            let file = root.appendingPathComponent("library.json")
            try Data().write(to: file)
            let handle = try FileHandle(forWritingTo: file)
            try handle.truncate(atOffset: UInt64(ExtensionLibrary.maximumBytes + 1))
            try handle.close()
            XCTAssertThrowsError(try ExtensionLibrary.load(from: file))
            XCTAssertThrowsError(try ExtensionLibrary().save(to: file))
            XCTAssertEqual(try file.resourceValues(forKeys: [.fileSizeKey]).fileSize, ExtensionLibrary.maximumBytes + 1)
        }
    }

    func testCanonicalAppFallbackAndBoundedLogs() throws {
        try withDirectory { root in
            let app = InstalledApp(id: "unused", name: "Example", bundleIdentifier: nil, url: root.appendingPathComponent("./Example.app"))
            XCTAssertEqual(ExtensionLibrary.appKey(for: app), app.url.standardizedFileURL.resolvingSymlinksInPath().path)
            let file = root.appendingPathComponent("library.json")
            let library = try ExtensionLibrary().adding(source: source(in: root), appKey: ExtensionLibrary.appKey(for: app), name: "Theme", description: "", to: file)
            XCTAssertEqual(library.records(for: app).count, 1)
            var document = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
            let firstLog = try XCTUnwrap((document["logs"] as? [[String: Any]])?.first)
            document["logs"] = (0..<ExtensionLibrary.maximumLogs).map { _ in
                var log = firstLog
                log["id"] = UUID().uuidString
                return log
            }
            try JSONSerialization.data(withJSONObject: document).write(to: file)
            let full = try ExtensionLibrary.load(from: file)
            let record = try XCTUnwrap(full.records.first)
            let updated = try full.settingEnabled(false, for: record.id, appKey: record.appKey, to: file)
            XCTAssertEqual(updated.logs.count, ExtensionLibrary.maximumLogs)
            XCTAssertEqual(updated.logs.last?.event, "Saved disabled preference.")
            XCTAssertEqual(try ExtensionLibrary.load(from: file).logs.count, ExtensionLibrary.maximumLogs)
        }
    }
}
