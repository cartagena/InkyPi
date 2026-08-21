#!/usr/bin/env bash
# boot_verify_image.sh — boot a Pi OS image under qemu and assert it reaches a
# login prompt.
#
# Used by the `verify-boot` job in .github/workflows/build-pi-image.yml
# (JTN-533) and runnable by hand, which is the point: the boot arguments are
# fiddly enough that a 25-minute CI round trip is a bad way to iterate on them.
#
#   ./scripts/boot_verify_image.sh path/to/inkypi-1.0.2-pi-zero-2-w.img.xz
#   ./scripts/boot_verify_image.sh --help
#
# Accepts a .img or .img.xz. Needs qemu-system-arm, xz-utils, and sudo for the
# loop-mount used to read the boot partition.
#
# How it boots, and why:
#
#   qemu's raspi machines do not run the Raspberry Pi firmware, so nothing
#   reads config.txt/cmdline.txt off the boot partition — the kernel, DTB and
#   command line have to be handed to qemu directly. We pull all three out of
#   the image so the test exercises the shipped kernel and the shipped root=
#   rather than substitutes.
#
#   -M raspi3b, because the Pi Zero 2 W is a BCM2710 — the same core. A generic
#   `virt` machine would need a foreign distro kernel plus an initramfs (distro
#   arm64 kernels build virtio_blk as a module, so with no initrd the rootfs
#   never mounts) and would prove nothing about kernel8.img.
#
#   Both UARTs are captured. qemu wires serial_hd(0) to the PL011 (ttyAMA0) and
#   serial_hd(1) to the mini UART (ttyS0); on a Pi 3 the PL011 is dedicated to
#   Bluetooth and the DTB points the console at the mini UART. Attaching only
#   one of them yields a completely silent boot.
set -euo pipefail

TIMEOUT="${BOOT_VERIFY_TIMEOUT:-600}"
WORKDIR="${BOOT_VERIFY_WORKDIR:-.boot-verify}"
KEEP_RUNNING=0

usage() {
    cat <<'USAGE'
Usage: boot_verify_image.sh [options] <image.img|image.img.xz>

Boots the image under qemu-system-aarch64 (-M raspi3b) and waits for a
login prompt on either UART.

Options:
  -t, --timeout SECONDS   Boot budget (default 600, or $BOOT_VERIFY_TIMEOUT)
  -w, --workdir DIR       Scratch directory (default .boot-verify)
  -k, --keep              Leave qemu running on success for manual poking
  -h, --help              This message

Exit status is 0 if a login prompt appeared, 1 otherwise. On failure both
UART logs are printed.

Environment:
  GITHUB_OUTPUT   If set, "verified=true|false" is appended to it.
USAGE
}

IMAGE=""
while [ $# -gt 0 ]; do
    case "$1" in
        -t|--timeout) TIMEOUT="$2"; shift 2 ;;
        -w|--workdir) WORKDIR="$2"; shift 2 ;;
        -k|--keep)    KEEP_RUNNING=1; shift ;;
        -h|--help)    usage; exit 0 ;;
        -*)           echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
        *)            IMAGE="$1"; shift ;;
    esac
done

if [ -z "${IMAGE}" ]; then
    echo "ERROR: no image given" >&2
    usage >&2
    exit 2
fi
if [ ! -f "${IMAGE}" ]; then
    echo "ERROR: no such file: ${IMAGE}" >&2
    exit 2
fi

for tool in qemu-system-aarch64 xz losetup truncate; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
        echo "ERROR: ${tool} not found." >&2
        echo "  Debian/Ubuntu: sudo apt-get install -y qemu-system-arm xz-utils" >&2
        exit 2
    fi
done

IMAGE=$(readlink -f "${IMAGE}")
mkdir -p "${WORKDIR}"
cd "${WORKDIR}"

banner() {
    echo ""
    echo "======================================================================"
    echo "  $1"
    echo "======================================================================"
}

# ── decompress ────────────────────────────────────────────────────────────────
banner "Preparing image"
case "${IMAGE}" in
    *.xz)
        IMG="$(basename "${IMAGE%.xz}")"
        if [ ! -f "${IMG}" ]; then
            echo "Decompressing $(basename "${IMAGE}") ..."
            xz -dc -T 0 "${IMAGE}" > "${IMG}"
        else
            echo "Reusing already-decompressed ${IMG}"
        fi
        ;;
    *)
        IMG="$(basename "${IMAGE}")"
        [ -f "${IMG}" ] || cp --sparse=always "${IMAGE}" "${IMG}"
        ;;
esac

# ── extract kernel, dtb, cmdline from the boot partition ──────────────────────
LOOP=$(sudo losetup --show -Pf "${IMG}")
cleanup_loop() {
    sudo umount ./mnt-boot 2>/dev/null || true
    sudo losetup -d "${LOOP}" 2>/dev/null || true
}
trap cleanup_loop EXIT
mkdir -p ./mnt-boot
sudo mount "${LOOP}p1" ./mnt-boot
# Pi OS Lite arm64 boots kernel8.img; bcm2710-rpi-3-b.dtb is the DTB matching
# the machine qemu emulates.
sudo cp ./mnt-boot/kernel8.img ./kernel8.img
sudo cp ./mnt-boot/bcm2710-rpi-3-b.dtb ./boot.dtb
sudo cp ./mnt-boot/cmdline.txt ./cmdline.txt
sudo chown "$(id -u):$(id -g)" kernel8.img boot.dtb cmdline.txt
sudo umount ./mnt-boot
sudo losetup -d "${LOOP}"
trap - EXIT

echo "Shipped cmdline.txt:"
cat cmdline.txt

# Rewrite only the console arguments; root= and everything else are kept
# verbatim so a broken root= or fstab still fails the test.
#
# Every console= has to go, not just console=serial0. serial0 is a Pi firmware
# alias the kernel does not understand (the firmware resolves it before boot,
# and qemu runs no firmware). And the kernel gives /dev/console to the LAST
# console=, so leaving Pi OS's trailing console=tty1 in place would put getty
# on the virtual terminal, where no serial log can see it.
#
# `quiet` goes too — on failure the kernel log is the diagnostic. So does the
# firstboot init=: it reboots partway through to resize the rootfs, which a log
# scraper cannot tell apart from a hang.
CMDLINE=$(tr -d '\n' < cmdline.txt \
    | sed -E 's/console=[^ ]*//g
              s#init=/usr/lib/raspberrypi-sys-mods/firstboot##g
              s/(^| )quiet( |$)/ /g
              s/  +/ /g
              s/^ //; s/ $//')
# earlycon writes straight to the PL011 MMIO window before any device probing,
# so a silent boot can be told apart from a console that never bound.
CMDLINE="${CMDLINE} earlycon=pl011,0x3f201000"
# systemd-getty-generator spawns a getty on every console the kernel registers,
# so naming both puts a login prompt on whichever UART is live.
CMDLINE="${CMDLINE} console=ttyAMA0,115200 console=ttyS0,115200"
echo "Boot cmdline: ${CMDLINE}"

# ── pad to a power of two ─────────────────────────────────────────────────────
# qemu's raspi machines emulate a real SD controller and reject any card whose
# size is not a power of two. pishrink deliberately leaves the image at its
# minimum size, so pad a copy. The source image is left untouched.
BYTES=$(stat -c %s "${IMG}")
SD_BYTES=1
while [ "${SD_BYTES}" -lt "${BYTES}" ]; do
    SD_BYTES=$((SD_BYTES * 2))
done
cp --sparse=always "${IMG}" sd.img
truncate -s "${SD_BYTES}" sd.img
echo "Padded $(numfmt --to=iec "${BYTES}") image to $(numfmt --to=iec "${SD_BYTES}") SD card"

# ── boot ──────────────────────────────────────────────────────────────────────
banner "Booting (budget ${TIMEOUT}s, no KVM — every instruction is emulated)"
: > uart-pl011.log
: > uart-mini.log
: > qemu-stderr.log

# Redirect rather than pipe: in a pipeline $! is the last element, so the kill
# below would hit the wrong process and leave qemu orphaned.
timeout "${TIMEOUT}" qemu-system-aarch64 \
    -M raspi3b \
    -m 1024 \
    -kernel kernel8.img \
    -dtb boot.dtb \
    -drive file=sd.img,format=raw,if=sd \
    -append "${CMDLINE}" \
    -serial file:uart-pl011.log \
    -serial file:uart-mini.log \
    -display none \
    -no-reboot \
    > qemu-stderr.log 2>&1 &
QPID=$!

dump_logs() {
    for f in uart-pl011.log uart-mini.log qemu-stderr.log; do
        echo "----- ${f} ($(wc -c < "${f}" 2>/dev/null || echo 0) bytes) -----"
        tail -200 "${f}" 2>/dev/null || true
    done
    echo "----------------------------------------"
}

record() {
    [ -n "${GITHUB_OUTPUT:-}" ] && echo "verified=$1" >> "${GITHUB_OUTPUT}"
    return 0
}

fail() {
    echo ""
    echo "FAIL: $1"
    dump_logs
    kill -9 "${QPID}" 2>/dev/null || true
    record false
    exit 1
}

for i in $(seq 1 "${TIMEOUT}"); do
    # Either UART satisfies the gate — the question is whether the image boots,
    # not which serial port it lands on.
    if grep -qh "login:" uart-pl011.log uart-mini.log 2>/dev/null; then
        echo ""
        echo "PASS: login prompt observed at ${i}s"
        dump_logs
        record true
        if [ "${KEEP_RUNNING}" -eq 1 ]; then
            echo "qemu left running as pid ${QPID} (--keep); kill it when done."
        else
            kill -9 "${QPID}" 2>/dev/null || true
        fi
        exit 0
    fi
    # If qemu is gone we will never see a login prompt, so stop now rather than
    # burning the whole budget and reporting a misleading timeout. A startup
    # failure (bad romfile, bad machine type) dies in well under a second.
    if ! kill -0 "${QPID}" 2>/dev/null; then
        fail "qemu exited after ${i}s without reaching a login prompt"
    fi
    if [ $((i % 30)) -eq 0 ]; then
        echo "  ${i}s — pl011=$(wc -c < uart-pl011.log)b mini=$(wc -c < uart-mini.log)b"
    fi
    sleep 1
done

fail "timed out after ${TIMEOUT}s — no login: prompt"
