#!/usr/bin/env bash
# build_pi_image.sh — build the pre-installed InkyPi .img.xz for the Pi Zero 2 W.
#
# Used by the `build-image` job in .github/workflows/build-pi-image.yml
# (JTN-533) and runnable by hand. The workflow calls this script rather than
# repeating the steps inline, so a local build exercises the same code CI does
# — testing a copy would prove nothing about the workflow.
#
#   sudo ./scripts/build_pi_image.sh --tag v1.0.2
#   sudo ./scripts/build_pi_image.sh --tag v1.0.2 --fast   # skip slow xz/zerofill
#   ./scripts/build_pi_image.sh --help
#
# Needs root (loop-mounting and chrooting the image), binfmt registration for
# arm64 (qemu-user-static), and ~12 GB of free disk. Expect ~20-40 minutes:
# install.sh runs fully emulated inside the image.
#
# Everything staged to make the chroot work is removed again before packaging.
# v1.0.2 shipped with the systemctl/raspi-config stubs still on PATH and the
# builder's resolv.conf in place, producing an image that could neither join
# wifi nor resolve DNS; see remove_scaffolding() below.
set -euo pipefail

# --- pins ---------------------------------------------------------------------
# Kept in sync with the PIN POINT block in build-pi-image.yml. The workflow
# exports these, so its values win; the defaults are for local runs.
PI_OS_IMAGE_URL="${PI_OS_IMAGE_URL:-https://downloads.raspberrypi.org/raspios_lite_arm64/images/raspios_lite_arm64-2025-05-13/2025-05-13-raspios-bookworm-arm64-lite.img.xz}"
PI_OS_IMAGE_SHA256="${PI_OS_IMAGE_SHA256:-62d025b9bc7ca0e1facfec74ae56ac13978b6745c58177f081d39fbb8041ed45}"
PI_OS_IMAGE_FILENAME="${PI_OS_IMAGE_FILENAME:-2025-05-13-raspios-bookworm-arm64-lite.img.xz}"
PISHRINK_TAG="${PISHRINK_TAG:-v26.03.16}"
PISHRINK_SHA256="${PISHRINK_SHA256:-71026f0c02ac099e588a3eb8f70760c1b680aa8ea3acde61a0141fbaeb68c777}"

SRC_REPO="${INKYPI_SRC_REPO:-https://github.com/cartagena/InkyPi.git}"
BUILD_DIR="${BUILD_DIR:-build}"
MNT="${MNT:-/mnt/pi-root}"
TAG=""
FAST=0

usage() {
    cat <<'USAGE'
Usage: sudo build_pi_image.sh --tag <release-tag> [options]

Builds inkypi-<version>-pi-zero-2-w.img.xz from the pinned Pi OS Lite base.

Options:
  -t, --tag TAG      Release tag to build from, e.g. v1.0.2 (required)
  -r, --repo URL     Git URL to clone inside the image
                     (default: $INKYPI_SRC_REPO or the cartagena fork)
  -b, --builddir DIR Work directory (default: build)
      --fast         xz -0 instead of -9 and skip the zero-fill. Much faster,
                     much larger output. For iterating, never for a release.
  -h, --help         This message

Requires root, qemu-user-static with arm64 binfmt registered, and ~12 GB free.
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        -t|--tag)      TAG="$2"; shift 2 ;;
        -r|--repo)     SRC_REPO="$2"; shift 2 ;;
        -b|--builddir) BUILD_DIR="$2"; shift 2 ;;
        --fast)        FAST=1; shift ;;
        -h|--help)     usage; exit 0 ;;
        *)             echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

[ -n "${TAG}" ] || { echo "ERROR: --tag is required" >&2; usage >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "ERROR: must run as root (loop-mount + chroot)" >&2; exit 2; }

VERSION="${TAG#v}"

for tool in curl xz truncate parted losetup e2fsck resize2fs chroot sha256sum; do
    command -v "${tool}" >/dev/null 2>&1 || {
        echo "ERROR: ${tool} not found. On Debian/Ubuntu:" >&2
        echo "  apt-get install -y qemu-user-static binfmt-support parted \\" >&2
        echo "      util-linux dosfstools e2fsprogs xz-utils curl ca-certificates" >&2
        exit 2
    }
done
# Without binfmt the chroot cannot execute the image's arm64 binaries, and the
# first command inside it fails with a confusing "Exec format error".
[ -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ] || {
    echo "ERROR: no arm64 binfmt handler registered." >&2
    echo "  apt-get install -y qemu-user-static binfmt-support" >&2
    echo "  (or: docker run --privileged --rm tonistiigi/binfmt --install arm64)" >&2
    exit 2
}
command -v qemu-aarch64-static >/dev/null 2>&1 || {
    echo "ERROR: qemu-aarch64-static not found (package qemu-user-static)" >&2
    exit 2
}

banner() {
    echo ""
    echo "======================================================================"
    echo "  $1"
    echo "======================================================================"
}

LOOP=""
cleanup() {
    # Ordering matters: nested mounts before the ones they sit inside, or the
    # loop device stays busy and the image is left mounted.
    umount "${MNT}/dev/pts" 2>/dev/null || true
    umount "${MNT}/dev" 2>/dev/null || true
    umount "${MNT}/proc" 2>/dev/null || true
    umount "${MNT}/sys" 2>/dev/null || true
    umount "${MNT}/boot/firmware" 2>/dev/null || true
    umount "${MNT}" 2>/dev/null || true
    [ -n "${LOOP}" ] && losetup -d "${LOOP}" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"

# --- base image ---------------------------------------------------------------
banner "Fetching pinned Pi OS Lite base"
if [ ! -f "${PI_OS_IMAGE_FILENAME}" ]; then
    curl -fsSL -o "${PI_OS_IMAGE_FILENAME}" "${PI_OS_IMAGE_URL}"
else
    echo "Reusing ${PI_OS_IMAGE_FILENAME}"
fi
echo "${PI_OS_IMAGE_SHA256}  ${PI_OS_IMAGE_FILENAME}" > base.sha256
sha256sum -c base.sha256

BASE_IMG="${PI_OS_IMAGE_FILENAME%.xz}"
rm -f "${BASE_IMG}"
xz -dk -T 0 "${PI_OS_IMAGE_FILENAME}"

# --- room to install ----------------------------------------------------------
banner "Growing image for the install"
# Pi OS Lite is ~2.5 GB; install.sh adds ~1 GB of venv + apt packages. 3 GB of
# slack keeps pip/apt from hitting ENOSPC. pishrink reclaims it before shipping.
truncate -s +3G "${BASE_IMG}"
parted --script "${BASE_IMG}" resizepart 2 100%

LOOP=$(losetup --show -Pf "${BASE_IMG}")
echo "Loop device: ${LOOP}"
partprobe "${LOOP}" || true
e2fsck -f -y "${LOOP}p2" || true
resize2fs "${LOOP}p2"
mkdir -p "${MNT}"
mount "${LOOP}p2" "${MNT}"
mkdir -p "${MNT}/boot/firmware"
mount "${LOOP}p1" "${MNT}/boot/firmware"
df -h "${MNT}" "${MNT}/boot/firmware"

# --- chroot plumbing ----------------------------------------------------------
banner "Staging chroot"
cp /usr/bin/qemu-aarch64-static "${MNT}/usr/bin/"
mount --bind /dev     "${MNT}/dev"
mount --bind /dev/pts "${MNT}/dev/pts"
mount --bind /proc    "${MNT}/proc"
mount --bind /sys     "${MNT}/sys"
# Keep the image's own resolv.conf — on Pi OS it is a symlink into
# NetworkManager's runtime dir. Restored by remove_scaffolding().
cp -a "${MNT}/etc/resolv.conf" "${MNT}/etc/resolv.conf.build-orig"
cp --remove-destination /etc/resolv.conf "${MNT}/etc/resolv.conf"

# install.sh calls raspi-config and `systemctl start`, neither of which means
# anything in an offline chroot. Shadow them on PATH for the duration only —
# /usr/local/sbin sorts before /usr/sbin. These MUST be removed again before
# packaging; see remove_scaffolding().
STUB_DIR="${MNT}/usr/local/sbin"
mkdir -p "${STUB_DIR}"
cat > "${STUB_DIR}/raspi-config" <<'STUB'
#!/bin/sh
echo "[chroot stub] raspi-config $* — no-op (real raspi-config runs on first boot)"
exit 0
STUB
cat > "${STUB_DIR}/systemctl" <<'STUB'
#!/bin/sh
case "$1" in
  start|stop|restart|reload|is-active|is-enabled|status)
    echo "[chroot stub] systemctl $* — deferred to first boot"
    exit 0
    ;;
  *)
    exec /bin/systemctl "$@"
    ;;
esac
STUB
chmod +x "${STUB_DIR}/raspi-config" "${STUB_DIR}/systemctl"

# --- install ------------------------------------------------------------------
banner "Running install.sh inside the image (emulated — this is the slow part)"
chroot "${MNT}" /usr/bin/env \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    DEBIAN_FRONTEND=noninteractive \
    INKYPI_CI_IMAGE_BUILD=1 \
    /bin/bash -euxo pipefail -c "
      apt-get update
      apt-get install -y --no-install-recommends git ca-certificates
      rm -rf /opt/inkypi-src
      git clone --branch '${TAG}' --depth 1 '${SRC_REPO}' /opt/inkypi-src
      cd /opt/inkypi-src/install
      bash ./install.sh
    "

# --- first-boot instructions --------------------------------------------------
banner "Writing first-boot instructions"
# Raspberry Pi OS does NOT use cloud-init. It customises itself from
# custom.toml via /usr/lib/raspberrypi-sys-mods/init_config, which cmdline.txt
# invokes through `init=/usr/lib/raspberrypi-sys-mods/firstboot`.
cat > "${MNT}/boot/firmware/inkypi-readme.txt" <<'NOTE'
InkyPi pre-installed image (JTN-533)
====================================

This image already has InkyPi installed and enabled. It has NO user
password, NO wifi and NO SSH until you configure it.

Create a file named `custom.toml` next to this one, on this same
(boot) partition, before first boot:

  config_version = 1

  [system]
  hostname = "inkypi"

  [user]
  name = "pi"
  password = "your-password-here"
  password_encrypted = false

  [ssh]
  enabled = true
  password_authentication = true

  [wlan]
  ssid = "YourNetwork"
  password = "your-wifi-password"
  password_encrypted = false
  country = "US"

  [locale]
  keymap = "us"
  timezone = "America/Los_Angeles"

`password_encrypted = false` is required for plaintext passwords in
both sections — it defaults to true, and a plaintext value read as a
hash gives you an account you cannot log into and wifi that never
connects. `country` must be a real ISO country code or the wifi radio
stays blocked.

The file is consumed and deleted during first boot, which then
reboots. After that, visit:
    http://<hostname>.local/
in a browser on the same LAN — the InkyPi web UI will be up.
NOTE

# --- remove everything the build added ----------------------------------------
remove_scaffolding() {
    banner "Removing build scaffolding"
    # The stubs are the serious one. /usr/local/sbin comes BEFORE /usr/sbin in
    # root's PATH, so left behind they shadow the real binaries forever:
    #   * raspi-config becomes a permanent no-op. Pi OS sets the wifi
    #     regulatory domain via `raspi-config nonint do_wifi_country` (from
    #     init_config's set_wlan_country); without it the radio stays
    #     rfkill-blocked and the Pi never joins any network.
    #   * systemctl silently no-ops start/stop/restart/is-active, so anything
    #     asking systemd to act at runtime succeeds without acting.
    rm -f "${MNT}/usr/local/sbin/raspi-config" "${MNT}/usr/local/sbin/systemctl"

    # Restore the image's own resolv.conf. The builder's points at 127.0.0.53,
    # systemd-resolved's stub listener, which Pi OS Lite does not run — so DNS
    # failed on every flashed device.
    if [ -e "${MNT}/etc/resolv.conf.build-orig" ]; then
        mv "${MNT}/etc/resolv.conf.build-orig" "${MNT}/etc/resolv.conf"
    fi

    rm -rf "${MNT}/opt/inkypi-src"

    # Blank machine-id so each flashed card generates its own. dpkg populates
    # it during the chroot run, and a shared id means colliding DHCP leases
    # once more than one device is on a network. Empty is what pi-gen ships.
    truncate -s 0 "${MNT}/etc/machine-id"
    rm -f "${MNT}/var/lib/dbus/machine-id"
}
remove_scaffolding

# --- footprint ----------------------------------------------------------------
banner "Cleaning caches and logs"
chroot "${MNT}" /bin/bash -euxo pipefail -c '
  apt-get clean
  rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
  rm -rf /root/.cache/pip /root/.cache/uv
  rm -rf /tmp/* /var/tmp/*
  find /var/log -type f -exec truncate -s 0 {} +
'
# Last chroot is done, so the x86-side emulator can come out.
rm -f "${MNT}/usr/bin/qemu-aarch64-static"

if [ "${FAST}" -eq 0 ]; then
    dd if=/dev/zero of="${MNT}/ZEROFILL" bs=1M status=progress || true
    rm -f "${MNT}/ZEROFILL"
fi

cleanup
trap - EXIT
LOOP=""

# --- shrink -------------------------------------------------------------------
banner "Shrinking with pishrink ${PISHRINK_TAG}"
curl -fsSL -o pishrink.sh \
    "https://raw.githubusercontent.com/Drewsif/PiShrink/refs/tags/${PISHRINK_TAG}/pishrink.sh"
echo "${PISHRINK_SHA256}  pishrink.sh" > pishrink.sha256
sha256sum -c pishrink.sha256
chmod +x pishrink.sh
./pishrink.sh -s "${BASE_IMG}"

# --- package ------------------------------------------------------------------
banner "Packaging"
IMG_NAME="inkypi-${VERSION}-pi-zero-2-w.img"
mv "${BASE_IMG}" "${IMG_NAME}"
if [ "${FAST}" -eq 1 ]; then
    xz -0 -T 0 -v "${IMG_NAME}"
else
    xz -9 -T 0 -v "${IMG_NAME}"
fi
sha256sum "${IMG_NAME}.xz" > "${IMG_NAME}.xz.sha256"
ls -la "${IMG_NAME}.xz" "${IMG_NAME}.xz.sha256"

# Hand the packaging results to the workflow when running under Actions; the
# verify-boot and attach-release jobs key off these.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
        echo "image_name=${IMG_NAME}.xz"
        echo "image_sha256=$(awk '{print $1}' "${IMG_NAME}.xz.sha256")"
        echo "image_size=$(stat -c %s "${IMG_NAME}.xz")"
        echo "version=${VERSION}"
        echo "tag=${TAG}"
    } >> "${GITHUB_OUTPUT}"
fi

echo ""
echo "Built ${BUILD_DIR}/${IMG_NAME}.xz"
echo "Audit it with:  ./scripts/audit_pi_image.sh ${BUILD_DIR}/${IMG_NAME}.xz"
