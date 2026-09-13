import AppKit
import SwiftUI

struct TweakedAppsMenu: View {
    let library: AppLibraryStore
    let extensions: ExtensionManager
    let preferences: AppPreferences

    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let layout = preferences.menuLayout(for: library.yourApps)
        if layout.usesSubmenu {
            Section("Most Used") {
                ForEach(layout.mostUsedApps) { app in appButton(app) }
            }
            Menu("All Tweaked Apps") {
                ForEach(layout.allApps) { app in appButton(app) }
            }
        } else if layout.directApps.isEmpty {
            Text("No tweaked apps yet")
        } else {
            ForEach(layout.directApps) { app in appButton(app) }
        }

        Divider()
        Button("Open Extensions Anywhere", systemImage: "macwindow") {
            openWindow(id: "main")
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        SettingsLink {
            Label("Settings…", systemImage: "gearshape")
        }
        .keyboardShortcut(",", modifiers: .command)
        Divider()
        Button("Quit Extensions Anywhere") {
            NSApplication.shared.terminate(nil)
        }
        .keyboardShortcut("q", modifiers: .command)
    }

    private func appButton(_ app: InstalledApp) -> some View {
        Button {
            RuntimeEventJournal.shared.record("menuLaunchRequested", app: app)
            extensions.open(app)
            if extensions.errorMessage != nil {
                library.selection = app.id
                openWindow(id: "main")
                NSApplication.shared.activate(ignoringOtherApps: true)
            }
        } label: {
            Label {
                Text(app.name)
            } icon: {
                if let icon = library.icons[app.id] {
                    Image(nsImage: icon)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 18, height: 18)
                } else {
                    Image(systemName: "app")
                }
            }
        }
        .help(app.url.path)
    }
}
