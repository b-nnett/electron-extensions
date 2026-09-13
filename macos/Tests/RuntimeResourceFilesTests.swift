import Foundation
import Darwin
import RuntimeCatalog
import XCTest

final class RuntimeResourceFilesTests: XCTestCase {
    private func withDirectory(_ body: (URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ExtensionsAnywhere-RuntimeResources-\(UUID().uuidString)")
            .standardizedFileURL.resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root)
    }

    private func directory(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }

    private func write(_ text: String, to url: URL) throws {
        try Data(text.utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
    }

    func testDigestIsDeterministicAcrossLocationAndCreationOrder() throws {
        try withDirectory { root in
            let first = root.appendingPathComponent("One.app/Contents/Resources/Runtime")
            let second = root.appendingPathComponent("Two.app/Contents/Resources/Runtime")
            for (runtime, names) in [(first, ["alpha", "beta"]), (second, ["beta", "alpha"])] {
                try directory(runtime)
                try directory(runtime.appendingPathComponent("scripts"))
                for name in names { try write("contents:\(name)\n", to: runtime.appendingPathComponent("scripts/\(name).mjs")) }
            }
            let digest = try RuntimeResourceFiles.digest(in: first)
            XCTAssertEqual(digest.count, 64)
            XCTAssertEqual(digest, try RuntimeResourceFiles.digest(in: second))
            XCTAssertEqual(digest, try RuntimeResourceFiles.digest(in: first))
        }
    }

    func testDigestChangesForContentRelativeNameAndMode() throws {
        try withDirectory { root in
            let file = root.appendingPathComponent("script.mjs")
            try write("first", to: file)
            let original = try RuntimeResourceFiles.digest(in: root)
            try write("other", to: file)
            let changedContents = try RuntimeResourceFiles.digest(in: root)
            XCTAssertNotEqual(original, changedContents)
            let moved = root.appendingPathComponent("renamed.mjs")
            try FileManager.default.moveItem(at: file, to: moved)
            let changedName = try RuntimeResourceFiles.digest(in: root)
            XCTAssertNotEqual(changedContents, changedName)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: moved.path)
            let changedMode = try RuntimeResourceFiles.digest(in: root)
            XCTAssertNotEqual(changedName, changedMode)
            try directory(root.appendingPathComponent("empty-directory"))
            XCTAssertNotEqual(changedMode, try RuntimeResourceFiles.digest(in: root))
        }
    }

    func testDigestRejectsFileDirectoryAndRootSymlinks() throws {
        try withDirectory { root in
            let runtime = root.appendingPathComponent("Runtime")
            let sibling = root.appendingPathComponent("Other")
            try directory(runtime); try directory(sibling)
            try write("module", to: sibling.appendingPathComponent("source.mjs"))
            for target in [sibling, sibling.appendingPathComponent("source.mjs")] {
                let alias = runtime.appendingPathComponent("substitute")
                try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: target)
                XCTAssertThrowsError(try RuntimeResourceFiles.digest(in: runtime))
                try FileManager.default.removeItem(at: alias)
            }
            let linkedRoot = root.appendingPathComponent("LinkedRuntime")
            try FileManager.default.createSymbolicLink(at: linkedRoot, withDestinationURL: runtime)
            XCTAssertThrowsError(try RuntimeResourceFiles.digest(in: linkedRoot))
        }
    }

    func testDigestRejectsNonregularNodeWithoutReadingIt() throws {
        try withDirectory { root in
            let fifo = root.appendingPathComponent("pipe")
            XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
            XCTAssertThrowsError(try RuntimeResourceFiles.digest(in: root))
        }
    }

    func testFileCountIsBoundedAnd512FilesAreAllowed() throws {
        try withDirectory { root in
            for index in 0..<RuntimeResourceFiles.maximumFiles {
                try write("", to: root.appendingPathComponent("file-\(index)"))
            }
            XCTAssertEqual(try RuntimeResourceFiles.digest(in: root).count, 64)
            try write("", to: root.appendingPathComponent("one-too-many"))
            XCTAssertThrowsError(try RuntimeResourceFiles.digest(in: root))
        }
    }

    func testTotalBytesBoundRejectsCombinedSparseFiles() throws {
        try withDirectory { root in
            for name in ["a", "b"] {
                let file = root.appendingPathComponent(name)
                try Data().write(to: file)
                let handle = try FileHandle(forWritingTo: file)
                try handle.truncate(atOffset: RuntimeResourceFiles.maximumBytes / 2 + 1)
                try handle.close()
            }
            XCTAssertThrowsError(try RuntimeResourceFiles.digest(in: root))
        }
    }

    func testOversizedFileAndExcessiveDepthAreRejected() throws {
        try withDirectory { root in
            let oversized = root.appendingPathComponent("large")
            try Data().write(to: oversized)
            let handle = try FileHandle(forWritingTo: oversized)
            try handle.truncate(atOffset: RuntimeResourceFiles.maximumBytes + 1)
            try handle.close()
            XCTAssertThrowsError(try RuntimeResourceFiles.digest(in: root))
            try FileManager.default.removeItem(at: oversized)
            var nested = root
            for _ in 0..<65 { nested.appendPathComponent("d") }
            try directory(nested)
            XCTAssertThrowsError(try RuntimeResourceFiles.digest(in: root))
        }
    }

    func testBrokerResolvesOnlyFixedNamesInsidePackagedRuntime() throws {
        try withDirectory { root in
            let resources = root.appendingPathComponent("Owned.app/Contents/Resources")
            try directory(resources.appendingPathComponent("Runtime/scripts"))
            for name in ["dock-fixture-session.mjs", "dock-chatgpt-session.mjs", "dock-catalog-session.mjs", "dock-claude-session.mjs"] {
                let file = resources.appendingPathComponent("Runtime/scripts/\(name)")
                try write("// packaged broker", to: file)
                XCTAssertEqual(try RuntimeResourceFiles.brokerURL(in: resources, filename: name).path, file.path)
            }
            for name in ["../dock-catalog-session.mjs", "/tmp/dock-catalog-session.mjs", "arbitrary.mjs", "scripts/dock-catalog-session.mjs"] {
                XCTAssertThrowsError(try RuntimeResourceFiles.brokerURL(in: resources, filename: name))
            }
        }
    }

    func testBrokerRejectsSymlinkAndDoesNotFallbackToSourceTree() throws {
        try withDirectory { root in
            let resources = root.appendingPathComponent("Owned.app/Contents/Resources")
            try directory(resources.appendingPathComponent("Runtime/scripts"))
            let outside = root.appendingPathComponent("Documents/scripts")
            try directory(outside)
            let source = outside.appendingPathComponent("dock-catalog-session.mjs")
            try write("// source copy", to: source)
            XCTAssertThrowsError(try RuntimeResourceFiles.brokerURL(in: resources, filename: "dock-catalog-session.mjs"))
            let packaged = resources.appendingPathComponent("Runtime/scripts/dock-catalog-session.mjs")
            try FileManager.default.createSymbolicLink(at: packaged, withDestinationURL: source)
            XCTAssertThrowsError(try RuntimeResourceFiles.brokerURL(in: resources, filename: "dock-catalog-session.mjs"))
        }
    }

    func testNativeExecutableUsesOnlyAllowlistedNamesAndSurvivesRelocation() throws {
        try withDirectory { root in
            let bundle = root.appendingPathComponent("First Location/Owned.app")
            let resources = bundle.appendingPathComponent("Contents/Resources")
            try directory(resources.appendingPathComponent("Runtime/native"))
            let names = ["node", "ProcessIdentity", "CatalogAppLaunch"]
            for name in names {
                let file = resources.appendingPathComponent("Runtime/native/\(name)")
                try write("owned executable fixture", to: file)
                try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
                XCTAssertEqual(try RuntimeResourceFiles.nativeExecutable(in: resources, filename: name), file)
            }
            for name in ["", "Node", "../node", "/usr/bin/node", "native/node", "arbitrary"] {
                XCTAssertThrowsError(try RuntimeResourceFiles.nativeExecutable(in: resources, filename: name))
            }
            let moved = root.appendingPathComponent("Moved + café.app")
            try FileManager.default.moveItem(at: bundle, to: moved)
            for name in names {
                let relocated = moved.appendingPathComponent("Contents/Resources")
                XCTAssertEqual(try RuntimeResourceFiles.nativeExecutable(in: relocated, filename: name),
                    relocated.appendingPathComponent("Runtime/native/\(name)"))
                XCTAssertThrowsError(try RuntimeResourceFiles.nativeExecutable(in: resources, filename: name))
            }
        }
    }

    func testNativeExecutableRejectsNonExecutableEmptyDirectoryAndPipe() throws {
        try withDirectory { root in
            let resources = root.appendingPathComponent("Owned.app/Contents/Resources")
            try directory(resources.appendingPathComponent("Runtime/native"))
            let file = resources.appendingPathComponent("Runtime/native/node")
            try write("not executable", to: file)
            XCTAssertThrowsError(try RuntimeResourceFiles.nativeExecutable(in: resources, filename: "node"))
            try write("", to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
            XCTAssertThrowsError(try RuntimeResourceFiles.nativeExecutable(in: resources, filename: "node"))
            try FileManager.default.removeItem(at: file)
            try directory(file)
            XCTAssertThrowsError(try RuntimeResourceFiles.nativeExecutable(in: resources, filename: "node"))
            try FileManager.default.removeItem(at: file)
            XCTAssertEqual(mkfifo(file.path, 0o755), 0)
            XCTAssertThrowsError(try RuntimeResourceFiles.nativeExecutable(in: resources, filename: "node"))
        }
    }

    func testNativeExecutableRejectsLeafAndEveryLinkedParent() throws {
        for relative in ["Runtime/native/node", "Runtime/native", "Runtime", ""] {
            try withDirectory { root in
                let resources = root.appendingPathComponent("Owned.app/Contents/Resources")
                try directory(resources.appendingPathComponent("Runtime/native"))
                let node = resources.appendingPathComponent("Runtime/native/node")
                try write("owned fixture", to: node)
                try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
                let replaced = relative.isEmpty ? resources : resources.appendingPathComponent(relative)
                let moved = root.appendingPathComponent("actual")
                try FileManager.default.moveItem(at: replaced, to: moved)
                try FileManager.default.createSymbolicLink(at: replaced, withDestinationURL: moved)
                XCTAssertThrowsError(try RuntimeResourceFiles.nativeExecutable(in: resources, filename: "node"), relative)
            }
        }
    }

    func testNativeExecutableRejectsOversizeAndNonFileResources() throws {
        try withDirectory { root in
            let resources = root.appendingPathComponent("Resources")
            try directory(resources.appendingPathComponent("Runtime/native"))
            let file = resources.appendingPathComponent("Runtime/native/node")
            try write("fixture", to: file)
            let handle = try FileHandle(forWritingTo: file)
            try handle.truncate(atOffset: RuntimeResourceFiles.maximumBytes + 1)
            try handle.close()
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
            XCTAssertThrowsError(try RuntimeResourceFiles.nativeExecutable(in: resources, filename: "node"))
            XCTAssertThrowsError(try RuntimeResourceFiles.nativeExecutable(in: URL(string: "https://example.invalid/Resources")!, filename: "node"))
        }
    }
}
