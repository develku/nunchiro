// Ticket 570: the project jumps (Settings > Keys); look 1117 v12 C-V8: the empty centre names the project whose tabs are hidden. The tab jumps now act on the shown project's tabs. All eight languages.
declare module '../index' {
  interface AreaKeys {
    'settings.keys.cmd.projectJump': true;
    'settings.keys.cmd.projectJumpAll': true;
    'settings.kbd.desc.project.jump': true;
    'landing.otherTabs': true;
    'landing.showOther': true;
  }
}

export const en = { 'settings.keys.cmd.projectJump': 'Go to project {n}', 'settings.keys.cmd.projectJumpAll': 'Go to project 1-9', 'settings.kbd.desc.project.jump': 'Shows that project\'s tabs. The nine number keys change together', 'landing.otherTabs': "No tab open in {project}. {other} has open tabs.", 'landing.showOther': "Show {other}" };
export const ko = { 'settings.keys.cmd.projectJump': '{n}번 프로젝트로 이동', 'settings.keys.cmd.projectJumpAll': '1~9번째 프로젝트로 바로 가기', 'settings.kbd.desc.project.jump': '그 프로젝트의 탭을 보여 줌. 숫자 아홉 개가 함께 바뀜', 'landing.otherTabs': "{project}에 열린 탭이 없습니다. {other}에 열린 탭이 있습니다.", 'landing.showOther': "{other} 보기" };
export const ja = { 'settings.keys.cmd.projectJump': 'プロジェクト {n} に移動', 'settings.keys.cmd.projectJumpAll': 'プロジェクト 1-9 に移動', 'settings.kbd.desc.project.jump': 'そのプロジェクトのタブを表示。数字キー 9 つが一緒に変わる', 'landing.otherTabs': "{project} に開いているタブはありません。{other} には開いているタブがあります。", 'landing.showOther': "{other} を表示" };
export const zhHans = { 'settings.keys.cmd.projectJump': '转到项目 {n}', 'settings.keys.cmd.projectJumpAll': '转到项目 1-9', 'settings.kbd.desc.project.jump': "显示该项目的选项卡。九个数字键一起更改", 'landing.otherTabs': "{project} 中没有打开的选项卡。{other} 中有打开的选项卡。", 'landing.showOther': "显示 {other}" };
export const zhHant = { 'settings.keys.cmd.projectJump': '前往專案 {n}', 'settings.keys.cmd.projectJumpAll': '前往專案 1-9', 'settings.kbd.desc.project.jump': '顯示該專案的選項卡。九個數字鍵一起變更', 'landing.otherTabs': "{project} 中沒有開啟的選項卡。{other} 中有開啟的選項卡。", 'landing.showOther': "顯示 {other}" };
export const es = { 'settings.keys.cmd.projectJump': 'Ir al proyecto {n}', 'settings.keys.cmd.projectJumpAll': 'Ir al proyecto 1-9', 'settings.kbd.desc.project.jump': 'Muestra las pestañas de ese proyecto. Las nueve teclas numéricas cambian juntas', 'landing.otherTabs': "No hay ninguna pestaña abierta en {project}. {other} tiene pestañas abiertas.", 'landing.showOther': "Mostrar {other}" };
export const fr = { 'settings.keys.cmd.projectJump': 'Aller au projet {n}', 'settings.keys.cmd.projectJumpAll': 'Aller au projet 1-9', 'settings.kbd.desc.project.jump': 'Affiche les onglets de ce projet. Les neuf touches numériques changent ensemble', 'landing.otherTabs': "Aucun onglet ouvert dans {project}. {other} a des onglets ouverts.", 'landing.showOther': "Afficher {other}" };
export const pt = { 'settings.keys.cmd.projectJump': 'Ir para o projeto {n}', 'settings.keys.cmd.projectJumpAll': 'Ir para o projeto 1-9', 'settings.kbd.desc.project.jump': "Mostra as abas desse projeto. As nove teclas numéricas mudam juntas", 'landing.otherTabs': "Nenhuma aba aberta em {project}. {other} tem abas abertas.", 'landing.showOther': "Mostrar {other}" };
