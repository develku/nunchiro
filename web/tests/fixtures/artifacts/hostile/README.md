Hostile artifact fixtures for `web/tests/sandbox.spec.ts`. Each page tries one way out of the sandbox and
reports through `postMessage` what happened. `{{CANARY}}` and `{{CORE}}` are replaced with the ports of two
loopback listeners the spec starts (stand-ins for a local service and the core's API); the spec asserts that
neither ever receives a connection. Remote hosts (`*.nunchiro.test`) never resolve: the spec answers them
through Playwright routes and counts the requests that actually left the page.

`svg-*.svg` (v1b-06) are SVG cards: an inline script, external `href`s (image, xlink, use, paint) and a
`foreignObject` with HTML img, iframe and form. They are served as `text/html` like the app's scheme.
