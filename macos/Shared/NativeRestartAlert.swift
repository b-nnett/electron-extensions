import AppKit

/// Both automatic detection and Dock shortcuts use AppKit's standard alert.
@MainActor
public enum NativeRestartAlert {
    public enum Context: Equatable { case missingExtensions, alreadyRunning, runtimeUpgrade }

    public static func make(appName: String, context: Context, icon: NSImage? = nil, assistedSetupInstructions: String? = nil) -> NSAlert {
        let alert = NSAlert()
        alert.alertStyle = .informational
        switch context {
        case .missingExtensions:
            alert.messageText = "\(appName) is running without extensions."
        case .alreadyRunning:
            alert.messageText = "Restart \(appName) with extensions?"
        case .runtimeUpgrade:
            alert.messageText = "Restart \(appName) to enable this extension?"
        }
        if let assistedSetupInstructions {
            alert.informativeText = context == .runtimeUpgrade
                ? "Its extension launcher needs an update. \(appName) will quit normally, then reopen. \(assistedSetupInstructions) Not Now keeps your current extensions unchanged."
                : "\(appName) will quit normally, then reopen. \(assistedSetupInstructions)"
        } else if context == .runtimeUpgrade {
            alert.informativeText = "Its extension launcher needs an update. \(appName) will quit normally, then reopen with your requested extension change. Not Now keeps your current extensions unchanged."
        } else {
            alert.informativeText = "\(appName) will quit normally, then reopen with your enabled extensions."
        }
        if let icon { alert.icon = icon }
        alert.addButton(withTitle: "Restart").keyEquivalent = "\r"
        alert.addButton(withTitle: "Not Now").keyEquivalent = "\u{1b}"
        return alert
    }
}
