// Settings > Plugins (features/plugins.tsx), the plugin permission sheet and plugin commands in the palette. English only for now.
declare module '../index' {
  interface AreaKeys {
    'field.plugins': true;
    'searchWords.plugins': true;
    'plugins.title': true;
    'plugins.changedByLower': true;
    'plugins.changedBy': true;
    'plugins.skipped': true;
    'plugins.sheet.checkStart': true;
    'plugins.sheet.checkSend': true;
    'plugins.sheet.onErrorRefuse': true;
    'plugins.sheet.onErrorAllow': true;
    'plugins.checks.one': true;
    'plugins.checks.other': true;
    'plugins.startAnyway.tip': true;
    'plugins.sheet.check': true;
    'plugins.sheet.net': true;
    'plugins.sheet.noNet': true;
    'plugins.sheet.reads': true;
    'plugins.sheet.noReads': true;
    'plugins.sheet.every': true;
    'plugins.sheet.draft': true;
    'plugins.desc': true;
    'plugins.summary': true;
    'plugins.section': true;
    'plugins.none': true;
    'plugins.panels.one': true;
    'plugins.panels.other': true;
    'plugins.commands.one': true;
    'plugins.commands.other': true;
    'plugins.settings.one': true;
    'plugins.settings.other': true;
    'plugins.state.approved': true;
    'plugins.state.unapproved': true;
    'plugins.state.changed': true;
    'plugins.state.broken': true;
    'plugins.review': true;
    'plugins.reviewAgain': true;
    'plugins.reviewOf': true;
    'plugins.onOf': true;
    'plugins.needs.script': true;
    'plugins.needs.web': true;
    'plugins.settingOf': true;
    'plugins.folder': true;
    'plugins.remove': true;
    'plugins.removeOf': true;
    'plugins.removeAsk': true;
    'plugins.cancel': true;
    'plugins.sheet.kind': true;
    'plugins.sheet.notOurs': true;
    'plugins.sheet.runs': true;
    'plugins.sheet.viewToml': true;
    'plugins.sheet.hideToml': true;
    'plugins.sheet.panel': true;
    'plugins.sheet.command': true;
    'plugins.ran': true;
    'plugins.ranEmpty': true;
    'plugins.drafted': true;
    'plugins.sheet.asked': true;
    'plugins.sheet.added': true;
    'plugins.updated': true;
    'plugins.browse.open': true;
    'plugins.browse.title': true;
    'plugins.browse.lede': true;
    'plugins.browse.loading': true;
    'plugins.browse.install': true;
    'plugins.browse.installOf': true;
    'plugins.browse.update': true;
    'plugins.browse.updateOf': true;
    'plugins.browse.installed': true;
    'plugins.browse.network': true;
    'plugins.browse.noNetwork': true;
  }
}

export const en = {
  "field.plugins": "Plugins",
  "searchWords.plugins": "plugins, extensions, add-ons, panels, commands",
  "plugins.title": "Plugins",
  "plugins.changedByLower": "changed by {name}",
  "plugins.changedBy": "Changed by {name}",
  "plugins.skipped": "{n} of its checks got no time and were skipped since Nunchiro started; those actions went by its on_error.",
  "plugins.sheet.checkStart": "Runs before every new agent session, and can stop it.",
  "plugins.sheet.checkSend": "Runs before every message an agent, a schedule or a token sends: it reads the message and can stop or replace it.",
  "plugins.sheet.onErrorRefuse": "If it fails or does not answer within 5 s, the action is refused.",
  "plugins.sheet.onErrorAllow": "If it fails or does not answer within 5 s, the action goes ahead.",
  "plugins.checks.one": "{n} check",
  "plugins.checks.other": "{n} checks",
  "plugins.startAnyway.tip": "Start it now, past the plugin's check, this once.",
  "plugins.sheet.check": "Check",
  "plugins.sheet.net": "Network: {hosts}",
  "plugins.sheet.noNet": "No network",
  "plugins.sheet.reads": "Reads beyond its project: {paths}",
  "plugins.sheet.noReads": "Reads only its project",
  "plugins.sheet.every": "Every {secs} s",
  "plugins.sheet.draft": "Puts its output in the focused agent's message box as a draft",
  "plugins.desc": "Folders that add panels, commands and settings. Nothing in one runs for you until you review it and turn it on.",
  "plugins.summary": "Plugins",
  "plugins.section": "Your plugins",
  "plugins.none": "No plugins yet. Copy a plugin folder into ~/.nunchiro/plugins, or make one with",
  "plugins.panels.one": "{n} panel",
  "plugins.panels.other": "{n} panels",
  "plugins.commands.one": "{n} command",
  "plugins.commands.other": "{n} commands",
  "plugins.settings.one": "{n} setting",
  "plugins.settings.other": "{n} settings",
  "plugins.state.approved": "Approved",
  "plugins.state.unapproved": "Not approved",
  "plugins.state.changed": "Changed since approval",
  "plugins.state.broken": "Cannot be read",
  "plugins.review": "Review",
  "plugins.reviewAgain": "Review what it runs",
  "plugins.reviewOf": "Review {name}",
  "plugins.onOf": "Turn {name} on",
  "plugins.needs.script": "Its panels and commands need script widgets, which are off (Settings > Layout, Script widgets).",
  "plugins.needs.web": "Its web panel needs web widgets, which are off (web_widgets in settings.json).",
  "plugins.settingOf": "{name}: {label}",
  "plugins.folder": "Folder",
  "plugins.remove": "Remove",
  "plugins.removeOf": "Remove {name}",
  "plugins.removeAsk": "Move this plugin out of the plugins folder?",
  "plugins.cancel": "Cancel",
  "plugins.sheet.kind": "Plugin",
  "plugins.sheet.notOurs": "This plugin is not from Nunchiro. Read what it runs before you turn it on.",
  "plugins.sheet.runs": "Runs",
  "plugins.sheet.viewToml": "View plugin.toml",
  "plugins.sheet.hideToml": "Hide plugin.toml",
  "plugins.sheet.panel": "Panel",
  "plugins.sheet.command": "Command",
  "plugins.ran": "{name}: {text}",
  "plugins.ranEmpty": "{name} ran and printed nothing.",
  "plugins.drafted": "{name} put its output in the message box. Nothing was sent.",
  "plugins.sheet.asked": "asked once, and again when a change asks for more",
  "plugins.sheet.added": "New since you approved it:",
  "plugins.updated": "Its files changed since you approved it; it asks for nothing new, so it stays approved.",
  "plugins.browse.open": "Browse plugins",
  "plugins.browse.title": "Plugin catalogue",
  "plugins.browse.lede": "Nunchiro's plugin catalogue on GitHub. Each file is checked against the catalogue before it is written; an installed plugin is off until you review it.",
  "plugins.browse.loading": "Reading the catalogue…",
  "plugins.browse.install": "Install",
  "plugins.browse.installOf": "Install {name}",
  "plugins.browse.update": "Update",
  "plugins.browse.updateOf": "Update {name}",
  "plugins.browse.installed": "Installed",
  "plugins.browse.network": "reaches {hosts}",
  "plugins.browse.noNetwork": "no network",
};
