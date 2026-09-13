import Foundation
import RuntimeCatalog

/// Presentation uses the same selected-app profile and record validation as launch.
enum ExtensionCapabilities {
    static func runtimeTrustNotice(for app: InstalledApp) -> String? {
        guard let profile = ElectronLaunchProfile.profile(for: app) else { return nil }
        let trust = "Only enable extensions you trust. Scripts can read and change \(app.name)’s content."
        if profile == .claude {
            return "\(trust) Claude’s user-enabled main-process debugger also gives other local software access to the full app process. Disabling extensions does not close that port. Use Claude’s Quit command to end the session. Extension scripts run only in the selected renderer."
        }
        if case .catalog(let definition) = profile, definition.transport == "pipe" {
            return "\(trust) This profile uses a debugger pipe. Disabling extensions keeps it connected; quitting the launcher may also quit \(app.name). Use \(app.name)’s Quit command to end the session."
        }
        return "\(trust) Its local debugging port is accessible to other local software and remains open until you quit \(app.name). Disabling extensions does not close the port. Use \(app.name)’s Quit command to end the session."
    }

    static func authoringSummary(for app: InstalledApp?) -> String {
        guard let app else {
            return "Choose an app before importing. Bundled profiles declare their CSS and renderer JavaScript engine configuration. Configuration does not mean an installed app or every page has been verified. Apps without a runtime can store extensions disabled."
        }
        guard ElectronLaunchProfile.supports(app) else {
            return "No extension runtime is configured for \(app.name). You can save extensions here, but they won't run."
        }
        if ElectronLaunchProfile.profile(for: app)?.supportsJavaScript == true {
            if ElectronLaunchProfile.profile(for: app) == .claude {
                return "An assisted CSS and renderer JavaScript runtime is configured for Claude’s new-chat page only. Enable Developer Mode once, then choose Developer → Enable Main Process Debugger after each launch. Extensions connect automatically after that setup. This route has not yet passed imported-JavaScript verification in Claude. Enabled CSS must total 64 KiB or less and JavaScript 256 KiB or less."
            }
            if ElectronLaunchProfile.profile(for: app) == .chatgpt {
                return "An experimental CSS and renderer JavaScript runtime is configured for ChatGPT's main app page. JavaScript behavior has not been verified in this installed app. Enabled CSS must total 64 KiB or less and JavaScript 256 KiB or less. Register script cleanup with ea.onDispose."
            }
            if app.bundleIdentifier == RuntimeExtensionSelection.figmaIdentifier {
                return "A CSS and renderer JavaScript runtime is configured for Figma's HTTPS pages on www.figma.com, including signed-in routes. Live end-to-end verification covers the login page only; the files browser and editor have not been verified. Enabled CSS must total 64 KiB or less and JavaScript 256 KiB or less. Register script cleanup with ea.onDispose. Compatibility depends on the installed app version."
            }
            return "A CSS and renderer JavaScript runtime is configured for \(app.name), limited to its configured page routes. This is not end-to-end verification of the installed version. Enabled CSS must total 64 KiB or less and JavaScript 256 KiB or less. Register script cleanup with ea.onDispose."
        }
        return "A CSS runtime is configured for \(app.name). JavaScript cannot run yet. Compatibility depends on the installed app version."
    }

    static func enablementIssue(for record: ExtensionRecord, app: InstalledApp, records: [ExtensionRecord]) -> String? {
        guard ElectronLaunchProfile.supports(app) else {
            return "No extension runtime is configured for \(app.name)."
        }
        var enabled = record
        enabled.isEnabled = true
        do {
            guard record.appKey == ExtensionLibrary.appKey(for: app) else { return "This extension belongs to another app." }
            try ElectronLaunchProfile.validate(records: records.filter { $0.id != record.id } + [enabled], app: app)
            return nil
        } catch { return error.localizedDescription }
    }

    static func importIssue(for package: ImportedExtensionPackage, app: InstalledApp, records: [ExtensionRecord]) -> String? {
        guard let first = package.sources.first else { return "This package contains no source files." }
        let candidate = ExtensionRecord(id: UUID(), appKey: ExtensionLibrary.appKey(for: app),
            name: package.manifest.name, description: package.manifest.description,
            sourceFileName: (first.fileName as NSString).lastPathComponent, sourceType: first.type, sourceText: first.text,
            isEnabled: true, createdAt: Date(), manifestVersion: package.manifest.version,
            sourceFiles: package.sources.map { StoredExtensionSource(fileName: $0.fileName, type: $0.type, text: $0.text) })
        return enablementIssue(for: candidate, app: app, records: records)
    }
}
