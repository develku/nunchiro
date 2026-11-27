// Settings > Plugins (features/plugins.tsx), the plugin permission sheet and plugin commands in the palette. English only for now.
declare module '../index' {
  interface AreaKeys {
    'field.plugins': true;
    'searchWords.plugins': true;
    'plugins.title': true;
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
  }
}

export const en = {
  "field.plugins": "Plugins",
  "searchWords.plugins": "plugins, extensions, add-ons, panels, commands",
  "plugins.title": "Plugins",
  "plugins.desc": "Folders that add panels, commands and settings. Nothing in one runs until you review it and turn it on.",
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
};
