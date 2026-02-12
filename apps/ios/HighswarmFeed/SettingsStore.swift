import Foundation

@MainActor
final class SettingsStore: ObservableObject {
    private enum Keys {
        static let apiBase = "highswarm.apiBase"
    }

    static let defaultAPIBase = "https://agent-network.joelhooks.workers.dev"

    @Published var apiBase: String {
        didSet { persist() }
    }

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults

        let storedBase = userDefaults.string(forKey: Keys.apiBase)
        self.apiBase = SettingsStore.sanitizeAPIBase(storedBase) ?? SettingsStore.defaultAPIBase
    }

    let userDefaults: UserDefaults

    var apiBaseURL: URL? {
        URL(string: apiBase)
    }

    var wsBaseURL: URL? {
        guard let httpURL = apiBaseURL else { return nil }
        var comps = URLComponents(url: httpURL, resolvingAgainstBaseURL: false)
        if comps?.scheme == "https" { comps?.scheme = "wss" }
        else if comps?.scheme == "http" { comps?.scheme = "ws" }
        return comps?.url
    }

    // A cheap way to detect meaningful config changes from SwiftUI.
    var effectiveConfigFingerprint: String {
        apiBase
    }

    func resetDefaults() {
        apiBase = SettingsStore.defaultAPIBase
    }

    private func persist() {
        if let cleaned = SettingsStore.sanitizeAPIBase(apiBase) {
            userDefaults.set(cleaned, forKey: Keys.apiBase)
        }
    }

    private static func sanitizeAPIBase(_ value: String?) -> String? {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        guard let url = URL(string: raw), let scheme = url.scheme else { return nil }
        guard scheme == "https" || scheme == "http" else { return nil }
        return raw
    }
}
