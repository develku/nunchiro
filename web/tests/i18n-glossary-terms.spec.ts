// Ticket 527: the whole catalogue uses the docs/i18n-terms.md term. Each old term below is counted per language and must be 0,
// except in the kept keys, each with its reason. A new line that brings an old term back fails here, naming the key.
import { expect, test } from '@playwright/test';
import { TABLES } from './i18n-tables';

type Lang = 'ko' | 'ja' | 'zh-Hans' | 'zh-Hant' | 'es' | 'fr' | 'pt';
type OldTerm = { lang: Lang; term: string; re: RegExp; keys?: RegExp; kept?: Record<string, string> };

const notLetter = '(?<![\\p{L}])';
const end = '(?![\\p{L}])';

// "Key" meaning a data, SSH, API or host key, not a key on the keyboard: fr clé, es clave and pt chave stay on these lines.
const DATA_KEYS: Record<string, string> = {
  'agents.sheet.canDoBody': 'API key',
  'searchWords.envStripSecrets': 'API key (ticket 1008)',
  'approval.homeWide': "the agent's keys (credentials)",
  'board.edit.lane': 'a lane key in the board file (data)',
  'machines.addNote': 'SSH host key',
  'machines.confirm': 'SSH key files',
  'machines.keys': 'SSH keys',
  'machines.hostKey': 'SSH host key',
  'machines.ssh.key': 'SSH key (ticket 991 C6)',
  'machines.ssh.hostKey': 'SSH host key (ticket 991 C6)',
  'projects.clone.ssh': 'SSH key',
  'acpLogin.whatIn': 'a stored credential',
  'providers.groupKeys': 'API key services',
  'palette.kw.providers.signin': 'API key, the palette words for the API key services (ticket 780)',
  'providers.envNote': 'an API key in the environment',
  'providers.howToLine': 'the API key placeholder for launchctl setenv',
  'settings.row.maskDesc': 'secret key names in terminal history',
};

// Common usted imperatives; lowercase forms also catch a subjunctive, which the kept keys below name.
const USTED = 'elija|escoja|marque|verifique|compruebe|revise|seleccione|haga|introduzca|ingrese|escriba|pulse|presione|abra|'
  + 'intente|inténtelo|vuelva|instale|ejecute|agregue|añada|use|utilice|asegúrese|inicie|elimine|quite|cambie|defina|permita|'
  + 'active|desactive|copie|conecte|mueva|guarde|busque|pruebe|reinicie|actualice|mantenga|envíe|lea|usted';
const USTED_KEPT: Record<string, string> = {
  'problem.cause.acpRefused': 'env var name: "CLAUDE_CODE_USE_BEDROCK" (ticket 604)',
  'leftovers.card.text.missing': 'subjunctive: "Pide al agente que lo escriba"',
  'leftovers.card.text.outside': 'subjunctive: "Pide al agente que lo guarde"',
  'setupScripts.cleanupDesc': 'subjunctive: "antes de que Nunchiro elimine un worktree" (ticket 259)',
  'browserPane.failWaiting': 'subjunctive: "cuando se inicie el servidor"',
  'chat.empty.hint': 'subjunctive: "lo que quieres que haga el agente"',
  'widget.netOnTip': 'subjunctive: "hasta que este artefacto cambie"',
  'widget.netOffTip': 'subjunctive: "hasta que cambie"',
  'extView.when.PreToolUse': 'subjunctive: "Antes de que el agente use"',
  'acpLogin.whatAgent': 'subjunctive: "pide a {name} que inicie"',
  'orch.example2': 'subjunctive: "Haz que Codex escriba"',
  'settings.desc.orchestration': 'subjunctive: "Permite que un agente reparta … y luego revise"',
  'settings.desc.browser': 'subjunctive: "Permite que un navegador … abra Nunchiro"',
};

const STALE_KEYS = /stale|^tree\.strip\.y$|^board\.strip\.hint$/;

const OLD_TERMS: OldTerm[] = [
  { lang: 'zh-Hans', term: '标签页 (Tab is 选项卡)', re: /标签页/u },
  { lang: 'zh-Hans', term: '智能体 (Agent is 代理)', re: /智能体/u },
  { lang: 'zh-Hant', term: '分頁 (Tab is 選項卡)', re: /分頁/u },
  {
    lang: 'zh-Hant', term: '代理程式 (Agent is 代理)', re: /代理程式/u,
    kept: {
      'providers.groupAgents': 'the English heading is "Agent programs"; zh-Hans says 代理程序',
    },
  },
  { lang: 'ja', term: 'フォルダ without ー (フォルダー)', re: /フォルダ(?!ー)/u },
  { lang: 'ja', term: 'ウインドウ (ウィンドウ)', re: /ウインドウ/u },
  {
    lang: 'es', term: 'quotes other than “ ” («», ASCII ", ‘’)', re: /[«»"‘]/u,
    kept: { 'settings.err.folderDots': 'quotes the literal path token ".." as English does' },
  },
  { lang: 'es', term: 'Acceso for Log in (iniciar sesión)', re: /^Acceso$/u },
  { lang: 'pt', term: 'Iniciar ao entrar for Start at login (login is the noun)', re: /ao entrar/iu },
  {
    lang: 'es', term: 'clave for a keyboard key (tecla)', re: /(?<![\p{L}])claves?(?![\p{L}])/iu,
    kept: { ...DATA_KEYS },
  },
  {
    lang: 'es', term: 'usted imperatives (the catalogue says tú)', re: new RegExp(`${notLetter}(${USTED})${end}`, 'iu'),
    kept: USTED_KEPT,
  },
  {
    lang: 'fr', term: 'tu/toi/ton/ta/tes/te (vous on lines shown to the user)',
    re: new RegExp(`${notLetter}(tu|toi|ton|ta|tes|te|t['’])${end}|-toi${end}`, 'iu'),
    kept: {
      'gitActions.prompt.pull': 'a prompt Nunchiro sends to the agent, not a line shown as UI text; its siblings use the same form',
      'orch.example2': 'an example of what the user says to an agent, like orch.example1 and orch.example3',
    },
  },
  { lang: 'fr', term: 'clé de type (Kind key is touche de type)', re: /clés? de type/iu },
  { lang: 'fr', term: 'clé for a keyboard key (touche)', re: /(?<![\p{L}])clés?(?![\p{L}])/iu, kept: DATA_KEYS },
  { lang: 'fr', term: 'arbre for the Tree (arborescence; arbre de travail is the worktree)', re: /(?<![\p{L}])[aA]rbres?(?![\p{L}])(?! de travail)/u },
  // Q6 C8: one word for "stale" (a session or card with no output or move for a while): ko 멈춤, es estancada.
  { lang: 'ko', term: '오래된/오래됨 for stale (멈춤)', re: /오래/u, keys: STALE_KEYS },
  { lang: 'es', term: 'parada/desactualizado for stale (estancada)', re: /parad|desactualiz|sin actualizar/iu, keys: STALE_KEYS },
  { lang: 'pt', term: 'Conecte-se for Log in (Entrar)', re: /Conecte-se/u },
  { lang: 'pt', term: 'chave for a keyboard key (tecla)', re: /(?<![\p{L}])chaves?(?![\p{L}])/iu, kept: DATA_KEYS },
  { lang: 'pt', term: 'chave de tipo (Kind key is tecla de tipo)', re: /chaves? de tipo/iu },
  {
    lang: 'pt', term: 'Ajustes for Nunchiro settings (Configurações; Ajustes do Sistema is macOS)', re: /[aA]justes(?! do Sistema)/u,
    kept: {
      'rest.shell.perm.openSettings': 'opens macOS System Settings (Files and Folders), Apple pt-BR "Ajustes"',
      'rest.shell.perm.step1': 'macOS System Settings, Files and Folders, as above',
    },
  },
];

function oldTermHits(tables: Record<string, Record<string, string> | undefined>) {
  return OLD_TERMS.map((o) => {
    const hits = Object.entries(tables[o.lang] ?? {})
      .filter(([key, text]) => (!o.keys || o.keys.test(key)) && o.re.test(text))
      .map(([key]) => key);
    return { ...o, hits, unexpected: hits.filter((k) => !o.kept?.[k]) };
  });
}

test('glossary_old_terms: every old term counts 0 outside its kept keys', () => {
  const rows = oldTermHits(TABLES as Record<string, Record<string, string>>);
  for (const r of rows) {
    console.log(`${r.lang} ${r.term}: ${r.unexpected.length}${r.hits.length > r.unexpected.length ? ` (kept ${r.hits.filter((k) => r.kept?.[k]).join(', ')})` : ''}`);
  }
  expect(rows.flatMap((r) => r.unexpected.map((k) => `${r.lang} ${r.term}: ${k}`))).toEqual([]);
  // A kept key that no longer has the term is a stale allow-list entry.
  expect(rows.flatMap((r) => Object.keys(r.kept ?? {}).filter((k) => !r.hits.includes(k)).map((k) => `${r.lang} ${k}`))).toEqual([]);
});
