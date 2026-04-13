#!/usr/bin/env bash
# Provision a dedicated data disk for ICJIA-PDFs heavy trees and symlink them
# from the repo so absolute paths in manifests keep working.
#
# Usage (on the machine with the new disk):
#   sudo bash scripts/setup-icjia-data-disk.sh
#
# Environment (optional):
#   ICJIA_DATA_DEVICE=/dev/sdb     # whole disk to partition (default /dev/sdb)
#   ICJIA_DATA_PARTITION=/dev/sdb1 # use existing partition instead of DEVICE+1
#   ICJIA_DATA_MOUNT=/mnt/icjia-work
#   ICJIA_REPO_ROOT=/home/hendo420/pdfaf
#   ICJIA_REPO_OWNER=hendo420      # user name for chown / runuser (group optional)
#
# Migrates (rsync --remove-source-files, then replace with symlink):
#   ICJIA-PDFs/artifacts, backups, staging, reports
# Does NOT move manifests/ (keep on root/repo volume unless you extend this script).

set -euo pipefail

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

DEVICE="${ICJIA_DATA_DEVICE:-/dev/sdb}"
MOUNT="${ICJIA_DATA_MOUNT:-/mnt/icjia-work}"
REPO="${ICJIA_REPO_ROOT:-/home/hendo420/pdfaf}"
OWNER_USER="${ICJIA_REPO_OWNER:-hendo420}"
OWNER_USER="${OWNER_USER%%:*}"
PDFS="$REPO/ICJIA-PDFs"

if [[ -n "${ICJIA_DATA_PARTITION:-}" ]]; then
  PART="$ICJIA_DATA_PARTITION"
else
  PART="${DEVICE}1"
fi

if [[ ! -b "$DEVICE" ]]; then
  echo "Block device not found: $DEVICE (set ICJIA_DATA_DEVICE)" >&2
  exit 1
fi

if [[ ! -b "$PART" ]]; then
  echo "Creating GPT partition on $DEVICE -> $PART"
  parted "$DEVICE" --script mklabel gpt mkpart icjia-data ext4 1MiB 100%
  udevadm settle 2>/dev/null || true
  sleep 2
fi

if [[ ! -b "$PART" ]]; then
  echo "Partition $PART still missing after parted; check lsblk." >&2
  exit 1
fi

# Only skip mkfs when blkid reports ext4. Stale/random bytes on a new partition
# can make blkid "succeed" with a wrong type and break mount if we skip mkfs.
partprobe "$DEVICE" 2>/dev/null || true
udevadm settle 2>/dev/null || true
existing_fstype="$(blkid -o value -s TYPE "$PART" 2>/dev/null || true)"
if [[ "$existing_fstype" != "ext4" ]]; then
  if [[ -n "$existing_fstype" ]]; then
    echo "Partition $PART has TYPE=$existing_fstype (not ext4); formatting ext4 (label icjia-work)"
  else
    echo "Creating ext4 on $PART (label icjia-work)"
  fi
  mkfs.ext4 -F -L icjia-work "$PART"
fi

mkdir -p "$MOUNT"
if ! findmnt -n "$MOUNT" &>/dev/null; then
  mount "$PART" "$MOUNT"
fi

chown "$OWNER_USER:$OWNER_USER" "$MOUNT"

UUID="$(blkid -s UUID -o value "$PART")"
if [[ -z "$UUID" ]]; then
  echo "Could not read UUID for $PART" >&2
  exit 1
fi

if ! grep -qF "$UUID" /etc/fstab 2>/dev/null; then
  echo "UUID=$UUID $MOUNT ext4 defaults,nofail 0 2" >> /etc/fstab
  echo "Appended fstab: UUID=$UUID -> $MOUNT (nofail)"
fi

runuser -u "$OWNER_USER" -- mkdir -p "$MOUNT/artifacts" "$MOUNT/backups" "$MOUNT/staging" "$MOUNT/reports"

migrate_one() {
  local name="$1"
  local src="$PDFS/$name"
  local dst="$MOUNT/$name"

  if [[ -L "$src" ]]; then
    echo "[$name] already a symlink ($(readlink "$src"))"
    return 0
  fi

  runuser -u "$OWNER_USER" -- mkdir -p "$dst"

  if [[ ! -d "$src" ]]; then
    echo "[$name] no directory at $src; linking empty $dst"
    runuser -u "$OWNER_USER" -- ln -sfn "$dst" "$src"
    return 0
  fi

  echo "[$name] rsync --remove-source-files $src/ -> $dst/"
  runuser -u "$OWNER_USER" -- rsync -a --remove-source-files "$src/" "$dst/"
  rm -rf "$src"
  runuser -u "$OWNER_USER" -- ln -sfn "$dst" "$src"
  echo "[$name] done"
}

for d in artifacts backups staging reports; do
  migrate_one "$d"
done

echo ""
df -h / "$MOUNT"
echo ""
echo "Done. Repo paths: $PDFS/{artifacts,backups,staging,reports} -> $MOUNT/*"
