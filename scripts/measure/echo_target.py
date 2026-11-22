"""PTY-side timestamping echo (ticket 11 latency target). argv: <log>
Runs inside a Nunchiro shell session: raw mode (no kernel echo, like an agent TUI), writes back every byte it
reads and logs `<monotonic_ns> <hex>` per read so the input leg (window send -> PTY read) can be split out."""
import os, sys, time, tty

log = open(sys.argv[1], "a", buffering=1)
tty.setraw(0)
os.write(1, b"ECHO_READY\r\n")
while True:
    b = os.read(0, 4096)
    if not b or b == b"\x04":
        break
    log.write(f"{time.monotonic_ns()} {b.hex()}\n")
    os.write(1, b)
