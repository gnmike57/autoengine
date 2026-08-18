#!/bin/bash
dirs=(
  "/Volumes/Macintosh_HD/Users/user298993/Desktop/automati1-111-portable"
  "/Volumes/Macintosh_HD/Users/user298993/Desktop/automati1-111-portable copy"
  "/Volumes/Macintosh_HD/Users/user298993/Desktop/automati OG"
)

for dir in "${dirs[@]}"; do
  if [ -d "$dir" ]; then
    echo "Cleaning $dir"
    rm -rf "$dir/node_modules"
    rm -rf "$dir/.cloak-profiles"
    rm -rf "$dir/.chrome-dashboard"
    rm -rf "$dir/recordings"
    rm -rf "$dir/playwright-report"
    rm -rf "$dir/test-results"
    rm -rf "$dir/darwin-reports"
    rm -rf "$dir/eliminations"
    rm -rf "$dir/screenshots"
  fi
done
