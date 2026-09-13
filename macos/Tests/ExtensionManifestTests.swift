import Foundation
import XCTest
@testable import ExtensionsAnywhere

final class ExtensionManifestTests: XCTestCase {
    private func withDirectory(_ body: (URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ExtensionsAnywhere-ManifestTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root)
    }

    private func write(_ data: Data, to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file)
    }

    private func manifest(in folder: URL, css: [String] = [], js: [String] = []) throws -> URL {
        let file = folder.appendingPathComponent("manifest.json")
        try write(JSONSerialization.data(withJSONObject: [
            "manifest_version": 1, "name": "Example extension", "description": "A test package",
            "version": "1.2.3", "css": css, "js": js
        ]), to: file)
        return file
    }

    func testMultipleCSSAndJSSourcesAreCopiedAndPersisted() throws {
        try withDirectory { root in
            let folder = root.appendingPathComponent("Package")
            try write(Data("body { color: red; }".utf8), to: folder.appendingPathComponent("styles/base.css"))
            try write(Data("button { color: green; }".utf8), to: folder.appendingPathComponent("styles/buttons.css"))
            try write(Data("console.log('stored only');".utf8), to: folder.appendingPathComponent("scripts/main.js"))
            let file = try manifest(in: folder, css: ["styles/base.css", "styles/buttons.css"], js: ["scripts/main.js"])
            let package = try ImportedExtensionPackage.load(from: file)
            XCTAssertEqual(package.manifestFileName, "manifest.json")
            XCTAssertEqual(package.sources.map(\.fileName), ["styles/base.css", "styles/buttons.css", "scripts/main.js"])
            let storage = root.appendingPathComponent("library.json")
            let library = try ExtensionLibrary().adding(package: package, appKey: "app.example", isEnabled: false, to: storage)
            let record = try XCTUnwrap(library.records.first)
            XCTAssertEqual(record.name, package.manifest.name)
            XCTAssertEqual(record.description, package.manifest.description)
            XCTAssertEqual(record.manifestVersion, "1.2.3")
            XCTAssertEqual(record.fileCount, 3)
            XCTAssertEqual(record.sourceLabel, "CSS + JS")
            XCTAssertEqual(record.sourceFileName, "base.css")
            XCTAssertFalse(record.isEnabled)
            try FileManager.default.removeItem(at: folder)
            let loaded = try ExtensionLibrary.load(from: storage)
            XCTAssertEqual(loaded.records, library.records)
            XCTAssertEqual(loaded.records.first?.sourceFiles?.map(\.text), package.sources.map(\.text))
        }
    }

    func testRelativeAndSymlinkEscapesAndMissingFilesAreRejected() throws {
        try withDirectory { root in
            let folder = root.appendingPathComponent("Package")
            let outside = root.appendingPathComponent("outside.css")
            try write(Data("body {}".utf8), to: outside)
            for reference in ["../outside.css", outside.path, "styles/../../outside.css", "missing.css"] {
                let file = try manifest(in: folder, css: [reference])
                XCTAssertThrowsError(try ImportedExtensionPackage.load(from: file), reference)
            }
            let link = folder.appendingPathComponent("linked.css")
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
            XCTAssertThrowsError(try ImportedExtensionPackage.load(from: manifest(in: folder, css: ["linked.css"])))
            try FileManager.default.createSymbolicLink(at: folder.appendingPathComponent("escape"), withDestinationURL: root)
            XCTAssertThrowsError(try ImportedExtensionPackage.load(from: manifest(in: folder, css: ["escape/outside.css"])))
        }
    }

    func testRequiredSchemaAndOptionalSourceArrays() throws {
        let valid: [String: Any] = ["manifest_version": 1, "name": "Name", "description": "Description", "version": "1", "js": ["main.js"]]
        let decoded = try JSONDecoder().decode(ExtensionManifest.self, from: JSONSerialization.data(withJSONObject: valid))
        XCTAssertEqual(decoded.css, [])
        XCTAssertEqual(decoded.js, ["main.js"])
        for (key, value) in [("manifest_version", 2 as Any), ("name", " " as Any), ("description", "" as Any), ("version", "\n" as Any), ("js", "main.js" as Any), ("js", [] as Any)] {
            var invalid = valid
            invalid[key] = value
            XCTAssertThrowsError(try JSONDecoder().decode(ExtensionManifest.self, from: JSONSerialization.data(withJSONObject: invalid)))
        }
        var missing = valid
        missing.removeValue(forKey: "manifest_version")
        XCTAssertThrowsError(try JSONDecoder().decode(ExtensionManifest.self, from: JSONSerialization.data(withJSONObject: missing)))
    }

    func testManifestFileCountAndSourceSizeLimits() throws {
        try withDirectory { root in
            let file = root.appendingPathComponent("manifest.json")
            try write(Data(repeating: 32, count: ImportedExtensionPackage.maximumManifestBytes + 1), to: file)
            XCTAssertThrowsError(try ImportedExtensionPackage.load(from: file))
            _ = try manifest(in: root, css: (0..<33).map { "\($0).css" })
            XCTAssertThrowsError(try ImportedExtensionPackage.load(from: file))
            try write(Data(repeating: 65, count: ImportedExtensionSource.maximumBytes + 1), to: root.appendingPathComponent("large.css"))
            _ = try manifest(in: root, css: ["large.css"])
            XCTAssertThrowsError(try ImportedExtensionPackage.load(from: file))
            let files = (0..<5).map { "part\($0).css" }
            for name in files { try write(Data(repeating: 65, count: ImportedExtensionSource.maximumBytes), to: root.appendingPathComponent(name)) }
            _ = try manifest(in: root, css: files)
            XCTAssertThrowsError(try ImportedExtensionPackage.load(from: file))
        }
    }

    func testLegacyRecordsDecodeAndNewPersistedMetadataIsValidated() throws {
        try withDirectory { root in
            let sourceURL = root.appendingPathComponent("old.css")
            try write(Data("body {}".utf8), to: sourceURL)
            let storage = root.appendingPathComponent("library.json")
            let legacy = try ExtensionLibrary().adding(source: ImportedExtensionSource.load(from: sourceURL), appKey: "app.old", name: "Legacy", description: "", to: storage)
            let oldID = try XCTUnwrap(legacy.records.first?.id)
            let old = try XCTUnwrap(ExtensionLibrary.load(from: storage).records.first)
            XCTAssertNil(old.manifestVersion)
            XCTAssertNil(old.sourceFiles)
            XCTAssertEqual(old.fileCount, 1)
            XCTAssertEqual(old.sourceLabel, "CSS")
            let package = try ImportedExtensionPackage.load(from: manifest(in: root, css: ["old.css"]))
            let combined = try legacy.adding(package: package, appKey: "app.new", to: storage)
            XCTAssertEqual(combined.records.first?.id, oldID)
            XCTAssertEqual(try ExtensionLibrary.load(from: storage).records.count, 2)
            var document = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: storage)) as? [String: Any])
            var records = try XCTUnwrap(document["records"] as? [[String: Any]])
            var sources = try XCTUnwrap(records[1]["sourceFiles"] as? [[String: Any]])
            sources[0]["fileName"] = "../escape.css"
            records[1]["sourceFiles"] = sources
            document["records"] = records
            let invalid = try JSONSerialization.data(withJSONObject: document)
            try invalid.write(to: storage)
            XCTAssertThrowsError(try ExtensionLibrary.load(from: storage))
            XCTAssertThrowsError(try combined.save(to: storage))
            XCTAssertEqual(try Data(contentsOf: storage), invalid)
        }
    }
}
