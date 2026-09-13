import AppKit
import SwiftUI

@main
struct ExtensionsAnywhereApp: App {
    @NSApplicationDelegateAdaptor(ExtensionsApplicationDelegate.self) private var appDelegate
    private let services = ApplicationServices.shared
    private var library: AppLibraryStore { services.library }
    private var extensions: ExtensionManager { services.extensions }
    private var preferences: AppPreferences { services.preferences }
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some Scene {
        Window("Extensions Anywhere", id: "main") {
            AppWindow(library: library, extensions: extensions, columnVisibility: $columnVisibility)
                .frame(minWidth: 780, minHeight: 500)
        }
        .defaultSize(width: 1100, height: 740)
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .appInfo) {
                CheckForUpdatesButton(updater: services.updater)
            }
            CommandGroup(after: .sidebar) {
                Button("Toggle Sidebar") {
                    withAnimation {
                        columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly
                    }
                }
                .keyboardShortcut("s", modifiers: .command)

                Button("Refresh Apps") {
                    library.refresh()
                    extensions.reload()
                }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(library.isLoading)
            }
        }
        Settings {
            SettingsView(preferences: preferences, updater: services.updater, manager: extensions)
        }
        MenuBarExtra("Extensions Anywhere", systemImage: "puzzlepiece.extension") {
            TweakedAppsMenu(library: library, extensions: extensions, preferences: preferences)
        }
        .menuBarExtraStyle(.menu)
    }

}

private struct AppWindow: View {
    @Bindable var library: AppLibraryStore
    @Bindable var extensions: ExtensionManager
    @Binding var columnVisibility: NavigationSplitViewVisibility
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingCreator = false
    @State private var creationTarget: InstalledApp?
    @State private var authoringDraft = ExtensionAuthoringDraft()

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            List(selection: Binding(
                get: { showingCreator ? nil : library.selection },
                set: { selection in
                    library.selection = selection
                    if selection != nil { showingCreator = false }
                }
            )) {
                Section("Your Apps") {
                    if library.yourApps.isEmpty && library.unavailableApps.isEmpty {
                        HStack(spacing: 10) {
                            Image(systemName: "puzzlepiece.extension")
                                .font(.system(size: 17))
                                .frame(width: 26, height: 26)
                            Text("Tweaked apps live here")
                                .font(.system(size: 12))
                        }
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .overlay {
                            RoundedRectangle(cornerRadius: 7)
                                .strokeBorder(.secondary.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                        }
                        .listRowInsets(EdgeInsets(top: 3, leading: 0, bottom: 5, trailing: 0))
                        .disabled(true)
                    } else {
                        ForEach(library.yourApps) { app in appRow(app) }
                        ForEach(library.unavailableApps) { app in
                            HStack(spacing: 10) {
                                Image(systemName: "app.dashed")
                                    .font(.system(size: 22)).frame(width: 26, height: 26)
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(app.name).font(.system(size: 13)).lineLimit(1)
                                    Text("Not installed").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 3)
                            .tag(app.id)
                            .help("Saved extensions for \(app.appKey). No matching app is installed.")
                        }
                    }
                }

                Section("Other Apps") {
                    ForEach(library.otherApps) { app in appRow(app) }
                    if library.otherApps.isEmpty {
                        if library.isLoading {
                            ProgressView().controlSize(.small).padding(.vertical, 5)
                        } else if library.errorMessage == nil {
                            Text("No Electron apps found")
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 5)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 240, ideal: 260, max: 360)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    if let message = library.errorMessage {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Divider()
                    Button { openCreator(for: library.selectedApp) } label: {
                        Label("Create Extension", systemImage: "plus.circle")
                            .font(.system(size: 13, weight: .medium))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 10)
                            .background(showingCreator ? Color.primary.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 7))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(10)
                }
                .background(.bar)
            }
        } detail: {
            if showingCreator {
                CreateExtensionView(app: creationTarget, draft: authoringDraft)
            } else if let app = library.selectedApp {
                AppExtensionsView(app: app, icon: library.icons[app.id], manager: extensions) {
                    openCreator(for: app)
                }
                    .id(app.id)
            } else if let app = library.selectedUnavailableApp {
                UnavailableAppExtensionsView(app: app, manager: extensions) { library.refresh() }
                    .id(app.id)
            } else {
                Color(nsColor: .windowBackgroundColor).ignoresSafeArea()
            }
        }
        .navigationSplitViewStyle(.balanced)
        .task {
            if authoringDraft.wasOpen {
                creationTarget = authoringDraft.targetApp
                showingCreator = true
            }
            extensions.reload()
            library.setExtensionAppKeys(extensions.appKeys)
            library.refresh()
        }
        .onChange(of: extensions.appKeys) { _, keys in library.setExtensionAppKeys(keys) }
        .onChange(of: showingCreator) { _, value in authoringDraft.wasOpen = value }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                library.refresh()
                extensions.reload()
            }
        }
        .alert("Couldn't update extensions", isPresented: Binding(
            get: { extensions.errorMessage != nil },
            set: { if !$0 { extensions.errorMessage = nil } }
        )) {
            Button("OK") { extensions.errorMessage = nil }
        } message: {
            Text(extensions.errorMessage ?? "Please try again.")
        }
    }

    private func openCreator(for app: InstalledApp?) {
        creationTarget = app
        authoringDraft.targetApp = app
        authoringDraft.wasOpen = true
        showingCreator = true
    }

    private func appRow(_ app: InstalledApp) -> some View {
        HStack(spacing: 10) {
            if let icon = library.icons[app.id] {
                Image(nsImage: icon)
                    .resizable().interpolation(.high).scaledToFit()
                    .frame(width: 26, height: 26)
                    .accessibilityHidden(true)
            }
            Text(app.name).font(.system(size: 13)).lineLimit(1)
        }
        .padding(.vertical, 3)
        .tag(app.id)
        .help(app.url.path)
    }
}
