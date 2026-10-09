#!/bin/sh
# Writes the final page: the built page, then the narration as data URIs,
# then the player. Nothing but sh, cat, tr and base64, so it runs anywhere.
#
#   embed.sh <out.html> <page.html> <player.html> [<section id> <mime> <audio file>]...
set -eu

out=$1
page=$2
player=$3
shift 3

{
  cat "$page"
  printf '\n<script id="lucid-audio-data">window.LUCID_AUDIO={'
  first=1
  while [ "$#" -ge 3 ]; do
    if [ "$first" = 0 ]; then printf ','; fi
    first=0
    printf '"%s":"data:%s;base64,' "$1" "$2"
    base64 < "$3" | tr -d '\n'
    printf '"'
    shift 3
  done
  printf '};</script>\n'
  cat "$player"
} > "$out"
