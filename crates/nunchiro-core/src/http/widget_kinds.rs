//! The widget kinds the window offers (ticket V1B-28): a new widget adds one name here.
/// v1b-28: the one Rust list of widget kinds, in drawer order: layout.toml checks, its header and
/// `nunchiro layout --help` are built from it, so layout.rs and the CLI do not change per widget.
/// web/src/layout/registry.tsx names the same kinds (a test in layout.rs and web/tests/registry.spec.ts
/// fail when they drift).
pub const WIDGET_KINDS: &[&str] = &[
    "tree",
    "agents",
    "waiting",
    "terminal",
    "composer",
    "diff",
    "files",
    "board",
    "search",
    "preview",
    "artifacts",
    "decisions",
    "room", // ticket 990
];
