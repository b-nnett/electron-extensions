import Foundation
import RuntimeCatalog
import XCTest
@testable import ExtensionsAnywhere

final class ElectronLaunchProfileTests: XCTestCase {
    func testProfilesRequireExactOwnedInstallation() {
        let fixture = InstalledApp(id: "/Applications/Style Lab.app", name: "Style Lab", bundleIdentifier: ElectronLaunchProfile.fixtureKey, url: ElectronLaunchProfile.fixtureURL)
        XCTAssertTrue(ElectronLaunchProfile.supports(fixture))
        XCTAssertFalse(ElectronLaunchProfile.supports(InstalledApp(id: "/tmp/Style Lab.app", name: fixture.name, bundleIdentifier: fixture.bundleIdentifier, url: URL(fileURLWithPath: "/tmp/Style Lab.app"))))
        XCTAssertFalse(ElectronLaunchProfile.supports(InstalledApp(id: fixture.id, name: fixture.name, bundleIdentifier: "different.app", url: fixture.url)))
    }

    func testChatGPTExperimentalProfileRequiresExactPathAndIdentifier() {
        let app = InstalledApp(id: ElectronLaunchProfile.chatgptURL.path, name: "ChatGPT",
                               bundleIdentifier: ElectronLaunchProfile.chatgptKey, url: ElectronLaunchProfile.chatgptURL)
        XCTAssertEqual(ElectronLaunchProfile.profile(for: app), .chatgpt)
        XCTAssertTrue(ElectronLaunchProfile.supports(app))
        XCTAssertFalse(ElectronLaunchProfile.supports(InstalledApp(id: app.id, name: app.name, bundleIdentifier: "test.impostor", url: app.url)))
        XCTAssertFalse(ElectronLaunchProfile.supports(InstalledApp(id: "/tmp/ChatGPT.app", name: app.name, bundleIdentifier: app.bundleIdentifier, url: URL(fileURLWithPath: "/tmp/ChatGPT.app"))))
        XCTAssertFalse(ElectronLaunchProfile.supports(InstalledApp(id: app.id, name: app.name, bundleIdentifier: app.bundleIdentifier, url: URL(string: "https://example.com/Applications/ChatGPT.app")!)))
        XCTAssertEqual(ElectronLaunchProfile.Profile.chatgpt.brokerEnvironmentKey, "chatgptBrokerPath")
        XCTAssertEqual(ElectronLaunchProfile.Profile.chatgpt.brokerFilename, "dock-chatgpt-session.mjs")
        XCTAssertEqual(ElectronLaunchProfile.Profile.chatgpt.launcherIdentifier, "dev.extensionsanywhere.launcher.chatgpt")
        XCTAssertEqual(ElectronLaunchProfile.Profile.stylelab.brokerEnvironmentKey, "brokerPath")
        XCTAssertEqual(ElectronLaunchProfile.Profile.stylelab.brokerFilename, "dock-fixture-session.mjs")
    }

    func testCombinedCSSLimitCountsUTF8AndSeparators() throws {
        let source = StoredExtensionSource(fileName: "styles.css", type: .css, text: String(repeating: "é", count: 32768))
        let record = makeRecord(sources: [source])
        XCTAssertNoThrow(try ElectronLaunchProfile.validate(records: [record]))
        XCTAssertThrowsError(try ElectronLaunchProfile.validate(records: [record, makeRecord(sources: [.init(fileName: "empty.css", type: .css, text: "")])]))
    }

    func testClaudeAssistedProfileRequiresExactIdentityAndMixedPolicy() throws {
        let app = InstalledApp(id: ElectronLaunchProfile.claudeURL.path, name: "Claude",
            bundleIdentifier: ElectronLaunchProfile.claudeKey, url: ElectronLaunchProfile.claudeURL)
        XCTAssertEqual(ElectronLaunchProfile.profile(for: app), .claude)
        XCTAssertEqual(ElectronLaunchProfile.Profile.claude.brokerFilename, "dock-claude-session.mjs")
        XCTAssertEqual(ElectronLaunchProfile.Profile.claude.launcherIdentifier, "dev.extensionsanywhere.launcher.claude")
        XCTAssertEqual(ElectronLaunchProfile.Profile.claude.sourcePolicy, .claudeMixed)
        let js = makeRecord(sources: [.init(fileName: "main.js", type: .js, text: "console.log(1)")], appKey: ElectronLaunchProfile.claudeKey)
        XCTAssertNoThrow(try ElectronLaunchProfile.validate(records: [js], app: app))
        XCTAssertThrowsError(try RuntimeExtensionSelection.select(records: [], targetIdentifier: ElectronLaunchProfile.chatgptKey, policy: .claudeMixed))
        XCTAssertEqual(try XCTUnwrap(RuntimeRestartTarget(profile: "claude")).executableURL.path,
            "/Applications/Claude.app/Contents/MacOS/Claude")
        for (path, identifier) in [("/tmp/Claude.app", ElectronLaunchProfile.claudeKey),
                                   ("/Applications/Claude.app", "com.example.other")] {
            let changed = InstalledApp(id: path, name: "Claude", bundleIdentifier: identifier, url: URL(fileURLWithPath: path))
            XCTAssertNil(ElectronLaunchProfile.profile(for: changed))
        }
        let prompt = ExtensionAuthoringInstructions.text(app: app, brief: "Add a logging button", projectFolder: nil)
        XCTAssertTrue(prompt.contains("authored JS receives lexical ea and console arguments"))
        XCTAssertTrue(prompt.contains("new-chat page only"))
        XCTAssertTrue(prompt.contains("after each launch"))
        XCTAssertTrue(prompt.contains("has not yet passed imported-JavaScript verification"))
        XCTAssertTrue(try XCTUnwrap(ExtensionCapabilities.runtimeTrustNotice(for: app)).contains("full app process"))
    }

    func testEnabledJavaScriptFailsBeforeLaunchWhileDisabledIsIgnored() throws {
        var record = makeRecord(sources: [.init(fileName: "main.js", type: .js, text: "console.log('example')")])
        XCTAssertThrowsError(try ElectronLaunchProfile.validate(records: [record]))
        record.isEnabled = false
        XCTAssertNoThrow(try ElectronLaunchProfile.validate(records: [record]))
    }

    func testChatGPTCSSValidationRejectsMixedOrInconsistentJavaScriptSources() throws {
        let css = StoredExtensionSource(fileName: "style.css", type: .css, text: "button { color: green; }")
        let valid = makeRecord(sources: [css], appKey: ElectronLaunchProfile.chatgptKey)
        XCTAssertNoThrow(try ElectronLaunchProfile.validate(records: [valid]))
        let mixed = makeRecord(sources: [css, .init(fileName: "behavior.js", type: .js, text: "not executed")],
                               appKey: ElectronLaunchProfile.chatgptKey)
        XCTAssertThrowsError(try ElectronLaunchProfile.validate(records: [mixed]))
        var inconsistent = makeRecord(sources: [css], appKey: ElectronLaunchProfile.chatgptKey, sourceType: .js)
        XCTAssertThrowsError(try ElectronLaunchProfile.validate(records: [inconsistent]))
        inconsistent.isEnabled = false
        XCTAssertNoThrow(try ElectronLaunchProfile.validate(records: [inconsistent]))
    }

    func testEmptyCSSCannotRequestDebugLaunch() {
        XCTAssertThrowsError(try ElectronLaunchProfile.validate(records: [makeRecord(sources: [.init(fileName: "empty.css", type: .css, text: " \n\t")])]))
        XCTAssertNoThrow(try ElectronLaunchProfile.validate(records: []))
    }

    func testOnlyExplicitOwnedFixtureAndConfiguredVendorProfilesPermitJS() throws {
        let js = StoredExtensionSource(fileName: "main.js", type: .js, text: "console.log(1)")
        let fixture = makeRecord(sources: [js])
        XCTAssertNoThrow(try ElectronLaunchProfile.validate(records: [fixture], for: .stylelab))
        XCTAssertThrowsError(try ElectronLaunchProfile.validate(records: [fixture]))
        let chatgpt = makeRecord(sources: [js], appKey: ElectronLaunchProfile.chatgptKey)
        XCTAssertNoThrow(try ElectronLaunchProfile.validate(records: [chatgpt], for: .chatgpt))
        for entry in RuntimeAppCatalog.entries {
            let vendor = makeRecord(sources: [js], appKey: entry.bundleIdentifier)
            if entry.rendererRuntime != nil {
                XCTAssertTrue(ElectronLaunchProfile.Profile.catalog(entry).supportsJavaScript)
                XCTAssertNoThrow(try ElectronLaunchProfile.validate(records: [vendor], for: .catalog(entry)))
                XCTAssertThrowsError(try ElectronLaunchProfile.validate(records: [vendor]))
            } else {
                XCTAssertFalse(ElectronLaunchProfile.Profile.catalog(entry).supportsJavaScript)
                XCTAssertThrowsError(try ElectronLaunchProfile.validate(records: [vendor], for: .catalog(entry)))
            }
        }
    }

    func testVSCodeJavaScriptRequiresSelectedExactAppPathAndIdentifier() throws {
        let entry = try XCTUnwrap(RuntimeAppCatalog.entries.first { $0.slug == "vscode" })
        let app = InstalledApp(id: entry.bundlePath, name: entry.name, bundleIdentifier: entry.bundleIdentifier,
            url: URL(fileURLWithPath: entry.bundlePath))
        let record = makeRecord(sources: [.init(fileName: "main.js", type: .js, text: "console.log(1)")], appKey: entry.bundleIdentifier)
        XCTAssertNoThrow(try ElectronLaunchProfile.validate(records: [record], app: app))
        let moved = InstalledApp(id: "/tmp/Visual Studio Code.app", name: app.name, bundleIdentifier: app.bundleIdentifier,
            url: URL(fileURLWithPath: "/tmp/Visual Studio Code.app"))
        XCTAssertNil(ElectronLaunchProfile.profile(for: moved))
        XCTAssertThrowsError(try ElectronLaunchProfile.validate(records: [record], app: moved))
        let different = InstalledApp(id: app.id, name: app.name, bundleIdentifier: "com.example.other", url: app.url)
        XCTAssertNil(ElectronLaunchProfile.profile(for: different))
        XCTAssertThrowsError(try ElectronLaunchProfile.validate(records: [record], app: different))
    }

    private func makeRecord(sources: [StoredExtensionSource], appKey: String = ElectronLaunchProfile.fixtureKey,
                            sourceType: ExtensionSourceType? = nil) -> ExtensionRecord {
        let first = sources[0]
        return ExtensionRecord(id: UUID(), appKey: appKey, name: "Test", description: "Test", sourceFileName: first.fileName, sourceType: sourceType ?? first.type, sourceText: first.text, isEnabled: true, createdAt: Date(), manifestVersion: "1.0.0", sourceFiles: sources)
    }
}
