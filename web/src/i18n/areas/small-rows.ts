// Ticket 270 (needs 197; G30, G31, G34): alerts per machine, tab cycle order, agent credits on merge (features/small-rows.tsx).
declare module '../index' {
  interface AreaKeys {
    'field.alertMachines': true;
    'field.tabCycleOrder': true;
    'field.stripAgentCredits': true;
    'smallRows.machines': true;
    'smallRows.machinesDesc': true;
    'smallRows.thisMac': true;
    'smallRows.machineAlerts': true;
    'smallRows.cycleDesc': true;
    'smallRows.cycleStrip': true;
    'smallRows.cycleMru': true;
    'smallRows.stripDesc': true;
    'smallRows.rebaseNote': true;
  }
}

export const en = {
  'field.alertMachines': 'Alerts per machine',
  'field.tabCycleOrder': 'Next/previous session order',
  'field.stripAgentCredits': 'Remove agent credits when merging',
  'smallRows.machines': 'Machines',
  'smallRows.machinesDesc': 'A machine switched off raises no notification and no sound. Its sessions still wait in the queue.',
  'smallRows.thisMac': 'This Mac',
  'smallRows.machineAlerts': 'Alerts from {name}',
  'smallRows.cycleDesc': 'The order the next and previous session keys walk the tabs in.',
  'smallRows.cycleStrip': 'Tab strip',
  'smallRows.cycleMru': 'Most recently used',
  'smallRows.stripDesc': 'Squash merges from the PR view leave out Co-Authored-By lines with a Claude or Codex address. Other co-authors stay.',
  'smallRows.rebaseNote': 'Only a squash merge leaves out agent credits. Merge and rebase keep the commits as they are.',
};
export const ko = {
  'field.alertMachines': '머신별 알림',
  'field.tabCycleOrder': '다음/이전 세션 순서',
  'field.stripAgentCredits': '병합할 때 에이전트 공동 작성자 표기 제거',
  'smallRows.machines': '머신',
  'smallRows.machinesDesc': '끈 머신은 알림도 소리도 내지 않습니다. 그 세션은 대기열에 그대로 남습니다.',
  'smallRows.thisMac': '이 Mac',
  'smallRows.machineAlerts': '{name} 알림',
  'smallRows.cycleDesc': '다음/이전 세션 키가 탭을 도는 순서입니다.',
  'smallRows.cycleStrip': '탭 줄 순서',
  'smallRows.cycleMru': '최근 사용 순',
  'smallRows.stripDesc': 'PR 보기에서 스쿼시 병합할 때 Claude와 Codex 주소의 공동 작성자 표기 줄을 뺍니다. 다른 공동 작성자는 남습니다.',
  'smallRows.rebaseNote': '에이전트 표기는 스쿼시 병합에서만 빠집니다. 병합 커밋과 리베이스는 커밋을 그대로 둡니다.',
};
export const ja = {
  'field.alertMachines': 'マシンごとの通知',
  'field.tabCycleOrder': '次/前のセッションの順序',
  'field.stripAgentCredits': 'マージ時にエージェントの共同作成者表記を外す',
  'smallRows.machines': 'マシン',
  'smallRows.machinesDesc': 'オフにしたマシンは通知も音も出しません。そのセッションはキューに残ります。',
  'smallRows.thisMac': 'この Mac',
  'smallRows.machineAlerts': '{name} の通知',
  'smallRows.cycleDesc': '次/前のセッションキーがタブを巡る順序です。',
  'smallRows.cycleStrip': 'タブバーの順',
  'smallRows.cycleMru': '最近使った順',
  'smallRows.stripDesc': 'PR ビューからのスカッシュマージで、Claude と Codex のアドレスの Co-Authored-By 行を外します。他の共同作成者は残ります。',
  'smallRows.rebaseNote': 'エージェントの表記が外れるのはスカッシュマージだけです。マージコミットとリベースはコミットをそのまま残します。',
};
export const zhHans = {
  'field.alertMachines': '按机器通知',
  'field.tabCycleOrder': '下一个/上一个会话的顺序',
  'field.stripAgentCredits': '合并时移除代理共同作者署名',
  'smallRows.machines': '机器',
  'smallRows.machinesDesc': '关闭的机器不发通知也不发声音。其会话仍留在队列中。',
  'smallRows.thisMac': '这台 Mac',
  'smallRows.machineAlerts': '来自 {name} 的通知',
  'smallRows.cycleDesc': '下一个/上一个会话快捷键切换选项卡的顺序。',
  'smallRows.cycleStrip': "选项卡栏顺序",
  'smallRows.cycleMru': '最近使用',
  'smallRows.stripDesc': '从 PR 视图压缩合并时，去掉 Claude 和 Codex 地址的 Co-Authored-By 行。其他共同作者保留。',
  'smallRows.rebaseNote': '只有压缩合并会去掉代理署名。合并提交和变基会保持提交原样。',
};
export const zhHant = {
  'field.alertMachines': '依機器通知',
  'field.tabCycleOrder': '下一個/上一個工作階段的順序',
  'field.stripAgentCredits': '合併時移除代理共同作者署名',
  'smallRows.machines': '機器',
  'smallRows.machinesDesc': '關閉的機器不發通知也不發聲音。其工作階段仍留在佇列中。',
  'smallRows.thisMac': '這台 Mac',
  'smallRows.machineAlerts': '來自 {name} 的通知',
  'smallRows.cycleDesc': '下一個/上一個工作階段快速鍵切換選項卡的順序。',
  'smallRows.cycleStrip': '選項卡列順序',
  'smallRows.cycleMru': '最近使用',
  'smallRows.stripDesc': '從 PR 檢視壓縮合併時，移除 Claude 與 Codex 位址的 Co-Authored-By 行。其他共同作者保留。',
  'smallRows.rebaseNote': '只有壓縮合併會移除代理署名。合併提交與重定基底會保持提交原樣。',
};
export const es = {
  'field.alertMachines': 'Avisos por máquina',
  'field.tabCycleOrder': 'Orden de sesión siguiente/anterior',
  'field.stripAgentCredits': 'Quitar créditos de agentes al fusionar',
  'smallRows.machines': 'Máquinas',
  'smallRows.machinesDesc': 'Una máquina desactivada no lanza notificaciones ni sonidos. Sus sesiones siguen esperando en la cola.',
  'smallRows.thisMac': 'Este Mac',
  'smallRows.machineAlerts': 'Avisos de {name}',
  'smallRows.cycleDesc': 'El orden en que las teclas de sesión siguiente y anterior recorren las pestañas.',
  'smallRows.cycleStrip': 'Barra de pestañas',
  'smallRows.cycleMru': 'Usadas recientemente',
  'smallRows.stripDesc': 'Las fusiones squash desde la vista de PR omiten las líneas Co-Authored-By con dirección de Claude o Codex. Los demás coautores se mantienen.',
  'smallRows.rebaseNote': 'Solo una fusión squash omite los créditos de agentes. Merge y rebase dejan los commits como están.',
};
export const fr = {
  'field.alertMachines': 'Alertes par machine',
  'field.tabCycleOrder': 'Ordre de session suivante/précédente',
  'field.stripAgentCredits': 'Retirer les crédits des agents à la fusion',
  'smallRows.machines': 'Machines',
  'smallRows.machinesDesc': 'Une machine désactivée n’émet ni notification ni son. Ses sessions restent dans la file.',
  'smallRows.thisMac': 'Ce Mac',
  'smallRows.machineAlerts': 'Alertes de {name}',
  'smallRows.cycleDesc': 'L’ordre dans lequel les touches de session suivante et précédente parcourent les onglets.',
  'smallRows.cycleStrip': 'Barre d’onglets',
  'smallRows.cycleMru': 'Utilisés récemment',
  'smallRows.stripDesc': 'Les fusions squash depuis la vue PR omettent les lignes Co-Authored-By avec une adresse Claude ou Codex. Les autres coauteurs restent.',
  'smallRows.rebaseNote': 'Seule une fusion squash retire les crédits des agents. Merge et rebase laissent les commits tels quels.',
};
export const pt = {
  'field.alertMachines': 'Alertas por máquina',
  'field.tabCycleOrder': 'Ordem da sessão seguinte/anterior',
  'field.stripAgentCredits': 'Remover créditos de agentes ao mesclar',
  'smallRows.machines': 'Máquinas',
  'smallRows.machinesDesc': 'Uma máquina desligada não gera notificação nem som. Suas sessões continuam na fila.',
  'smallRows.thisMac': 'Este Mac',
  'smallRows.machineAlerts': 'Alertas de {name}',
  'smallRows.cycleDesc': 'A ordem em que as teclas de sessão seguinte e anterior percorrem as abas.',
  'smallRows.cycleStrip': 'Barra de abas',
  'smallRows.cycleMru': 'Usadas recentemente',
  'smallRows.stripDesc': "Mesclagens squash pela visualização do PR omitem as linhas Co-Authored-By com endereço de Claude ou Codex. Os outros coautores ficam.",
  'smallRows.rebaseNote': 'Só uma mesclagem squash omite os créditos de agentes. Merge e rebase deixam os commits como estão.',
};
