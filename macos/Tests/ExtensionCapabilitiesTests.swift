import Foundation
import RuntimeCatalog
import XCTest
@testable import ExtensionsAnywhere

final class ExtensionCapabilitiesTests: XCTestCase {
    private let app = InstalledApp(id: "/Applications/Style Lab.app", name: "Style Lab",
        bundleIdentifier: "dev.extensionsanywhere.stylelab", url: URL(fileURLWithPath: "/Applications/Style Lab.app"))

    private func record(_ text: String, type: ExtensionSourceType = .css, enabled: Bool = false) -> ExtensionRecord {
        ExtensionRecord(id: UUID(), appKey: "dev.extensionsanywhere.stylelab", name: "Example", description: "Example",
            sourceFileName: "source.\(type.rawValue)", sourceType: type, sourceText: text, isEnabled: enabled, createdAt: Date())
    }

    func testEnabledAggregateAndUTF8LimitsUseLauncherValidation() {
        let full = record(String(repeating: "a", count: 64 * 1024), enabled: true)
        XCTAssertNil(ExtensionCapabilities.enablementIssue(for: full, app: app, records: [full]))
        let added = record("b")
        XCTAssertEqual(ExtensionCapabilities.enablementIssue(for: added, app: app, records: [full]), ElectronLaunchError.cssTooLarge.localizedDescription)
        let unicode = record(String(repeating: "🟢", count: 16 * 1024 + 1))
        XCTAssertEqual(ExtensionCapabilities.enablementIssue(for: unicode, app: app, records: []), ElectronLaunchError.cssTooLarge.localizedDescription)
    }

    func testBuiltInMixedProfilesAllowOnlyTheirOwnJavaScriptRecords() {
        let script = record("console.log('example')", type: .js)
        let css = record("button { color: green; }")
        XCTAssertNil(ExtensionCapabilities.enablementIssue(for: css, app: app, records: [script]))
        XCTAssertNil(ExtensionCapabilities.enablementIssue(for: script, app: app, records: [css]))
        XCTAssertTrue(ExtensionCapabilities.authoringSummary(for: app).contains("renderer JavaScript"))
        let chatgpt = InstalledApp(id: ElectronLaunchProfile.chatgptURL.path, name: "ChatGPT",
            bundleIdentifier: ElectronLaunchProfile.chatgptKey, url: ElectronLaunchProfile.chatgptURL)
        let vendorScript = ExtensionRecord(id: UUID(), appKey: ElectronLaunchProfile.chatgptKey,
            name: "JS", description: "Stored", sourceFileName: "main.js", sourceType: .js,
            sourceText: "console.log(1)", isEnabled: false, createdAt: Date())
        XCTAssertNil(ExtensionCapabilities.enablementIssue(for: vendorScript, app: chatgpt, records: []))
        XCTAssertNotNil(ExtensionCapabilities.enablementIssue(for: script, app: chatgpt, records: []))
    }

    func testNestedMixedManifestCandidateUsesTheSameLegacyBasenameAsImport() {
        let package = ImportedExtensionPackage(manifest: .init(name: "Nested", description: "Mixed", version: "1",
            css: ["styles/main.css"], js: ["scripts/main.js"]), sources: [
                .init(fileName: "styles/main.css", type: .css, text: "button {}"),
                .init(fileName: "scripts/main.js", type: .js, text: "console.log(1)")
            ], manifestFileName: "manifest.json")
        XCTAssertNil(ExtensionCapabilities.importIssue(for: package, app: app, records: []))
    }

    func testConfiguredVendorImporterAndEnablementWithoutEnablingOtherVendors() throws {
        let package = ImportedExtensionPackage(manifest: .init(name: "Nested", description: "Mixed", version: "1",
            css: ["styles/main.css"], js: ["scripts/main.js"]), sources: [
                .init(fileName: "styles/main.css", type: .css, text: "button {}"),
                .init(fileName: "scripts/main.js", type: .js, text: "console.log(1)")
            ], manifestFileName: "manifest.json")
        for entry in RuntimeAppCatalog.entries {
            let app = InstalledApp(id: entry.bundlePath, name: entry.name, bundleIdentifier: entry.bundleIdentifier,
                url: URL(fileURLWithPath: entry.bundlePath))
            let script = ExtensionRecord(id: UUID(), appKey: entry.bundleIdentifier, name: "JS", description: "Example",
                sourceFileName: "main.js", sourceType: .js, sourceText: "console.log(1)", isEnabled: false, createdAt: Date())
            if entry.rendererRuntime != nil {
                XCTAssertNil(ExtensionCapabilities.importIssue(for: package, app: app, records: []))
                XCTAssertNil(ExtensionCapabilities.enablementIssue(for: script, app: app, records: []))
                XCTAssertTrue(ExtensionCapabilities.authoringSummary(for: app).contains("renderer JavaScript runtime is configured"))
                if entry.slug == "figma" {
                    XCTAssertTrue(ExtensionCapabilities.authoringSummary(for: app).contains("HTTPS pages on www.figma.com, including signed-in routes"))
                    XCTAssertTrue(ExtensionCapabilities.authoringSummary(for: app).contains("verification covers the login page only"))
                    XCTAssertTrue(ExtensionCapabilities.authoringSummary(for: app).contains("files browser and editor have not been verified"))
                }
            } else {
                XCTAssertNotNil(ExtensionCapabilities.importIssue(for: package, app: app, records: []), entry.slug)
                XCTAssertNotNil(ExtensionCapabilities.enablementIssue(for: script, app: app, records: []), entry.slug)
            }
        }
    }

    func testMovedAppIsStorageOnlyEvenWithRecognizedIdentifier() {
        let moved = InstalledApp(id: "/Users/example/Style Lab.app", name: app.name, bundleIdentifier: app.bundleIdentifier,
            url: URL(fileURLWithPath: "/Users/example/Style Lab.app"))
        XCTAssertTrue(ExtensionCapabilities.authoringSummary(for: moved).contains("No extension runtime"))
        XCTAssertNotNil(ExtensionCapabilities.enablementIssue(for: record("button {}"), app: moved, records: []))
    }

    func testCatalogAuthoringUsesCurrentProfileWithoutClaimingVerification() throws {
        let entry = try XCTUnwrap(RuntimeAppCatalog.entries.first { $0.slug == "discord" })
        let target = InstalledApp(id: entry.bundlePath, name: entry.name, bundleIdentifier: entry.bundleIdentifier,
            url: URL(fileURLWithPath: entry.bundlePath))
        let instructions = ExtensionAuthoringInstructions.text(app: target, brief: "Style one button", projectFolder: nil)
        XCTAssertTrue(instructions.contains("renderer JavaScript runtime is configured"))
        XCTAssertTrue(instructions.contains("all enabled extensions"))
        XCTAssertTrue(instructions.contains("not evidence of compatibility"))
        XCTAssertFalse(instructions.contains("current Dock runtime supports CSS in Style Lab"))
    }

    func testTrustNoticeDistinguishesRealTransportAndDisabledRuntimeLifetime() throws {
        for entry in RuntimeAppCatalog.entries {
            let target = InstalledApp(id: entry.bundlePath, name: entry.name, bundleIdentifier: entry.bundleIdentifier,
                url: URL(fileURLWithPath: entry.bundlePath))
            let notice = try XCTUnwrap(ExtensionCapabilities.runtimeTrustNotice(for: target))
            XCTAssertTrue(notice.contains("Scripts can read and change"), entry.slug)
            XCTAssertTrue(notice.contains("Quit command to end the session"), entry.slug)
            if entry.transport == "pipe" {
                XCTAssertTrue(notice.contains("Disabling extensions keeps it connected"), entry.slug)
                XCTAssertTrue(notice.contains("quitting the launcher may also quit"), entry.slug)
                XCTAssertFalse(notice.contains("local debugging port"), entry.slug)
            } else {
                XCTAssertTrue(notice.contains("accessible to other local software"), entry.slug)
                XCTAssertTrue(notice.contains("Disabling extensions does not close the port"), entry.slug)
            }
        }
        let chatgpt = InstalledApp(id: ElectronLaunchProfile.chatgptURL.path, name: "ChatGPT",
            bundleIdentifier: ElectronLaunchProfile.chatgptKey, url: ElectronLaunchProfile.chatgptURL)
        XCTAssertTrue(try XCTUnwrap(ExtensionCapabilities.runtimeTrustNotice(for: chatgpt)).contains("local debugging port"))
        XCTAssertTrue(try XCTUnwrap(ExtensionCapabilities.runtimeTrustNotice(for: app)).contains("local debugging port"))
        let moved = InstalledApp(id: "/Users/example/Style Lab.app", name: app.name, bundleIdentifier: app.bundleIdentifier,
            url: URL(fileURLWithPath: "/Users/example/Style Lab.app"))
        XCTAssertNil(ExtensionCapabilities.runtimeTrustNotice(for: moved))
    }
}
