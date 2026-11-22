// Ticket 626 (first-use walk 7, F10): Close tab (⌘W) on a project's Room tab did nothing and said nothing; the Room tab
// stays by design (room/room.ts), so the close says so.
declare module '../index' {
  interface AreaKeys {
    'walk7.roomStays': true;
  }
}

export const en = {
  'walk7.roomStays': 'The Room tab stays open because it belongs to the project. To close another tab, switch to it first.',
};

export const ko = {
  'walk7.roomStays': '대화방 탭은 프로젝트에 딸려 있어 닫히지 않습니다. 닫을 탭으로 옮긴 뒤 닫으세요.',
};

export const ja = {
  'walk7.roomStays': 'ルームのタブはプロジェクトの一部なので閉じられません。閉じたいタブに移ってから閉じてください。',
};

export const zhHans = {
  'walk7.roomStays': "聊天室选项卡属于项目，不能关闭。请切换到要关闭的选项卡再关闭。",
};

export const zhHant = {
  'walk7.roomStays': "聊天室選項卡屬於專案，無法關閉。請切換到要關閉的選項卡再關閉。",
};

export const es = {
  'walk7.roomStays': 'La pestaña Sala pertenece al proyecto y no se cierra. Ve a la pestaña que quieras cerrar y ciérrala.',
};

export const fr = {
  'walk7.roomStays': "L’onglet Salle appartient au projet et ne se ferme pas. Allez à l’onglet à fermer, puis fermez-le.",
};

export const pt = {
  'walk7.roomStays': 'A aba Sala pertence ao projeto e não fecha. Vá para a aba que quer fechar e feche-a.',
};
