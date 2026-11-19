#!/usr/bin/env bash
set -Eeuo pipefail

package_name="$1"
data_dir="$RUNNER_TEMP/fineshell-ota-data"
export XDG_DATA_HOME="$data_dir"
export XDG_CONFIG_HOME="$RUNNER_TEMP/fineshell-ota-config"
export GDK_BACKEND=x11
export NO_AT_BRIDGE=0

profile="$data_dir/com.fineshell.app"
mkdir -p "$profile"
marker="$(cat /proc/sys/kernel/random/uuid)"
printf '%s\n' "$marker" > "$profile/ota-smoke-marker"

version() {
    dpkg-query -W -f='${Version}' "$package_name"
}

window_for() {
    local windows
    windows="$(xdotool search --onlyvisible --all --pid "$1" --name '^FineShell$')" || return
    printf '%s\n' "${windows%%$'\n'*}"
}

test "$(version)" = 0.5.0
test -x /usr/bin/fineshell
/usr/bin/fineshell > "$RUNNER_TEMP/fineshell-ota.log" 2>&1 &
app_pid=$!
restarted_pid=''
cleanup() {
    local result=$?
    if ((result != 0)); then tail -n 80 "$RUNNER_TEMP/fineshell-ota.log" >&2; fi
    if [[ -n "$restarted_pid" ]]; then kill "$restarted_pid" 2>/dev/null || true; fi
    kill "$app_pid" 2>/dev/null || true
}
trap cleanup EXIT

timeout 85s /usr/bin/python3 scripts/linux-smoke/press-update.py "$app_pid"
for ((attempt=0; attempt<120; attempt++)); do
    if [[ "$(version)" == 0.5.1 ]]; then
        for candidate in $(pgrep -u "$UID" -x fineshell || true); do
            if [[ "/proc/$candidate/exe" -ef /usr/bin/fineshell ]] && window="$(window_for "$candidate")"; then
                restarted_pid="$candidate"
                break 2
            fi
        done
    fi
    sleep 1
done

test "$(version)" = 0.5.1
test "$(dpkg-query -W -f='${Status}' "$package_name")" = 'install ok installed'
test -n "$restarted_pid"
xwininfo -id "$window" | grep -F 'Map State: IsViewable'
test "$(cat "$profile/ota-smoke-marker")" = "$marker"
printf 'FineShell 0.5.0 -> 0.5.1: the installed binary relaunched and the test data marker survived.\n'
