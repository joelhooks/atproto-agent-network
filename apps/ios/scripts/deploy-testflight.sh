#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

SCHEME="HighswarmFeed"
PROJECT="HighswarmFeed.xcodeproj"
ARCHIVE_PATH="build/HighswarmFeed.xcarchive"
EXPORT_PATH="build/export"
IPA_PATH="$EXPORT_PATH/HighswarmFeed.ipa"
APPLE_ID="${APPLE_ID:-joelhooks@gmail.com}"
ASC_PROVIDER_PUBLIC_ID="${ASC_PROVIDER_PUBLIC_ID:-c6caf075-f2be-4200-9b9a-f2d2c677f9e4}"

echo "Generating Xcode project..."
pnpm gen

echo "Archiving $SCHEME..."
xcodebuild -project "$PROJECT" \
  -scheme "$SCHEME" \
  -archivePath "$ARCHIVE_PATH" \
  -destination "generic/platform=iOS" \
  -allowProvisioningUpdates \
  archive

echo "Exporting IPA..."
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "ExportOptions.plist" \
  -allowProvisioningUpdates

if ! security find-generic-password -a "$APPLE_ID" -s "AC_PASSWORD" >/dev/null 2>&1; then
  echo "Missing keychain entry AC_PASSWORD for $APPLE_ID"
  echo "Run: security add-generic-password -a \"$APPLE_ID\" -s \"AC_PASSWORD\" -w \"<app-specific-password>\""
  exit 1
fi

echo "Uploading to TestFlight..."
xcrun altool --upload-app \
  -f "$IPA_PATH" \
  -t ios \
  -u "$APPLE_ID" \
  -p @keychain:AC_PASSWORD \
  --provider-public-id "$ASC_PROVIDER_PUBLIC_ID" \
  --output-format json

echo "Upload submitted. Check App Store Connect > TestFlight for processing status."
