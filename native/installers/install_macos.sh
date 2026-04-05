#!/usr/bin/env bash
# Install TopicBlock Native Messaging host manifest on macOS.
# Usage: bash install_macos.sh <extension-id> <path-to-native-binary>
set -euo pipefail

EXTENSION_ID="${1:?Usage: install_macos.sh <extension-id> <binary-path>}"
BINARY_PATH="${2:?Usage: install_macos.sh <extension-id> <binary-path>}"

MANIFEST_NAME="com.topicblock.native"
CHROME_HOSTS="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
BRAVE_HOSTS="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
EDGE_HOSTS="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"

MANIFEST_CONTENT=$(cat <<EOF
{
  "name": "${MANIFEST_NAME}",
  "description": "TopicBlock native inference component",
  "path": "${BINARY_PATH}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
EOF
)

for DIR in "$CHROME_HOSTS" "$BRAVE_HOSTS" "$EDGE_HOSTS"; do
  mkdir -p "$DIR"
  echo "$MANIFEST_CONTENT" > "$DIR/${MANIFEST_NAME}.json"
  echo "Installed manifest to $DIR"
done

echo "Done. Reload the extension in chrome://extensions to activate."
