---
name: ios-publish
description: Publish the native iOS app to TestFlight from this repo. Use when archiving/exporting/uploading builds, bumping versions, checking App Store Connect processing status, or fixing common upload failures.
---

# iOS Publish (TestFlight)

Publish workflow for `apps/ios` (`HighswarmFeed`) in this turborepo.

## Scope

- App project: `apps/ios/HighswarmFeed.xcodeproj`
- Bundle ID: `com.joelhooks.highswarm.feed`
- Team ID: `N7L54A44YX`
- Default Apple ID: `joelhooks@gmail.com`
- TestFlight script: `apps/ios/scripts/deploy-testflight.sh`

## Preferred Path (One Command)

From repo root:

```bash
pnpm ios:testflight
```

This runs:
1. XcodeGen project generation
2. Archive (`generic/platform=iOS`)
3. IPA export (`ExportOptions.plist`)
4. Upload via `xcrun altool`

## Prerequisites

Before first upload:

1. App Store Connect app exists for `com.joelhooks.highswarm.feed`
2. Keychain has app-specific password:

```bash
security add-generic-password -a "joelhooks@gmail.com" -s "AC_PASSWORD" -w "<app-specific-password>"
```

If Apple ID belongs to multiple providers, set provider public ID:

```bash
export ASC_PROVIDER_PUBLIC_ID="c6caf075-f2be-4200-9b9a-f2d2c677f9e4"
```

## Build Number Bump

Bump build before each new upload:

```bash
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion <N>" apps/ios/HighswarmFeed/Info.plist
```

Version keys live in:
- `apps/ios/HighswarmFeed/Info.plist`
  - `CFBundleShortVersionString`
  - `CFBundleVersion`

## Processing Status Check

After upload, check status with delivery UUID:

```bash
xcrun altool --build-status \
  --delivery-id "<delivery-uuid>" \
  --provider-public-id "c6caf075-f2be-4200-9b9a-f2d2c677f9e4" \
  -u "joelhooks@gmail.com" \
  -p @keychain:AC_PASSWORD \
  --output-format json
```

Typical statuses:
- `VALID_BINARY` (uploaded and valid)
- `BETA_INTERNAL_TESTING` (available for internal testing)

## Common Failures

### Missing icon / CFBundleIconName

Symptoms:
- "Missing required icon file" (120x120 / 152x152)
- "Missing Info.plist value CFBundleIconName"

Fix:
- Ensure `apps/ios/HighswarmFeed/Assets.xcassets/AppIcon.appiconset/Icon-1024.png` exists
- Ensure `apps/ios/project.yml` includes:
  - `ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon`
- Ensure `apps/ios/HighswarmFeed/Info.plist` includes:
  - `CFBundleIconName` = `AppIcon`

### Bundle ID not found in ASC

Symptoms:
- altool fails to resolve app from bundle ID

Fix:
- Register App ID in Apple Developer
- Create app in App Store Connect using `com.joelhooks.highswarm.feed`

## Notes

- Do not hand-edit generated Xcode project; update `apps/ios/project.yml` and regenerate.
- Use built-in script flow first; only introduce Fastlane if CLI flow becomes insufficient.
