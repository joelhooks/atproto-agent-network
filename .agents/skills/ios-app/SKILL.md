---
name: ios-app
description: Build and maintain the native iOS client inside this turborepo (XcodeGen, SwiftUI, WebSocket feed). Use when creating/updating the iOS app, wiring turbo tasks, or documenting iOS workflows.
---

# iOS App Skill (Highswarm Feed)

This repo includes a native iOS app at `apps/ios/` built with XcodeGen.

## Purpose (v0)

- Tokenless, read-only feed.
- Connect to the firehose WebSocket and render the full stream in a SwiftUI list.
- Dense "TUI" theme (max info density, small fonts, stacked rows).
- Geist Pixel font (bundled under `HighswarmFeed/Resources/Fonts/`).
- CarPlay mirror (shows the same feed using the same underlying socket/state).
- Keep the iOS workflow reproducible inside the turborepo.

## Paths

- App: `apps/ios/`
- XcodeGen spec: `apps/ios/project.yml`
- Sources: `apps/ios/HighswarmFeed/`
- Tests: `apps/ios/HighswarmFeedTests/`
- Font resources: `apps/ios/HighswarmFeed/Resources/Fonts/`

## Server API Facts (Current)

- Default base URL: `https://agent-network.joelhooks.workers.dev`
- Firehose WS endpoint (raw, tokenless for now): `wss://.../firehose` (aliases to `/relay/firehose`).
- Sanitized public stream still exists at: `wss://.../relay/public-firehose`.
## Workflow

Generate the project:

```bash
cd apps/ios
pnpm gen
```

Open in Xcode:

```bash
cd apps/ios
pnpm open
```

Build + test from CLI (uses installed iOS 26.2 simulator runtime):

```bash
cd apps/ios
pnpm ios:test
```

Run it in the Simulator (fast loop, no Xcode needed):

```bash
pnpm ios:build
APP=$(ls -d ~/Library/Developer/Xcode/DerivedData/HighswarmFeed-*/Build/Products/Debug-iphonesimulator/HighswarmFeed.app | head -n 1)
UDID=$(xcrun simctl list devices available | rg "iPhone 17 \\(" | head -n 1 | sed -n 's/.*(\\([0-9A-F-]\\{36\\}\\)).*/\\1/p')
open -a Simulator
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" com.joelhooks.highswarm.feed
```

## Turborepo Integration

`apps/ios` includes a `package.json` so pnpm/turbo can run scripts:

- `pnpm --filter @atproto-agent-network/ios ios:test`

We intentionally avoid naming these scripts `build`/`test` so `turbo build` / `turbo test`
doesn't start running Xcode builds when you're just shipping the Workers app.

## Keeping It Updated

When the network event payload shape changes (especially `event_type`, `timestamp`, and `context` fields):

- Update the Swift decoder in `apps/ios/HighswarmFeed/Models.swift`
- Update normalization logic in `apps/ios/HighswarmFeed/EventNormalizer.swift`
- Add/adjust tests in `apps/ios/HighswarmFeedTests/EventNormalizerTests.swift`

## CarPlay Notes

- CarPlay UI lives in `apps/ios/HighswarmFeed/CarPlaySceneDelegate.swift`.
- We intentionally reuse `SharedStores.shared` so CarPlay does not open a second WebSocket.
- CarPlay policies/entitlements are a future problem; this is intended for local/simulator testing while iterating.
