import Foundation

// Central place for "networking defaults" so we don't accidentally use URLSession.shared everywhere.
// Keep it simple and battery-conscious: one host, one socket, minimal extra features.
enum WebSocketSessions {
    static let feed: URLSession = {
        let config = URLSessionConfiguration.default

        // WebSockets don't benefit from cookie/caching state for this app.
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData

        // Keep the session from opening parallel connections to the same host.
        config.httpMaximumConnectionsPerHost = 1

        // Handshake should be snappy; if it can't connect, we reconnect with backoff.
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 60

        // Behave well on flaky connectivity.
        config.waitsForConnectivity = true

        // Personal dogfooding: keep it working even on Low Data Mode / constrained networks.
        // If you want to respect Low Data Mode later, make this a user-facing toggle.
        config.allowsConstrainedNetworkAccess = true
        config.allowsExpensiveNetworkAccess = true

        return URLSession(configuration: config)
    }()
}

