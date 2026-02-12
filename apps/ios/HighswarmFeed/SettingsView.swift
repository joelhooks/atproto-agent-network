import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        NavigationStack {
            Form {
                Section("Network") {
                    TextField("Relay Base URL", text: $settings.apiBase)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Text("Default: \(SettingsStore.defaultAPIBase)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section {
                    Button("Reset Defaults") {
                        settings.resetDefaults()
                    }
                    .foregroundStyle(.red)
                }
            }
            .navigationTitle("Settings")
        }
    }
}

#Preview {
    SettingsView()
        .environmentObject(SettingsStore())
}
