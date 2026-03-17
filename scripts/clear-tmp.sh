#!/usr/bin/env bash
# Clear /tmp to fix "Insufficient space for shared memory file" and other temp-space issues.
# Run with: sudo bash scripts/clear-tmp.sh
# Safe: removes contents of /tmp but not the directory itself.
set -euo pipefail
echo "Clearing /tmp (current usage: $(df -h /tmp | awk 'NR==2 {print $3 " used, " $4 " avail"}'))..."
# Delete everything under /tmp (mindepth 1 keeps /tmp itself)
find /tmp -mindepth 1 -delete 2>/dev/null || true
echo "Done. /tmp now: $(df -h /tmp | awk 'NR==2 {print $4 " available"}')"
