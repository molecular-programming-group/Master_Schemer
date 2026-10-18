#!/bin/sh
# Contact sheet of a dry run's snapshots: sheet.sh <dry-dir> <out.png> [skip-first-N]
ls "$1"/*.png | tail -n +$((${3:-0} + 1)) | head -16 | sed "s/^/file '/; s/$/'/" > "$2.txt"
ffmpeg -v error -y -f concat -safe 0 -i "$2.txt" -vf "scale=400:-1,tile=4x4:padding=4" -frames:v 1 "$2"
rm -f "$2.txt"
