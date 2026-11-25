#!/bin/sh
# Ticket 477: the contact sheet for web/tests/themes-sweep.spec.ts. One row per screen, dark and light side by side,
# with the name; images are relative paths, so the page loads nothing from outside its folder.
# Ticket 499: the catalogue themes follow, one shot per row. With a before folder (a SWEEP_OUT run before a fix), a
# screen whose shot changed gets a second row with the before shots, so each fix shows before and after.
# Usage: scripts/sweep-sheet.sh [folder] [before-folder]   (default .scratch/sweep; writes <folder>/index.html)
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
dir=${1:-$root/.scratch/sweep}
before=${2:-}
[ -d "$dir/dark" ] || { echo "sweep-sheet: no $dir/dark; run (in web/) PW_OPT_IN=shots pnpm exec playwright test tests/themes-sweep.spec.ts --project=shots" >&2; exit 2; }
# The before shots are copied next to the sheet, so its links stay relative.
if [ -n "$before" ]; then
  rm -rf "$dir/before"
  mkdir -p "$dir/before"
  cp -R "$before/dark" "$before/light" "$dir/before/"
fi
out=$dir/index.html
img() { printf '<a href="%s"><img src="%s" alt="%s"></a>' "$1" "$1" "$2"; }
{
  cat <<'EOF'
<!doctype html><html><head><meta charset="utf-8"><title>Themes sweep</title>
<style>body{margin:16px;font:14px system-ui;background:#888;color:#111}h2{margin:24px 0 6px}.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.row.was{opacity:.85;margin-top:8px}.row.was::before{content:"before";grid-column:1/-1;font-weight:600}img{width:100%;border:1px solid #333;display:block}</style>
</head><body><h1>Themes sweep: dark | light</h1>
EOF
  for f in $(cd "$dir/dark" && ls *.png | sort -V); do
    name=${f%.png}
    printf '<h2 id="%s">%s</h2><div class="row">' "$name" "$name"
    img "dark/$f" "$name dark"
    if [ -f "$dir/light/$f" ]; then img "light/$f" "$name light"; else printf '<p>no light shot</p>'; fi
    printf '</div>\n'
    if [ -n "$before" ] && [ -f "$dir/before/dark/$f" ] && [ -f "$dir/before/light/$f" ] &&
      ! { cmp -s "$dir/dark/$f" "$dir/before/dark/$f" && cmp -s "$dir/light/$f" "$dir/before/light/$f"; }; then
      printf '<div class="row was">'
      img "before/dark/$f" "$name dark before"
      img "before/light/$f" "$name light before"
      printf '</div>\n'
    fi
  done
  if [ -d "$dir/catalogue" ]; then
    echo '<h1>Catalogue themes</h1>'
    for f in $(cd "$dir/catalogue" && ls *.png | sort -V); do
      name=${f%.png}
      printf '<h2 id="catalogue-%s">%s</h2>' "$name" "$name"
      img "catalogue/$f" "$name"
      printf '\n'
    done
  fi
  echo '</body></html>'
} >"$out"
echo "$out"
