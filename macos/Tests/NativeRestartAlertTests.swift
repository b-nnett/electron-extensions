import AppKit
import RuntimeCatalog
import XCTest

@MainActor
final class NativeRestartAlertTests: XCTestCase {
    func testAllEntryPointsUseNativeRestartAndCancelActions() {
        for context: NativeRestartAlert.Context in [.missingExtensions, .alreadyRunning, .runtimeUpgrade] {
            let alert = NativeRestartAlert.make(appName: "Example", context: context)
            XCTAssertEqual(alert.alertStyle, .informational)
            XCTAssertEqual(alert.buttons.map(\.title), ["Restart", "Not Now"])
            XCTAssertEqual(alert.buttons.map(\.keyEquivalent), ["\r", "\u{1b}"])
            XCTAssertNil(alert.accessoryView)
            XCTAssertTrue(alert.informativeText.contains("quit normally"))
        }
    }

    func testRuntimeUpgradeExplainsThatNotNowKeepsCurrentExtensions() {
        let alert = NativeRestartAlert.make(appName: "Example", context: .runtimeUpgrade)
        XCTAssertEqual(alert.messageText, "Restart Example to enable this extension?")
        XCTAssertTrue(alert.informativeText.contains("Not Now keeps your current extensions unchanged"))
    }

    func testAssistedRestartExplainsRequiredSetupWithoutClaimingUnattendedConnection() throws {
        let claude = try XCTUnwrap(RuntimeRestartTarget(profile: "claude"))
        XCTAssertFalse(claude.requiresColdStart)
        XCTAssertTrue(try XCTUnwrap(RuntimeRestartTarget(profile: "chatgpt")).requiresColdStart)
        for context: NativeRestartAlert.Context in [.missingExtensions, .runtimeUpgrade] {
            let alert = NativeRestartAlert.make(appName: "Claude", context: context,
                assistedSetupInstructions: claude.assistedSetupInstructions)
            XCTAssertTrue(alert.informativeText.contains("Enable Main Process Debugger after each launch"))
            XCTAssertTrue(alert.informativeText.contains("Extensions connect after that setup"))
            XCTAssertFalse(alert.informativeText.contains("reopen with your enabled extensions"))
            XCTAssertEqual(alert.buttons.map(\.title), ["Restart", "Not Now"])
            XCTAssertNil(alert.accessoryView)
        }
    }
}
