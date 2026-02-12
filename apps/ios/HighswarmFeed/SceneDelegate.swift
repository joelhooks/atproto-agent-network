import SwiftUI
import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }

        // Ensure shared observable state is created on the main actor.
        Task { @MainActor in
            let stores = SharedStores.shared

            let root = ContentView()
                .environmentObject(stores.settings)
                .environmentObject(stores.feed)

            let host = UIHostingController(rootView: root)
            host.view.backgroundColor = UIColor.black

            let w = UIWindow(windowScene: windowScene)
            // Force the window to fill the whole scene. Some simulator/windowing configurations
            // can otherwise behave like a "card" with margins.
            w.frame = windowScene.screen.bounds
            w.backgroundColor = UIColor.black
            w.rootViewController = host
            host.view.frame = w.bounds
            host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            w.makeKeyAndVisible()
            self.window = w
        }
    }
}
