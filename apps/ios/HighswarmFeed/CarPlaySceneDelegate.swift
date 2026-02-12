import Combine
import Foundation

#if canImport(CarPlay)
import CarPlay
#endif

// Minimal CarPlay mirror for the feed.
// Note: CarPlay entitlements/category approval is an Apple policy thing; this is for local/simulator use.
final class CarPlaySceneDelegate: UIResponder {
    #if canImport(CarPlay)
    private var interfaceController: CPInterfaceController?
    private var listTemplate: CPListTemplate?
    private var cancellable: AnyCancellable?
    #endif
}

#if canImport(CarPlay)
extension CarPlaySceneDelegate: CPTemplateApplicationSceneDelegate {
    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController,
        to window: CPWindow
    ) {
        self.interfaceController = interfaceController

        Task { @MainActor in
            // Ensure the shared socket is running even if the main UI never appeared.
            let stores = SharedStores.shared
            stores.feed.start(settings: stores.settings)
            self.bindToFeed(stores.feed)
            self.installRootTemplate()
        }
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnectInterfaceController interfaceController: CPInterfaceController,
        from window: CPWindow
    ) {
        self.interfaceController = nil
        self.listTemplate = nil
        self.cancellable?.cancel()
        self.cancellable = nil
    }

    private func installRootTemplate() {
        let tpl = CPListTemplate(title: "HIGHSwarm", sections: [CPListSection(items: [])])
        tpl.tabTitle = "Feed"

        tpl.trailingNavigationBarButtons = [
            CPBarButton(type: .text) { [weak self] _ in
                Task { @MainActor in
                    SharedStores.shared.feed.clearEvents()
                    self?.refreshList()
                }
            }.withTitle("Clear")
        ]

        self.listTemplate = tpl
        refreshList()

        interfaceController?.setRootTemplate(tpl, animated: true, completion: nil)
    }

    private func bindToFeed(_ feed: FeedStore) {
        // FeedStore is @MainActor; keep updates on main.
        cancellable = feed.$events
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.refreshList()
            }
    }

    private func refreshList() {
        guard let tpl = listTemplate else { return }

        let events = SharedStores.shared.feed.events.prefix(12)
        let items: [CPListItem] = events.map { ev in
            let title = "\(ev.agent) \(ev.kind.rawValue)"
            let detail = ev.summary

            let item = CPListItem(text: title, detailText: detail)
            item.handler = { [weak self] _, completion in
                self?.pushDetail(for: ev)
                completion()
            }
            return item
        }

        tpl.updateSections([CPListSection(items: items)])
    }

    private func pushDetail(for ev: FeedEvent) {
        let infoItems: [CPInformationItem] = [
            CPInformationItem(title: "agent", detail: ev.agent),
            CPInformationItem(title: "kind", detail: ev.kind.rawValue),
            CPInformationItem(title: "type", detail: ev.type),
            CPInformationItem(title: "ts", detail: ev.timestamp.formatted()),
            CPInformationItem(title: "summary", detail: ev.summary),
        ]

        let info = CPInformationTemplate(title: "Event", layout: .leading, items: infoItems, actions: [])
        interfaceController?.pushTemplate(info, animated: true, completion: nil)
    }
}

private extension CPBarButton {
    func withTitle(_ title: String) -> CPBarButton {
        self.title = title
        return self
    }
}
#endif

