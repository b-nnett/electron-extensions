import AppKit
import Foundation
import SwiftUI

struct AppInformationView: View {
    let app: InstalledApp
    let icon: NSImage?

    @Environment(\.dismiss) private var dismiss
    private let information: AppInformationMetadata

    init(app: InstalledApp, icon: NSImage?) {
        self.app = app
        self.icon = icon
        self.information = AppInformationMetadata.read(for: app)
    }

    var body: some View {
        VStack(spacing: 20) {
            VStack(spacing: 10) {
                appIcon

                Text(app.name)
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)

                Text("App Information")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)

            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 11) {
                informationRow("Version", value: information.version)
                informationRow("Build", value: information.build)
                informationRow("Electron", value: information.electronVersion)
                informationRow("Bundle ID", value: information.bundleIdentifier)

                GridRow(alignment: .top) {
                    fieldLabel("Date added")
                    VStack(alignment: .leading, spacing: 4) {
                        Text(information.addedDate?.formatted(date: .abbreviated, time: .omitted) ?? "Unknown")
                            .textSelection(.enabled)
                        Text(information.dateExplanation)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                GridRow(alignment: .top) {
                    fieldLabel("Location")
                    VStack(alignment: .leading, spacing: 7) {
                        Text(app.url.path)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)

                        Button {
                            NSWorkspace.shared.activateFileViewerSelecting([app.url])
                        } label: {
                            Label("Show in Finder", systemImage: "folder")
                        }
                        .controlSize(.small)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Divider()

            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 440)
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var appIcon: some View {
        if let icon {
            Image(nsImage: icon)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: 64, height: 64)
                .accessibilityHidden(true)
        } else {
            Image(systemName: "app.dashed")
                .font(.system(size: 46))
                .foregroundStyle(.secondary)
                .frame(width: 64, height: 64)
                .accessibilityHidden(true)
        }
    }

    private func informationRow(_ label: String, value: String?) -> some View {
        GridRow(alignment: .top) {
            fieldLabel(label)
            Text(value ?? "Unknown")
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func fieldLabel(_ label: String) -> some View {
        Text(label)
            .foregroundStyle(.secondary)
            .gridColumnAlignment(.trailing)
            .fixedSize()
    }
}

/// Reads bundle metadata only; filesystem dates are not an installation history.
struct AppInformationMetadata: Sendable {
    let version: String?
    let build: String?
    let electronVersion: String?
    let bundleIdentifier: String?
    let addedDate: Date?
    let dateExplanation: String

    static func read(for app: InstalledApp) -> AppInformationMetadata {
        let appURL = app.url.standardizedFileURL.resolvingSymlinksInPath()
        let appInfo = propertyList(at: appURL.appendingPathComponent("Contents/Info.plist"))
        let frameworkURL = appURL.appendingPathComponent("Contents/Frameworks/Electron Framework.framework")
            .standardizedFileURL.resolvingSymlinksInPath()
        let frameworkInfo: [String: Any]
        if frameworkURL.path.hasPrefix(appURL.path + "/") {
            frameworkInfo = propertyList(at: frameworkURL.appendingPathComponent("Resources/Info.plist"))
        } else {
            frameworkInfo = [:]
        }

        let dates = try? appURL.resourceValues(forKeys: [.addedToDirectoryDateKey, .creationDateKey])
        let addedDate: Date?
        let dateExplanation: String
        if let date = dates?.addedToDirectoryDate {
            addedDate = date
            dateExplanation = "Date added to this folder. This may differ from the first installation."
        } else if let date = dates?.creationDate {
            addedDate = date
            dateExplanation = "Based on the app bundle’s creation date. Copying or replacing it can change this date."
        } else {
            addedDate = nil
            dateExplanation = "No filesystem date is available."
        }

        return AppInformationMetadata(
            version: nonempty(appInfo["CFBundleShortVersionString"]),
            build: nonempty(appInfo["CFBundleVersion"]),
            electronVersion: nonempty(frameworkInfo["CFBundleShortVersionString"])
                ?? nonempty(frameworkInfo["CFBundleVersion"]),
            bundleIdentifier: nonempty(appInfo["CFBundleIdentifier"]) ?? nonempty(app.bundleIdentifier),
            addedDate: addedDate,
            dateExplanation: dateExplanation
        )
    }

    private static func propertyList(at url: URL) -> [String: Any] {
        guard let data = try? Data(contentsOf: url),
              let object = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
              let dictionary = object as? [String: Any] else { return [:] }
        return dictionary
    }

    private static func nonempty(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
