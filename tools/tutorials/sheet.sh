#!/bin/sh
# Contact sheet of a dry run's snapshots: sheet.sh <dry-dir> <out.png>
ffmpeg -v error -y -pattern_type glob -i "$1/*.png" -vf "scale=400:-1,tile=4x4:padding=4" -frames:v 1 "$2"
