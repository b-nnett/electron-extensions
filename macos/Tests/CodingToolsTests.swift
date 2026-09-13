import Foundation
import XCTest
@testable import ExtensionsAnywhere

final class CodingToolsTests: XCTestCase {
    private func withDirectory(_ body: (URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ExtensionsAnywhere-CodingToolsTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try body(directory)
    }

    private func tool(_ kind: CodingToolKind) -> InstalledCodingTool {
        InstalledCodingTool(
            kind: kind, name: kind.name,
            appURL: URL(fileURLWithPath: "/Applications/Example.app"),
            bundleIdentifier: kind.bundleIdentifier
        )
    }

    private func query(_ url: URL) throws -> [String: String] {
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        return Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    }

    func testDocumentedDraftRoutesPreservePromptAndFolderAsData() throws {
        try withDirectory { root in
            let folder = root.appendingPathComponent("Project + café & tools")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let prompt = "Add A+B & C=D? #notes 100% \"quoted\"\n日本語 👩🏽‍💻"
            let codex = try tool(.codex).taskURL(prompt: prompt, workingDirectory: folder)
            XCTAssertEqual(codex.scheme, "codex")
            XCTAssertEqual(codex.host, "threads")
            XCTAssertEqual(codex.path, "/new")
            XCTAssertEqual(try query(codex), ["prompt": prompt, "path": folder.path])

            let claude = try tool(.claude).taskURL(prompt: prompt, workingDirectory: folder)
            XCTAssertEqual(claude.scheme, "claude")
            XCTAssertEqual(claude.host, "code")
            XCTAssertEqual(claude.path, "/new")
            XCTAssertEqual(try query(claude), ["q": prompt, "folder": folder.path])

            let cursor = try tool(.cursor).taskURL(prompt: prompt, workingDirectory: folder)
            XCTAssertEqual(cursor.scheme, "cursor")
            XCTAssertEqual(cursor.host, "anysphere.cursor-deeplink")
            XCTAssertEqual(cursor.path, "/prompt")
            XCTAssertEqual(try query(cursor), ["text": prompt])
            XCTAssertFalse(tool(.cursor).supportsWorkingDirectory)

            for url in [codex, claude, cursor] {
                XCTAssertNil(url.fragment)
                XCTAssertFalse(url.absoluteString.contains("+"))
                XCTAssertTrue(url.absoluteString.contains("%2B"))
            }
            for kind in CodingToolKind.allCases where kind.supportsPrefilledTask {
                XCTAssertEqual(kind.launchBehavior, .opensDraft)
                XCTAssertFalse(kind.automaticallySubmits)
            }
        }
    }

    func testCursorLimitsEncodedURLLengthWithoutTruncating() throws {
        let cursor = tool(.cursor)
        let prefixLength = try cursor.taskURL(prompt: "x").absoluteString.utf8.count - 1
        let maximumPrompt = String(repeating: "x", count: 8_000 - prefixLength)
        XCTAssertEqual(try cursor.taskURL(prompt: maximumPrompt).absoluteString.utf8.count, 8_000)
        XCTAssertThrowsError(try cursor.taskURL(prompt: maximumPrompt + "x")) { error in
            XCTAssertEqual(error as? CodingToolError, .urlTooLong(tool: cursor.name, limit: 8_000))
        }
        XCTAssertThrowsError(try cursor.taskURL(prompt: String(repeating: "🟢", count: 700)))
    }

    func testClaudeRejectsPromptBeyondDocumentedTruncationThreshold() throws {
        XCTAssertNoThrow(try tool(.claude).taskURL(prompt: String(repeating: "x", count: 14_000)))
        XCTAssertThrowsError(try tool(.claude).taskURL(prompt: String(repeating: "x", count: 14_001))) { error in
            XCTAssertEqual(error as? CodingToolError, .promptTooLong(tool: self.tool(.claude).name, limit: 14_000))
        }
    }

    func testDraftInputRejectsEmptyPromptAndNonlocalOrMissingFolder() throws {
        XCTAssertThrowsError(try tool(.codex).taskURL(prompt: " \n\t")) { error in
            XCTAssertEqual(error as? CodingToolError, .emptyPrompt)
        }
        XCTAssertThrowsError(try tool(.claude).taskURL(
            prompt: "Build", workingDirectory: URL(string: "https://example.com/project")!
        ))
        XCTAssertThrowsError(try tool(.codex).taskURL(
            prompt: "Build", workingDirectory: URL(string: "file://another-machine/project")!
        ))
        try withDirectory { root in
            XCTAssertThrowsError(try tool(.codex).taskURL(prompt: "Build", workingDirectory: root.appendingPathComponent("Missing")))
            let file = root.appendingPathComponent("file.txt")
            try Data().write(to: file)
            XCTAssertThrowsError(try tool(.claude).taskURL(prompt: "Build", workingDirectory: file))
        }
    }

    func testVSCodeFallbackOpensOnlyFolderWithoutPromptParameters() throws {
        let vscode = tool(.visualStudioCode)
        XCTAssertEqual(vscode.launchBehavior, .opensProject)
        XCTAssertFalse(vscode.supportsPrefilledTask)
        XCTAssertThrowsError(try vscode.taskURL(prompt: "This must not run"))
        try withDirectory { folder in
            let url = try vscode.taskURL(prompt: "This must not run", workingDirectory: folder)
            XCTAssertEqual(url.scheme, "vscode")
            XCTAssertEqual(url.host, "file")
            XCTAssertEqual(url.path, folder.path)
            XCTAssertTrue(try query(url).isEmpty)
        }
    }

    @discardableResult
    private func makeApp(at url: URL, identifier: String, schemes: [String]) throws -> URL {
        let contents = url.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let plist: [String: Any] = [
            "CFBundleIdentifier": identifier,
            "CFBundlePackageType": "APPL",
            "CFBundleURLTypes": [["CFBundleURLSchemes": schemes]]
        ]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
        return url
    }

    func testDiscoveryRequiresKnownBundleAndSchemeAndSkipsHelpers() throws {
        try withDirectory { root in
            let codex = try makeApp(at: root.appendingPathComponent("ChatGPT.app"), identifier: CodingToolKind.codex.bundleIdentifier, schemes: ["codex"])
            try makeApp(at: root.appendingPathComponent("Tools/Claude.app"), identifier: CodingToolKind.claude.bundleIdentifier, schemes: ["claude"])
            try makeApp(at: root.appendingPathComponent("Cursor Renamed.app"), identifier: CodingToolKind.cursor.bundleIdentifier, schemes: ["cursor"])
            try makeApp(at: root.appendingPathComponent("VSCode.app"), identifier: CodingToolKind.visualStudioCode.bundleIdentifier, schemes: ["vscode"])
            try makeApp(at: root.appendingPathComponent("Cursor.app"), identifier: "test.unrelated", schemes: ["cursor"])
            try makeApp(at: root.appendingPathComponent("Missing Scheme.app"), identifier: CodingToolKind.cursor.bundleIdentifier, schemes: [])
            let other = try makeApp(at: root.appendingPathComponent("Other.app"), identifier: "test.other", schemes: [])
            try makeApp(at: other.appendingPathComponent("Contents/Claude.app"), identifier: CodingToolKind.claude.bundleIdentifier, schemes: ["claude"])
            try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("Codex Alias.app"), withDestinationURL: codex)

            let tools = try CodingToolDiscovery.scan(in: root)
            XCTAssertEqual(tools.count, 3)
            XCTAssertEqual(Set(tools.map(\.kind)), [.codex, .claude, .cursor])
            XCTAssertEqual(tools.first(where: { $0.kind == .codex })?.name, "ChatGPT (Codex)")
            XCTAssertEqual(try CodingToolDiscovery.scan(in: root, includeProjectOnly: true).count, 4)
            XCTAssertThrowsError(try CodingToolDiscovery.scan(in: root.appendingPathComponent("Missing")))
        }
    }
}
