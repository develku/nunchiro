// v25-mode-list (ticket 285, needs 207; ticket 294 item 3, needs 213): the composer's mode list and the Decisions card's
// full option list. `chat.perm.title` (chat-base.ts) is no longer used: the chip opens the list instead of pressing Shift+Tab.
// `mode.codexStart` (ticket 991, B6 chip): the tooltip of a Codex session's read-only chip.
declare module '../index' {
  interface AreaKeys {
    "mode.list": true;
    "mode.chipTitle": true;
    "mode.manual": true;
    "mode.accept edits": true;
    "mode.plan": true;
    "mode.auto": true;
    "mode.bypass permissions": true;
    "mode.current": true;
    "mode.skipUnavailable": true;
    "mode.skipDisabled": true;
    "mode.skipSetting": true;
    "mode.skipWarn": true;
    "mode.walking": true;
    "mode.rowSkip": true;
    "mode.codexStart": true;
    "decisions.optionsLabel": true;
    "decisions.optionTerminal": true;
  }
}

export const en = {
  "mode.list": "Permission modes",
  "mode.chipTitle": "{mode} · choose a permission mode",
  "mode.manual": "Normal",
  "mode.accept edits": "Accept edits",
  "mode.plan": "Plan",
  "mode.auto": "Auto",
  "mode.bypass permissions": "Bypass permissions",
  "mode.current": "current",
  "mode.skipUnavailable": "Not available in this session. Start a new session to use it.",
  "mode.skipDisabled": "Turned off by your Claude settings (disableBypassPermissionsMode).",
  "mode.skipSetting": "Not available in this session. Change the permission setting and start a new session to use it.",
  "mode.skipWarn": "Bypass permissions is on: no permission prompt will stop this session.",
  "mode.walking": "Switching to {mode}…",
  "mode.rowSkip": "Bypass permissions on",
  "mode.codexStart": "Permission at start: {mode}. Set in Settings > Providers for new sessions.",
  "decisions.optionsLabel": "Options of this prompt",
  "decisions.optionTerminal": "Answer in the terminal",
};

export const ko = {
  "mode.list": "권한 모드",
  "mode.chipTitle": "{mode} · 권한 모드 고르기",
  "mode.manual": "일반",
  "mode.accept edits": "편집 자동 수락",
  "mode.plan": "계획",
  "mode.auto": "자동",
  "mode.bypass permissions": "권한 우회",
  "mode.current": "현재",
  "mode.skipUnavailable": "이 세션에서는 쓸 수 없습니다. 사용하려면 새 세션을 시작하세요.",
  "mode.skipDisabled": "Claude 설정에서 꺼져 있습니다 (disableBypassPermissionsMode).",
  "mode.skipSetting": "이 세션에서는 쓸 수 없습니다. 사용하려면 권한 설정을 바꾸고 새 세션을 시작하세요.",
  "mode.skipWarn": "권한 우회가 켜져 있습니다: 어떤 권한 요청도 이 세션을 멈추지 않습니다.",
  "mode.walking": "{mode}(으)로 바꾸는 중…",
  "mode.rowSkip": "권한 우회 켜짐",
  "mode.codexStart": "시작할 때의 권한: {mode}. 설정 > 프로바이더에서 정하며 새 세션부터 적용됩니다.",
  "decisions.optionsLabel": "이 요청의 선택지",
  "decisions.optionTerminal": "터미널에서 답하세요",
};

export const ja = {
  "mode.list": "権限モード",
  "mode.chipTitle": "{mode} · 権限モードを選択",
  "mode.manual": "通常",
  "mode.accept edits": "編集を自動承認",
  "mode.plan": "プラン",
  "mode.auto": "自動",
  "mode.bypass permissions": "権限のバイパス",
  "mode.current": "現在",
  "mode.skipUnavailable": "このセッションでは使えません。使うには新しいセッションを開始してください。",
  "mode.skipDisabled": "Claude の設定でオフになっています（disableBypassPermissionsMode）。",
  "mode.skipSetting": "このセッションでは使えません。使うには権限設定を変更して新しいセッションを開始してください。",
  "mode.skipWarn": "権限のバイパスがオンです。どの許可リクエストもこのセッションを止めません。",
  "mode.walking": "{mode} に切り替え中…",
  "mode.rowSkip": "権限のバイパス：オン",
  "mode.codexStart": "開始時の権限：{mode}。設定 > プロバイダーで決め、新しいセッションから適用されます。",
  "decisions.optionsLabel": "このリクエストの選択肢",
  "decisions.optionTerminal": "ターミナルで回答",
};

export const zhHans = {
  "mode.list": "权限模式",
  "mode.chipTitle": "{mode} · 选择权限模式",
  "mode.manual": "常规",
  "mode.accept edits": "自动接受编辑",
  "mode.plan": "计划",
  "mode.auto": "自动",
  "mode.bypass permissions": "绕过权限",
  "mode.current": "当前",
  "mode.skipUnavailable": "此会话无法使用。如需使用，请启动新会话。",
  "mode.skipDisabled": "已被 Claude 设置关闭 (disableBypassPermissionsMode)。",
  "mode.skipSetting": "此会话无法使用。如需使用，请更改权限设置并启动新会话。",
  "mode.skipWarn": "已开启“绕过权限”：任何权限请求都不会让此会话停下。",
  "mode.walking": "正在切换到 {mode}…",
  "mode.rowSkip": "“绕过权限”已开启",
  "mode.codexStart": "启动时的权限：{mode}。在“设置 > 提供方”中设定，从新会话开始生效。",
  "decisions.optionsLabel": "此请求的选项",
  "decisions.optionTerminal": "请在终端中回答",
};

export const zhHant = {
  "mode.list": "權限模式",
  "mode.chipTitle": "{mode} · 選擇權限模式",
  "mode.manual": "一般",
  "mode.accept edits": "自動接受編輯",
  "mode.plan": "計畫",
  "mode.auto": "自動",
  "mode.bypass permissions": "繞過權限",
  "mode.current": "目前",
  "mode.skipUnavailable": "此工作階段無法使用。如需使用，請啟動新的工作階段。",
  "mode.skipDisabled": "已被 Claude 設定關閉（disableBypassPermissionsMode）。",
  "mode.skipSetting": "此工作階段無法使用。如需使用，請變更權限設定並啟動新的工作階段。",
  "mode.skipWarn": "已開啟「繞過權限」：任何權限請求都不會讓此工作階段停下。",
  "mode.walking": "正在切換到 {mode}…",
  "mode.rowSkip": "已開啟「繞過權限」",
  "mode.codexStart": "啟動時的權限：{mode}。在「設定 > 提供者」中設定，從新的工作階段開始生效。",
  "decisions.optionsLabel": "此請求的選項",
  "decisions.optionTerminal": "請在終端中回答",
};

export const es = {
  "mode.list": "Modos de permisos",
  "mode.chipTitle": "{mode} · elegir un modo de permisos",
  "mode.manual": "Normal",
  "mode.accept edits": "Aceptar ediciones",
  "mode.plan": "Plan",
  "mode.auto": "Automático",
  "mode.bypass permissions": "Omitir permisos",
  "mode.current": "Actual",
  "mode.skipUnavailable": "No está disponible en esta sesión. Inicia una sesión nueva para usarlo.",
  "mode.skipDisabled": "Desactivado en tu configuración de Claude (disableBypassPermissionsMode).",
  "mode.skipSetting": "No está disponible en esta sesión. Cambia el ajuste de permisos e inicia una sesión nueva para usarlo.",
  "mode.skipWarn": "Omitir permisos está activado: ninguna solicitud de permiso detendrá esta sesión.",
  "mode.walking": "Cambiando a {mode}…",
  "mode.rowSkip": "Omitir permisos activado",
  "mode.codexStart": "Permiso al iniciar: {mode}. Se elige en Ajustes > Proveedores, para las sesiones nuevas.",
  "decisions.optionsLabel": "Opciones de esta solicitud",
  "decisions.optionTerminal": "Responde en el terminal",
};

export const fr = {
  "mode.list": "Modes d’autorisation",
  "mode.chipTitle": "{mode} · choisir un mode d’autorisation",
  "mode.manual": "Normal",
  "mode.accept edits": "Accepter les modifications",
  "mode.plan": "Plan",
  "mode.auto": "Automatique",
  "mode.bypass permissions": "Contourner les autorisations",
  "mode.current": "Actuel",
  "mode.skipUnavailable": "Indisponible dans cette session. Démarrez une nouvelle session pour l’utiliser.",
  "mode.skipDisabled": "Désactivé par vos réglages Claude (disableBypassPermissionsMode).",
  "mode.skipSetting": "Indisponible dans cette session. Modifiez le réglage des autorisations et démarrez une nouvelle session pour l’utiliser.",
  "mode.skipWarn": "Le mode Contourner les autorisations est activé : aucune demande d’autorisation n’arrêtera cette session.",
  "mode.walking": "Passage à {mode}…",
  "mode.rowSkip": "Contourner les autorisations : activé",
  "mode.codexStart": "Autorisation au démarrage : {mode}. Se règle dans Réglages > Fournisseurs, pour les nouvelles sessions.",
  "decisions.optionsLabel": "Options de cette demande",
  "decisions.optionTerminal": "Répondre dans le terminal",
};

export const pt = {
  "mode.list": "Modos de permissão",
  "mode.chipTitle": "{mode} · escolher um modo de permissão",
  "mode.manual": "Normal",
  "mode.accept edits": "Aceitar edições",
  "mode.plan": "Plano",
  "mode.auto": "Automático",
  "mode.bypass permissions": "Ignorar permissões",
  "mode.current": "Atual",
  "mode.skipUnavailable": "Não está disponível nesta sessão. Inicie uma nova sessão para usá-lo.",
  "mode.skipDisabled": "Desativado nas suas configurações do Claude (disableBypassPermissionsMode).",
  "mode.skipSetting": "Não está disponível nesta sessão. Altere a configuração de permissões e inicie uma nova sessão para usá-lo.",
  "mode.skipWarn": "O modo Ignorar permissões está ativado: nenhum pedido de permissão vai parar esta sessão.",
  "mode.walking": "Mudando para {mode}…",
  "mode.rowSkip": "Ignorar permissões ativado",
  "mode.codexStart": "Permissão ao iniciar: {mode}. Definida em Configurações > Provedores, para as novas sessões.",
  "decisions.optionsLabel": "Opções deste pedido",
  "decisions.optionTerminal": "Responder no terminal",
};

export { zhHans as 'zh-Hans', zhHant as 'zh-Hant' };
