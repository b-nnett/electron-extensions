import Foundation
import XCTest
@testable import ExtensionsAnywhere

@MainActor
final class AuthoringDraftTests: XCTestCase {
    private func withStorage(_ body: (URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("AuthoringDraftTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root.appendingPathComponent("draft.json"))
    }

    func testDraftSurvivesRelaunchWithTargetFolderAndOpenRoute() throws {
        try withStorage { file in
            let draft = ExtensionAuthoringDraft(storageURL: file)
            XCTAssertNil(draft.persistenceError)
            let appURL = URL(fileURLWithPath: "/Applications/ChatGPT.app")
            let app = InstalledApp(id: appURL.path, name: "ChatGPT", bundleIdentifier: "com.openai.codex", url: appURL)
            draft.brief = "Keep focus visible.\nUse café colours 🟢"
            draft.projectFolder = file.deletingLastPathComponent().appendingPathComponent("My extension + café")
            draft.targetApp = app
            draft.wasOpen = true
            let restored = ExtensionAuthoringDraft(storageURL: file)
            XCTAssertEqual(restored.brief, draft.brief)
            XCTAssertEqual(restored.projectFolder, draft.projectFolder)
            XCTAssertEqual(restored.targetApp, app)
            XCTAssertTrue(restored.wasOpen)
            XCTAssertNil(restored.persistenceError)
            XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        }
    }

    func testLeavingCreatorRetainsDraftWithoutReopeningIt() throws {
        try withStorage { file in
            let draft = ExtensionAuthoringDraft(storageURL: file)
            draft.brief = "An unfinished idea"
            draft.wasOpen = true
            draft.wasOpen = false
            let restored = ExtensionAuthoringDraft(storageURL: file)
            XCTAssertEqual(restored.brief, "An unfinished idea")
            XCTAssertFalse(restored.wasOpen)
        }
    }

    func testMalformedOrOversizeStoredDraftIsNotOverwritten() throws {
        for data in [Data("{broken".utf8), Data(repeating: 32, count: 256 * 1024 + 1)] {
            try withStorage { file in
                try data.write(to: file)
                let draft = ExtensionAuthoringDraft(storageURL: file)
                XCTAssertNotNil(draft.persistenceError)
                draft.brief = "A new idea to copy manually"
                draft.wasOpen = true
                XCTAssertEqual(try Data(contentsOf: file), data)
            }
        }
    }

    func testOversizeUTF8BriefPreservesLastSaveAndCanRecover() throws {
        try withStorage { file in
            let draft = ExtensionAuthoringDraft(storageURL: file)
            draft.brief = "Previously saved"
            let previous = try Data(contentsOf: file)
            draft.brief = String(repeating: "🟢", count: ExtensionAuthoringDraft.maximumBriefBytes / 4 + 1)
            XCTAssertNotNil(draft.persistenceError)
            XCTAssertEqual(try Data(contentsOf: file), previous)
            draft.brief = "Shortened"
            XCTAssertNil(draft.persistenceError)
            XCTAssertEqual(ExtensionAuthoringDraft(storageURL: file).brief, "Shortened")
        }
    }

    func testWriteFailureIsVisibleAndLeavesCurrentDraftInMemory() throws {
        try withStorage { file in
            let folder = file.deletingLastPathComponent().appendingPathComponent("blocked")
            let storage = folder.appendingPathComponent("draft.json")
            let draft = ExtensionAuthoringDraft(storageURL: storage)
            try Data("not a directory".utf8).write(to: folder)
            draft.brief = "Do not lose this work"
            XCTAssertEqual(draft.brief, "Do not lose this work")
            XCTAssertNotNil(draft.persistenceError)
            try FileManager.default.removeItem(at: folder)
            draft.wasOpen = true
            XCTAssertNil(draft.persistenceError)
            XCTAssertEqual(ExtensionAuthoringDraft(storageURL: storage).brief, draft.brief)
        }
    }
}
