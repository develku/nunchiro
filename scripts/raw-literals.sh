#!/bin/sh
# Raw-literal ratchet counts (FIDELITY residue, ticket 63): per file under web/src (or $1), one "kind path count" line
# for raw hex colours (hex), colour functions rgb(, rgba(, hsl( and hsla( (col), font-size px (fs), em (fsem) and rem (fsrem) values, border-radius px values and box-shadow
# literals. tokens.css is the one place those live and is skipped. Text patterns only; this also sees a literal
# assigned in code (`el.style.fontSize = '13px'`, a hex inside a template string).
# shortcut: a value assembled from variables (`${n}px`, `fontSize: size`) has no literal in the text and is not
# counted; upgrade to a TS-AST or computed-style scan if such a value starts to carry design values.
# shortcut: a bare TS `borderRadius: 0.5` (leading zero, no unit) is not counted, while CSS `border-radius: 0.5px` and
# `fontSize: 0.5` are; upgrade when a design value below 1px, such as a hairline radius, needs a token.
# shortcut: `col` counts the four function names in text (a comment or string that spells one counts too), and a colour
# function assembled from parts (`${fn}(...)`) is not seen; upgrade to a CSS/TS parse if either starts to matter.
set -u
src=${1:-$(cd "$(dirname "$0")/.." && pwd)/web/src}
cd "$src" || exit 2
find . -type f \( -name '*.css' -o -name '*.ts' -o -name '*.tsx' \) ! -path ./tokens.css | sed 's|^\./||' | LC_ALL=C sort | while read -r f; do
  # a hex value follows ':', '(', ',', a space or a quote; a rule line ending in '{' is a selector, not a value
  hex=$(grep -vE '\{[[:space:]]*$' "$f" | grep -oE "[:(,\` '\"]#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b" | wc -l)
  col=$(grep -oiE "(^|[^a-zA-Z0-9_-])(rgba?|hsla?)\(" "$f" | wc -l)
  # a zero is no literal worth a token: only a non-zero px value (a bare number in TS) counts
  # the unit of each font-size literal: CSS `font-size: 13px`, TS `fontSize: 12`, `fontSize: '1rem'` or `fontSize = '13px'`; a bare TS number is px
  units=$(grep -oE "(font-size[[:space:]]*:|fontSize['\"]?[[:space:]]*[:=])[[:space:]]*['\"]?[0-9.]*[1-9][0-9.]*[a-z%]*" "$f" | sed -E 's/.*[0-9.]([a-z%]*)$/\1/; s/^$/px/')
  fs=$(printf '%s' "$units" | grep -cx 'px')
  fsem=$(printf '%s' "$units" | grep -cx 'em')
  fsrem=$(printf '%s' "$units" | grep -cx 'rem')
  rad=$(grep -oE "(border(-[a-z]+)*-radius[[:space:]]*:[^;}]*[1-9][0-9.]*px|borderRadius['\"]?[[:space:]]*[:=][[:space:]]*['\"]?[1-9])" "$f" | wc -l)
  sh=$(grep -E "(box-shadow|boxShadow)['\"]?[[:space:]]*[:=]" "$f" | grep -vE "(box-shadow|boxShadow)['\"]?[[:space:]]*[:=][[:space:]]*['\"]?(none|var\(--[a-z-]+\))['\"]?[;,]?[[:space:]]*$" | wc -l)
  for k in hex col fs fsem fsrem rad sh; do eval "n=\$((\$$k + 0))"; [ "$n" -gt 0 ] && echo "$k $f $n"; done
done
exit 0
