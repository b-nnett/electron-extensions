import Foundation

/// App lifetime, including launches with no main window and menu-only use.
@MainActor
final class ApplicationServices {
    static let shared = ApplicationServices()
    let library: AppLibraryStore
    let extensions: ExtensionManager
    let preferences: AppPreferences
    let runtimeMonitor: ExtensionRuntimeMonitor
    let updater = AppUpdater()

    private init() {
        let library = AppLibraryStore()
        let extensions = ExtensionManager()
        let preferences = AppPreferences()
        self.library = library
        self.extensions = extensions
        self.preferences = preferences
        runtimeMonitor = ExtensionRuntimeMonitor(library: library, extensions: extensions, preferences: preferences)
    }

    func start() {
        extensions.reload()
        library.setExtensionAppKeys(extensions.appKeys)
        library.refresh()
        runtimeMonitor.start()
        updater.start()
    }
}
