import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var settings: SettingsStore
    @EnvironmentObject private var feed: FeedStore

    var body: some View {
        // No TabView: iOS uses a floating tab "pill" that eats vertical space.
        // This app is a dense log viewer; settings lives behind an explicit button.
        FeedView()
            .task {
                // Keep the socket aligned with current settings.
                feed.start(settings: settings)
            }
            .onChange(of: settings.effectiveConfigFingerprint) {
                feed.restart(settings: settings)
            }
    }
}

#Preview {
    ContentView()
        .environmentObject(SettingsStore())
        .environmentObject(FeedStore())
}
