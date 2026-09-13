import Foundation
import RuntimeCatalog
import XCTest
@testable import ExtensionsAnywhere

final class AuthoringInstructionsTests: XCTestCase {
    func testCompleteInstructionsFitAgentLinksWithoutLosingResearchContext() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Extension + café \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = URL(fileURLWithPath: "/Applications/ChatGPT.app")
        let app = InstalledApp(id: url.path, name: "ChatGPT", bundleIdentifier: "com.openai.codex", url: url)
        let prompt = ExtensionAuthoringInstructions.text(app: app,
            brief: "Hide the sidebar voice button while preserving navigation and keyboard focus.", projectFolder: folder)
        for kind in CodingToolKind.allCases where kind.supportsPrefilledTask {
            let tool = InstalledCodingTool(kind: kind, name: kind.name,
                appURL: URL(fileURLWithPath: "/Applications/Example.app"), bundleIdentifier: kind.bundleIdentifier)
            let link = try tool.taskURL(prompt: prompt, workingDirectory: folder)
            let components = try XCTUnwrap(URLComponents(url: link, resolvingAgainstBaseURL: false))
            let promptKey = kind == .codex ? "prompt" : kind == .claude ? "q" : "text"
            XCTAssertEqual(components.queryItems?.first(where: { $0.name == promptKey })?.value, prompt)
        }
    }

    func testDisplayedManifestExampleImportsSuccessfully() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let manifest = folder.appendingPathComponent("manifest.json")
        try Data(ExtensionAuthoringInstructions.manifestExample.utf8).write(to: manifest)
        try Data("button { color: green; }".utf8).write(to: folder.appendingPathComponent("styles.css"))
        let package = try ImportedExtensionPackage.load(from: manifest)
        XCTAssertEqual(package.sources.count, 1)
        XCTAssertEqual(package.sources.first?.type, .css)
        XCTAssertEqual(package.manifest.manifest_version, 1)
    }

    func testOwnedStyleLabScriptExampleImportsBothSourcesInManifestOrder() throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let manifest = repository.appendingPathComponent("examples/stylelab-script-button/manifest.json")
        let package = try ImportedExtensionPackage.load(from: manifest)
        XCTAssertEqual(package.manifest.manifest_version, 1)
        XCTAssertEqual(package.manifest.name, "Style Lab script button")
        XCTAssertEqual(package.manifest.version, "1.0.0")
        XCTAssertFalse(package.manifest.description.isEmpty)
        XCTAssertEqual(package.sources.map(\.fileName), ["styles.css", "main.js"])
        XCTAssertEqual(package.sources.map(\.type), [.css, .js])
        XCTAssertTrue(package.sources.allSatisfy { !$0.text.isEmpty })
    }

    func testStyleLabPromptDescribesItsExactScriptContractWithoutGrantingItToMovedApps() {
        let installed = InstalledApp(id: ElectronLaunchProfile.fixtureURL.path, name: "Style Lab",
            bundleIdentifier: ElectronLaunchProfile.fixtureKey, url: ElectronLaunchProfile.fixtureURL)
        let text = ExtensionAuthoringInstructions.text(app: installed, brief: "Add a logging button", projectFolder: nil)
        XCTAssertTrue(text.contains("authored JS receives lexical ea and console arguments"))
        XCTAssertTrue(text.contains("ea.signal"))
        XCTAssertTrue(text.contains("ea.onDispose(callback)"))
        XCTAssertTrue(text.contains("256 KiB"))
        XCTAssertFalse(text.contains("JavaScript execution is unavailable for this selected target"))
        XCTAssertTrue(text.contains("Do not modify, patch, re-sign, launch, or attach"))
        let moved = InstalledApp(id: "/Users/example/Style Lab.app", name: installed.name,
            bundleIdentifier: installed.bundleIdentifier, url: URL(fileURLWithPath: "/Users/example/Style Lab.app"))
        let movedText = ExtensionAuthoringInstructions.text(app: moved, brief: "Add a logging button", projectFolder: nil)
        XCTAssertTrue(movedText.contains("JavaScript execution is unavailable for this selected target"))
        XCTAssertFalse(movedText.contains("authored JS receives lexical ea and console arguments"))
    }

    func testConfiguredCatalogPromptsFollowSelectedPolicyAndDoNotClaimVerification() {
        for definition in RuntimeAppCatalog.entries where
            RuntimeExtensionSelection.catalogPolicy(for: definition) != .cssOnly {
            let url = URL(fileURLWithPath: definition.bundlePath)
            let app = InstalledApp(id: url.path, name: definition.name,
                bundleIdentifier: definition.bundleIdentifier, url: url)
            let prompt = ExtensionAuthoringInstructions.text(app: app, brief: "Add a button", projectFolder: nil)
            XCTAssertTrue(prompt.contains("authored JS receives lexical ea and console arguments"), definition.slug)
            XCTAssertTrue(prompt.contains("A configured profile is not evidence of compatibility"), definition.slug)
            XCTAssertFalse(prompt.contains("Only the exact configured Style Lab and Visual Studio Code"), definition.slug)
            XCTAssertFalse(prompt.contains("Other configured runtimes currently accept CSS only"), definition.slug)
            XCTAssertTrue(ExtensionAuthoringInstructions.sourceSummary(app: app).contains("List CSS and JavaScript files"))
            if definition.bundleIdentifier == RuntimeExtensionSelection.figmaIdentifier {
                XCTAssertTrue(prompt.contains("HTTPS pages on www.figma.com, including signed-in routes"))
                XCTAssertTrue(prompt.contains("verification covers the login page only"))
                XCTAssertTrue(prompt.contains("files browser and editor have not been verified"))
            }
        }
    }

    func testChatGPTPromptDistinguishesConfiguredJavaScriptFromInstalledVerification() {
        let url = URL(fileURLWithPath: "/Applications/ChatGPT.app")
        let app = InstalledApp(id: url.path, name: "ChatGPT", bundleIdentifier: "com.openai.codex", url: url)
        let prompt = ExtensionAuthoringInstructions.text(app: app, brief: "Add a button", projectFolder: nil)
        XCTAssertTrue(prompt.contains("authored JS receives lexical ea and console arguments"))
        XCTAssertTrue(prompt.contains("JavaScript behavior has not been verified in this installed app"))
        XCTAssertTrue(ExtensionAuthoringInstructions.sourceSummary(app: app).contains("List CSS and JavaScript files"))
        XCTAssertTrue(ExtensionAuthoringInstructions.sourceSummary(app: nil).contains("Choose an app"))
        let moved = InstalledApp(id: "/Users/example/ChatGPT.app", name: "ChatGPT",
            bundleIdentifier: app.bundleIdentifier, url: URL(fileURLWithPath: "/Users/example/ChatGPT.app"))
        XCTAssertTrue(ExtensionAuthoringInstructions.sourceSummary(app: moved).contains("no configured CSS or JavaScript runtime"))
    }
}
