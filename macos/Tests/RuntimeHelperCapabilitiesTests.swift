import Foundation
import RuntimeCatalog
import XCTest

final class RuntimeHelperCapabilitiesTests: XCTestCase {
    private func target(_ profile: String) -> String {
        switch profile {
        case "stylelab": "dev.extensionsanywhere.stylelab"
        case "chatgpt": "com.openai.codex"
        case "claude": "com.anthropic.claudefordesktop"
        case "vscode": "com.microsoft.VSCode"
        case "figma": "com.figma.Desktop"
        default: "test.\(profile)"
        }
    }
    private func metadata(_ profile: String) -> [String: Any] {
        let identity: [String: Any] = ["CFBundleIdentifier": "dev.extensionsanywhere.launcher.\(profile)",
                                       "CFBundleExecutable": "ExtensionLauncher"]
        return identity.merging(RuntimeHelperCapabilities.metadata(profile: profile, targetIdentifier: target(profile))) { _, marker in marker }
    }

    private func permits(_ info: [String: Any], profile: String = "stylelab") throws -> Bool {
        RuntimeHelperCapabilities.supportsRendererJavaScript(
            metadata: try PropertyListSerialization.data(fromPropertyList: info, format: .binary, options: 0), profile: profile, targetIdentifier: target(profile))
    }

    func testMixedProtocolMarkerRequiresExactHelperAndProfile() throws {
        for profile in ["stylelab", "chatgpt", "claude", "vscode", "figma", "discord", "some-configured-app"] {
            XCTAssertTrue(try permits(metadata(profile), profile: profile))
            XCTAssertFalse(try permits(metadata(profile), profile: profile == "stylelab" ? "vscode" : "stylelab"))
        }
        XCTAssertTrue(RuntimeHelperCapabilities.metadata(profile: "1password", targetIdentifier: "com.1password.1password").isEmpty)
        XCTAssertFalse(try permits(metadata("1password"), profile: "1password"))
        XCTAssertTrue(RuntimeHelperCapabilities.metadata(profile: "claude", targetIdentifier: "com.example.other").isEmpty)
    }

    func testLegacyMissingMalformedAndFutureMarkersNeverImplyJavaScriptSupport() throws {
        let original = metadata("stylelab")
        for key in ["EARendererJavaScriptProtocolVersion", "EARendererJavaScriptProfile", "EARendererJavaScriptTargetIdentifier"] {
            var missing = original
            missing.removeValue(forKey: key)
            XCTAssertFalse(try permits(missing), key)
        }
        for (key, value) in [
            ("CFBundleIdentifier", "dev.extensionsanywhere.launcher.other" as Any),
            ("CFBundleExecutable", "Different" as Any),
            ("EARendererJavaScriptProfile", "vscode" as Any),
            ("EARendererJavaScriptTargetIdentifier", "com.example.other" as Any),
            ("EARendererJavaScriptProtocolVersion", true as Any),
            ("EARendererJavaScriptProtocolVersion", "1" as Any),
            ("EARendererJavaScriptProtocolVersion", 0 as Any),
            ("EARendererJavaScriptProtocolVersion", 2 as Any)
        ] {
            var invalid = original
            invalid[key] = value
            XCTAssertFalse(try permits(invalid), key)
        }
        XCTAssertFalse(RuntimeHelperCapabilities.supportsRendererJavaScript(metadata: nil, profile: "stylelab", targetIdentifier: target("stylelab")))
        XCTAssertFalse(RuntimeHelperCapabilities.supportsRendererJavaScript(metadata: Data("invalid".utf8), profile: "stylelab", targetIdentifier: target("stylelab")))
        XCTAssertFalse(RuntimeHelperCapabilities.supportsRendererJavaScript(
            metadata: Data(repeating: 0, count: RuntimeHelperCapabilities.maximumMetadataBytes + 1), profile: "stylelab", targetIdentifier: target("stylelab")))
    }
}
