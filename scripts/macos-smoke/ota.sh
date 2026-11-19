#!/usr/bin/env bash
set -Eeuo pipefail

image="$1"
arch="$2"
baseline="$3"
target="$4"
test "$(uname -m)" = "$arch"

work="$(mktemp -d "$RUNNER_TEMP/fineshell-ota.XXXXXX")"
mount="$work/mount"
app="$work/FineShell.app"
mkdir "$mount"
hdiutil attach "$image" -mountpoint "$mount" -nobrowse -readonly
trap 'hdiutil detach "$mount" || printf "%s\n" "Could not detach the test disk image." >&2' EXIT
ditto "$mount/FineShell.app" "$app"
codesign --verify --deep --strict "$app"

bundle_meta() {
    /usr/libexec/PlistBuddy -c "Print :$1" "$app/Contents/Info.plist"
}

test "$(bundle_meta CFBundleShortVersionString)" = "$baseline"
executable="$(bundle_meta CFBundleExecutable)"
test "$(lipo -archs "$app/Contents/MacOS/$executable")" = "$arch"
if pgrep -x "$executable" >/dev/null; then
    printf '%s\n' 'FineShell is already running on this runner.' >&2
    exit 1
fi

swiftc scripts/macos-smoke/verify-window.swift -o "$work/verify-window"
open -n "$app"
pid=''
for ((attempt=0; attempt<30; attempt++)); do
    if pid="$(pgrep -x "$executable")"; then break; fi
    sleep 1
done
test -n "$pid"
test "$(ps -p "$pid" -o comm=)" = "$app/Contents/MacOS/$executable"

# Wait for WebKit to create FineShell's profile before writing the test marker.
profile="$HOME/Library/WebKit/$(bundle_meta CFBundleIdentifier)"
for ((attempt=0; attempt<20; attempt++)); do
    if [[ -d "$profile" ]]; then break; fi
    sleep 1
done
test -d "$profile"
marker="$(uuidgen)"
printf '%s\n' "$marker" > "$profile/fineshell-ota-test-marker"

osascript scripts/macos-smoke/press-update.applescript "$pid"
for ((attempt=0; attempt<120; attempt++)); do
    if [[ "$(bundle_meta CFBundleShortVersionString 2>/dev/null || true)" == "$target" ]] &&
       ! kill -0 "$pid" 2>/dev/null; then
        break
    fi
    sleep 1
done
test "$(bundle_meta CFBundleShortVersionString)" = "$target"
if kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' 'FineShell did not exit after installing the signed update.' >&2
    exit 1
fi
codesign --verify --deep --strict "$app"
test "$(lipo -archs "$app/Contents/MacOS/$executable")" = "$arch"
"$work/verify-window" "$app"
test "$(cat "$profile/fineshell-ota-test-marker")" = "$marker"
printf 'FineShell %s -> %s: app relaunched with a visible window and the WebKit profile marker survived.\n' "$baseline" "$target"
