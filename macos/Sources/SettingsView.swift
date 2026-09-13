import SwiftUI

struct SettingsView: View {
    @Bindable var preferences: AppPreferences
    let updater: AppUpdater
    let manager: ExtensionManager

    var body: some View {
        Form {
            Section {
                Toggle("Prompt to restart apps without extensions",
                       isOn: $preferences.promptToRestartAppsWithoutExtensions)
                Text("When a supported app opens without its enabled extensions, ask whether to restart it with them. Apps never restart automatically.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } header: {
                Text("Launching apps")
            }
            UpdateSettingsSection(updater: updater)
            LibraryRecoverySettingsSection(manager: manager)
        }
        .formStyle(.grouped)
        .frame(width: 470)
        .fixedSize(horizontal: false, vertical: true)
        .navigationTitle("Settings")
    }
}
