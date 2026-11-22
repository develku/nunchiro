// Ticket 328 part 1: My browser's tab strip and its four commands (Settings > Keys, the palette).
declare module '../index' {
  interface AreaKeys {
    'browserTabs.strip': true;
    'browserTabs.new': true;
    'browserTabs.newTab': true;
    'browserTabs.close': true;
    'browserTabs.agentHere': true;
    'settings.kbd.cmd.browser.tab.next': true;
    'settings.kbd.cmd.browser.tab.prev': true;
    'settings.kbd.cmd.browser.tab.close': true;
    'settings.kbd.cmd.browser.tab.new': true;
  }
}

export const en = {
  'browserTabs.strip': 'Browser tabs',
  'browserTabs.new': 'New browser tab',
  'browserTabs.newTab': 'New tab',
  'browserTabs.close': 'Close {name}',
  'browserTabs.agentHere': 'The agent works in this tab',
  'settings.kbd.cmd.browser.tab.next': 'Next browser tab',
  'settings.kbd.cmd.browser.tab.prev': 'Previous browser tab',
  'settings.kbd.cmd.browser.tab.close': 'Close browser tab',
  'settings.kbd.cmd.browser.tab.new': 'New browser tab',
};

export const ko = {
  'browserTabs.strip': '브라우저 탭',
  'browserTabs.new': '새 브라우저 탭',
  'browserTabs.newTab': '새 탭',
  'browserTabs.close': '{name} 닫기',
  'browserTabs.agentHere': '에이전트가 작업 중인 탭',
  'settings.kbd.cmd.browser.tab.next': '다음 브라우저 탭',
  'settings.kbd.cmd.browser.tab.prev': '이전 브라우저 탭',
  'settings.kbd.cmd.browser.tab.close': '브라우저 탭 닫기',
  'settings.kbd.cmd.browser.tab.new': '새 브라우저 탭',
};

export const ja = {
  'browserTabs.strip': 'ブラウザのタブ',
  'browserTabs.new': '新しいブラウザタブ',
  'browserTabs.newTab': '新しいタブ',
  'browserTabs.close': '{name} を閉じる',
  'browserTabs.agentHere': 'エージェントが作業中のタブ',
  'settings.kbd.cmd.browser.tab.next': '次のブラウザタブ',
  'settings.kbd.cmd.browser.tab.prev': '前のブラウザタブ',
  'settings.kbd.cmd.browser.tab.close': 'ブラウザタブを閉じる',
  'settings.kbd.cmd.browser.tab.new': '新しいブラウザタブ',
};

export const zhHans = {
  'browserTabs.strip': '浏览器选项卡',
  'browserTabs.new': '新建浏览器选项卡',
  'browserTabs.newTab': '新选项卡',
  'browserTabs.close': '关闭 {name}',
  'browserTabs.agentHere': '代理正在使用此选项卡',
  'settings.kbd.cmd.browser.tab.next': '下一个浏览器选项卡',
  'settings.kbd.cmd.browser.tab.prev': '上一个浏览器选项卡',
  'settings.kbd.cmd.browser.tab.close': '关闭浏览器选项卡',
  'settings.kbd.cmd.browser.tab.new': '新建浏览器选项卡',
};

export const zhHant = {
  'browserTabs.strip': '瀏覽器選項卡',
  'browserTabs.new': '新增瀏覽器選項卡',
  'browserTabs.newTab': '新選項卡',
  'browserTabs.close': '關閉 {name}',
  'browserTabs.agentHere': '代理正在使用此選項卡',
  'settings.kbd.cmd.browser.tab.next': '下一個瀏覽器選項卡',
  'settings.kbd.cmd.browser.tab.prev': '上一個瀏覽器選項卡',
  'settings.kbd.cmd.browser.tab.close': '關閉瀏覽器選項卡',
  'settings.kbd.cmd.browser.tab.new': '新增瀏覽器選項卡',
};

export const es = {
  'browserTabs.strip': 'Pestañas del navegador',
  'browserTabs.new': 'Nueva pestaña del navegador',
  'browserTabs.newTab': 'Nueva pestaña',
  'browserTabs.close': 'Cerrar {name}',
  'browserTabs.agentHere': 'El agente trabaja en esta pestaña',
  'settings.kbd.cmd.browser.tab.next': 'Siguiente pestaña del navegador',
  'settings.kbd.cmd.browser.tab.prev': 'Pestaña anterior del navegador',
  'settings.kbd.cmd.browser.tab.close': 'Cerrar pestaña del navegador',
  'settings.kbd.cmd.browser.tab.new': 'Nueva pestaña del navegador',
};

export const fr = {
  'browserTabs.strip': 'Onglets du navigateur',
  'browserTabs.new': 'Nouvel onglet du navigateur',
  'browserTabs.newTab': 'Nouvel onglet',
  'browserTabs.close': 'Fermer {name}',
  'browserTabs.agentHere': "L’agent travaille dans cet onglet",
  'settings.kbd.cmd.browser.tab.next': 'Onglet suivant du navigateur',
  'settings.kbd.cmd.browser.tab.prev': 'Onglet précédent du navigateur',
  'settings.kbd.cmd.browser.tab.close': "Fermer l’onglet du navigateur",
  'settings.kbd.cmd.browser.tab.new': 'Nouvel onglet du navigateur',
};

export const pt = {
  'browserTabs.strip': 'Abas do navegador',
  'browserTabs.new': 'Nova aba do navegador',
  'browserTabs.newTab': 'Nova aba',
  'browserTabs.close': 'Fechar {name}',
  'browserTabs.agentHere': 'O agente trabalha nesta aba',
  'settings.kbd.cmd.browser.tab.next': 'Próxima aba do navegador',
  'settings.kbd.cmd.browser.tab.prev': 'Aba anterior do navegador',
  'settings.kbd.cmd.browser.tab.close': 'Fechar aba do navegador',
  'settings.kbd.cmd.browser.tab.new': 'Nova aba do navegador',
};
