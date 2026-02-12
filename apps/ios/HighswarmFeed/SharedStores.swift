import Foundation

// Shared app state so CarPlay and the main UI don't spin up separate sockets.
// This is "just for Joel" right now, so a simple singleton is fine.
@MainActor
final class SharedStores {
    static let shared = SharedStores()

    let settings = SettingsStore()
    let feed = FeedStore()
}

