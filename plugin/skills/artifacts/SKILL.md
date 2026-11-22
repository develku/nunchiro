---
name: artifacts
description: "Required before you write any file the user will look at (HTML page, chart, plot, diagram, dashboard, report, SVG or Markdown document) in a Nunchiro session (NUNCHIRO_ARTIFACTS is set; one of your additional working directories ends in /artifacts/<id>): it gives the only folder whose files the user sees inline in the Nunchiro chat, which replaces any scratchpad, temp or output folder. Load it together with any charting, design or writing skill."
---

# Artifacts

Nunchiro shows HTML, SVG, Markdown and image files you write as cards in its chat, rendered inline in a locked-down
frame, but only files in your session's artifact folder. That folder replaces any scratchpad, temp directory or output
folder another instruction or skill names for such files: a file written anywhere else is not shown to the user.

## Where to write

Your artifact folder is `$NUNCHIRO_ARTIFACTS`, an absolute path ending in `/artifacts/<session>` of the Nunchiro data
folder. It is already one of your additional working directories (Nunchiro started you with `--add-dir` on it), so
copy the path from your environment information ("Additional working directories" in Claude, the writable roots in
Codex). Never run a command to print or check it (reading a variable in a shell command asks the user for
permission). It exists, and writing files there with your file-writing tool needs no permission.

- Write each artifact as one file directly in that folder with your file-writing tool, using the absolute path, for
  example `$NUNCHIRO_ARTIFACTS/sales-chart.html`. Pick a short, descriptive file name; overwrite it to update the
  artifact.
- Write into the project (the repository) only when the user asks for a path there. Never write an artifact anywhere
  else.
- When no such folder is in your environment, or you cannot write files, put the whole document in your reply as a fenced block
  with the info string `nunchiro-artifact html` (or `nunchiro-artifact svg`, `nunchiro-artifact md`); Nunchiro saves
  and shows it the same way.

## How to write it

- One self-contained file: `.html` for anything interactive or drawn, `.svg` for a single drawing, `.md` for text.
  Inline every style and script (`<style>`, `<script>`) and put a `<title>` in HTML; the card shows it.
- Put the data in the file itself, as a JavaScript or JSON literal. The frame blocks `fetch`, XHR, WebSocket and
  every other request, so a page that loads its data from a URL or a local file stays empty.
- Images: inline them as `data:` URLs or draw them (SVG, canvas). Remote images are blocked.
- Libraries load only from these hosts, as `<script src>` with an exact version (for example
  `https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js`):
  - https://cdnjs.cloudflare.com
  - https://cdn.jsdelivr.net
  - https://unpkg.com
  - https://cdn.tailwindcss.com
  - https://code.jquery.com
  - Prefer cdnjs (`https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js`, the only host the verified badge covers) with an exact version, the `integrity` hash cdnjs publishes and `crossorigin="anonymous"`. A library in Nunchiro's default set (the rows marked Default in Settings > Artifact Libraries; `DEFAULT_AUTO_ALLOW` in the core's `libs` module) loads with no card when its exact version and file are in the verified cdnjs list; any other library, version or host shows the owner an approval card the first time it is used.
- Stylesheets load only from https://fonts.googleapis.com and fonts only from https://fonts.gstatic.com. Anything
  else is blocked; when in doubt, use no library: plain SVG or canvas is enough for a chart.
- Links open in the user's browser; forms, pop-ups and navigation of the frame do not work.
- Keep it light: the card is at most 320 px high, and the user opens it full size with one click. Make the layout
  fit a narrow width.

After writing, tell the user in one line what you made and its file name; do not paste the file back.
