#!/bin/sh
set -eu

mode=$1
version=$2
if [ "$mode" = crash ]; then
  exit 7
fi

directory=$RCMAN_UPDATE_HEALTH_DIRECTORY
printf '{"token":"%s","version":"%s"}' "$RCMAN_UPDATE_HEALTH_TOKEN" "$version" > "$directory/ready.json"
remaining=1200
while [ ! -f "$directory/committed" ]; do
  [ "$remaining" -gt 0 ] || exit 8
  remaining=$((remaining - 1))
  sleep 0.05
done

case "$mode" in
  handoff)
    ln "$0" "$3/previous"
    cp "$3/path.json" "$directory/next.json"
    ;;
  wait)
    sleep 30
    ;;
esac
