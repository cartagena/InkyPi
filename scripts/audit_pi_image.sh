#!/usr/bin/env bash
# audit_pi_image.sh — assert a built Pi image is fit to ship.
#
# Reads the image's filesystems directly with debugfs, so it needs no root and
# no loop device. Runs in seconds, unlike a rebuild.
#
#   ./scripts/audit_pi_image.sh build/inkypi-1.0.2-pi-zero-2-w.img.xz
#   ./scripts/audit_pi_image.sh some.img
#
# Exists because v1.0.2 shipped with the build's own chroot scaffolding still
# inside it — the systemctl/raspi-config stubs on PATH and the builder's
# resolv.conf — and the result could neither join wifi nor resolve DNS. Nothing
# in the pipeline looked at the contents of what it was about to publish.
set -euo pipefail

IMG="${1:-}"
[ -n "${IMG}" ] || { echo "Usage: audit_pi_image.sh <image.img|image.img.xz>" >&2; exit 2; }
[ -f "${IMG}" ] || { echo "ERROR: no such file: ${IMG}" >&2; exit 2; }

command -v debugfs >/dev/null 2>&1 || {
    echo "ERROR: debugfs not found (package e2fsprogs)" >&2; exit 2; }

WORK=""
cleanup() { [ -n "${WORK}" ] && rm -rf "${WORK}"; }
trap cleanup EXIT

case "${IMG}" in
    *.xz)
        WORK=$(mktemp -d)
        echo "Decompressing $(basename "${IMG}") ..."
        xz -dc -T 0 "${IMG}" > "${WORK}/image.img"
        IMG="${WORK}/image.img"
        ;;
esac

# Partition offsets, in bytes. fdisk reads a plain file without root.
# fdisk right-aligns the Start column, so rows can begin with spaces — match on
# the field being numeric rather than on the line starting with a digit.
read -r BOOT_OFF ROOT_OFF <<<"$(
    fdisk -l -o Start,Type "${IMG}" 2>/dev/null \
        | awk '$1 ~ /^[0-9]+$/ {printf "%d ", $1 * 512}'
)"
[ -n "${ROOT_OFF:-}" ] && [ "${ROOT_OFF}" -gt 0 ] || {
    echo "ERROR: could not read partition table from ${IMG}" >&2; exit 2; }

FS="${IMG}?offset=${ROOT_OFF}"
d() { debugfs -R "$1" "${FS}" 2>/dev/null; }

PASS=0
FAIL=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }

# debugfs writes its "File not found" to stderr and nothing to stdout, so a
# missing path yields no Inode line. Matching on Inode rather than on empty
# output means a debugfs error cannot be mistaken for a clean result.
absent() { ! d "stat $1" | grep -q "Inode:"; }

echo ""
echo "Auditing $(basename "${1}")  (rootfs at offset ${ROOT_OFF})"
echo ""
echo "Build scaffolding must not ship:"

for stub in /usr/local/sbin/raspi-config /usr/local/sbin/systemctl; do
    # These shadow the real binaries: /usr/local/sbin precedes both /usr/sbin
    # and /usr/bin in root's PATH, and raspi-config lives in /usr/bin. Stubbed
    # out it never sets the wifi regulatory domain, so the radio stays
    # rfkill-blocked and the Pi joins nothing.
    if absent "${stub}"; then ok "${stub} removed"; else bad "${stub} STILL PRESENT — shadows the real binary on PATH"; fi
done

if absent /usr/bin/qemu-aarch64-static; then ok "qemu-aarch64-static removed"; else bad "qemu-aarch64-static still present (~10 MB of dead weight)"; fi

echo ""
echo "Host configuration must be the image's own:"

RESOLV="$(d "cat /etc/resolv.conf" || true)"
if printf '%s' "${RESOLV}" | grep -qE '127\.0\.0\.53|cloudapp\.net'; then
    bad "/etc/resolv.conf carries the builder's DNS — Pi OS Lite runs no systemd-resolved, so nothing resolves"
else
    ok "/etc/resolv.conf is not the builder's"
fi

MID_SIZE="$(d "stat /etc/machine-id" | sed -n 's/.*Size: \([0-9]*\).*/\1/p' | head -1)"
if [ "${MID_SIZE:-0}" -eq 0 ]; then
    ok "/etc/machine-id blank (each card generates its own)"
else
    bad "/etc/machine-id populated (${MID_SIZE} bytes) — every flashed card shares one identity"
fi

echo ""
echo "First-boot customisation must still work:"

# cmdline.txt lives in the FAT partition; grep the raw region rather than
# implementing a FAT reader. Small files there are contiguous.
# grep -c rather than -q: with -q grep exits on the first match, dd dies of
# SIGPIPE, and pipefail turns that into a false "not found".
CMDLINE_HITS=$(dd if="${IMG}" bs=1M skip=$((BOOT_OFF / 1048576)) count=512 status=none 2>/dev/null \
     | grep -ac 'init=/usr/lib/raspberrypi-sys-mods/firstboot' || true)
if [ "${CMDLINE_HITS:-0}" -gt 0 ]; then
    ok "cmdline.txt still invokes firstboot (custom.toml will be read)"
else
    bad "cmdline.txt lost init=firstboot — custom.toml will be ignored entirely"
fi

if [ -n "$(d "ls /usr/lib/raspberrypi-sys-mods" | tr -s ' \n' '\n' | grep -x init_config || true)" ]; then
    ok "init_config present"
else
    bad "init_config missing — custom.toml cannot be applied"
fi

# firstboot bails out of applying custom.toml without this, and reports it via
# a blocking whiptail msgbox that nobody sees on a headless Pi.
if [ -n "$(d "ls /usr/lib/python3/dist-packages" | tr -s ' \n' '\n' | grep -x toml || true)" ]; then
    ok "python3-toml present (firstboot needs it to parse custom.toml)"
else
    bad "python3-toml missing — firstboot silently refuses to apply custom.toml"
fi

# Pi OS ships raspi-config in /usr/bin, not /usr/sbin. /usr/local/sbin still
# precedes it in root's PATH, which is why the stub shadowed it.
if absent /usr/bin/raspi-config; then
    bad "the real /usr/bin/raspi-config is missing"
else
    ok "real raspi-config present"
fi

echo ""
echo "The installed app must be able to start:"

# install.sh symlinks /usr/local/inkypi/src at the source checkout rather than
# copying it, so the checkout is PART OF THE INSTALL, not build residue. A
# cleanup pass deleted it as if it were leftovers and the service then died on
# every boot with:
#   realpath: /usr/local/inkypi/src/inkypi.py: No such file or directory
LINK_DEST="$(d "stat /usr/local/inkypi/src" | sed -n 's/.*Fast link dest: "\(.*\)".*/\1/p' | head -1)"
if [ -z "${LINK_DEST}" ]; then
    bad "/usr/local/inkypi/src is missing"
else
    # Lexical normalisation only — the path lives inside the image, not here.
    RESOLVED="$(realpath -m "${LINK_DEST}")"
    if absent "${RESOLVED}/inkypi.py"; then
        bad "/usr/local/inkypi/src -> ${LINK_DEST} is DANGLING (no inkypi.py at ${RESOLVED})"
    else
        ok "/usr/local/inkypi/src resolves to a real checkout (${RESOLVED})"
    fi
fi

if absent /usr/local/inkypi/venv_inkypi/bin/python; then
    bad "venv interpreter missing at /usr/local/inkypi/venv_inkypi/bin/python"
else
    ok "venv interpreter present"
fi

if absent /usr/local/bin/inkypi; then
    bad "/usr/local/bin/inkypi launcher missing (ExecStart of inkypi.service)"
else
    ok "inkypi launcher present"
fi

if [ -n "$(d "ls /etc/systemd/system/multi-user.target.wants" | tr -s ' \n' '\n' | grep -x inkypi.service || true)" ]; then
    ok "inkypi.service enabled"
else
    bad "inkypi.service not enabled — it will not start on boot"
fi

echo ""
if [ "${FAIL}" -eq 0 ]; then
    echo "OK — ${PASS} checks passed, image is fit to ship."
    exit 0
fi
echo "FAILED — ${FAIL} problem(s) found, ${PASS} passed. This image should not ship."
exit 1
