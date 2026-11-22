#!/bin/sh
# Fixture command: approval tests assert this file is never executed (it would write the marker).
touch "${NUNCHIRO_FIXTURE_MARKER:-/nonexistent/marker}"
echo '[]'
