import Foundation

/// Capability declarations are part of the helper's signed Info.plist. Callers
/// must verify the helper signature before trusting a declaration for execution.
/// Absence means an older helper; it must never imply JavaScript support.
public enum RuntimeHelperCapabilities {
    public static let rendererJavaScriptProtocolVersion = 1
    public static let maximumMetadataBytes = 64 * 1024

    public static func metadata(profile: String, targetIdentifier: String) -> [String: Any] {
        guard validIdentity(profile: profile, targetIdentifier: targetIdentifier) else { return [:] }
        return ["EARendererJavaScriptProtocolVersion": rendererJavaScriptProtocolVersion,
                "EARendererJavaScriptProfile": profile,
                "EARendererJavaScriptTargetIdentifier": targetIdentifier]
    }

    public static func supportsRendererJavaScript(metadata data: Data?, profile: String, targetIdentifier: String) -> Bool {
        guard validIdentity(profile: profile, targetIdentifier: targetIdentifier), let data, data.count <= maximumMetadataBytes,
              let metadata = try? PropertyListDecoder().decode(Metadata.self, from: data) else { return false }
        return metadata.CFBundleIdentifier == "dev.extensionsanywhere.launcher.\(profile)" &&
            metadata.CFBundleExecutable == "ExtensionLauncher" &&
            metadata.EARendererJavaScriptProfile == profile &&
            metadata.EARendererJavaScriptTargetIdentifier == targetIdentifier &&
            metadata.EARendererJavaScriptProtocolVersion == rendererJavaScriptProtocolVersion
    }

    /// This declaration does not select an app or enable an engine. Callers
    /// derive profile/target from the validated selected catalog or built-in.
    private static func validIdentity(profile: String, targetIdentifier: String) -> Bool {
        guard profile.range(of: #"^[a-z][a-z0-9-]{0,63}$"#, options: .regularExpression) != nil,
              profile != "1password", targetIdentifier.utf8.count <= 255,
              targetIdentifier.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]*$"#, options: .regularExpression) != nil else { return false }
        if profile == "stylelab" { return targetIdentifier == RuntimeExtensionSelection.styleLabIdentifier }
        if profile == "chatgpt" { return targetIdentifier == RuntimeExtensionSelection.chatgptIdentifier }
        if profile == "claude" { return targetIdentifier == RuntimeExtensionSelection.claudeIdentifier }
        return true
    }

    private struct Metadata: Decodable {
        let CFBundleIdentifier: String
        let CFBundleExecutable: String
        let EARendererJavaScriptProtocolVersion: Int?
        let EARendererJavaScriptProfile: String?
        let EARendererJavaScriptTargetIdentifier: String?
    }
}
