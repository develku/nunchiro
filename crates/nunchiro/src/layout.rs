// v1a-07b: `nunchiro layout <command>`. The words go to a connected window, which runs them exactly as its edit
// command line does (web/src/layout/command.ts), so the CLI and the GUI write the same layout.toml.
use nunchiro_core::api::*;
use std::path::Path;

// v1b-28: the widget list comes from the core's one list.
fn help() -> String {
    format!("nunchiro layout split <up|down|left|right> <widget> [--pin SESSION] [--zone ZONE] [--size PX]
nunchiro layout stack <widget> [--pin SESSION] [--zone ZONE]
nunchiro layout edge <up|down|left|right> <widget> [--pin SESSION]
nunchiro layout add <widget> [--pin SESSION]
nunchiro layout move <zone> split <dir>|stack|edge <dir> [--zone ZONE] [--tab N]
nunchiro layout remove <widget> | remove --zone ZONE [--tab N]
nunchiro layout pin <session> [--zone ZONE] [--tab N] | unpin [--zone ZONE] [--tab N]
nunchiro layout resize <zone> <px> | reset | undo
Widgets: {}. Needs an open Nunchiro window; layout.toml is in NUNCHIRO_HOME.", nunchiro_core::http::WIDGET_KINDS.join(", "))
}

pub fn run(home: &Path, args: &[String]) -> Result<(), String> {
    if args.is_empty() || args == ["--help"] {
        println!("{}", help());
        return Ok(());
    }
    if !home.join("core.sock").exists() {
        return Err(format!(
            "no Nunchiro core is running, so no window is open: start Nunchiro, or edit {} by hand",
            home.join("layout.toml").display()
        ));
    }
    let reply = super::call(
        home,
        Request::Layout {
            args: args.to_vec(),
        },
    )?;
    println!(
        "{}",
        serde_json::to_string(&reply).map_err(|e| e.to_string())?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    // v1b-28: pinned before the kinds moved to one shared list; the help must stay byte-equal.
    #[test]
    fn layout_help_lists_the_same_widgets() {
        assert_eq!(
            super::help(),
            "nunchiro layout split <up|down|left|right> <widget> [--pin SESSION] [--zone ZONE] [--size PX]
nunchiro layout stack <widget> [--pin SESSION] [--zone ZONE]
nunchiro layout edge <up|down|left|right> <widget> [--pin SESSION]
nunchiro layout add <widget> [--pin SESSION]
nunchiro layout move <zone> split <dir>|stack|edge <dir> [--zone ZONE] [--tab N]
nunchiro layout remove <widget> | remove --zone ZONE [--tab N]
nunchiro layout pin <session> [--zone ZONE] [--tab N] | unpin [--zone ZONE] [--tab N]
nunchiro layout resize <zone> <px> | reset | undo
Widgets: tree, waiting, terminal, composer, diff, files, board, search, preview, artifacts, decisions, room, context. Needs an open Nunchiro window; layout.toml is in NUNCHIRO_HOME."
        );
    }
}
