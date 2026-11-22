// Ticket 610 (first-use walk 5, F10): the words for the dead ends that walk found. A palette command that opens Providers,
// where an agent signs in ("sign in" and "로그인" found nothing for it); the note a split gives on the Room tab, where there
// is no session to split beside; the composer's line for a stopped or closed session, which showed the core's state word
// ("상태: resumable") in every language but English.
declare module '../index' {
  interface AreaKeys {
    'walk5.signIn': true;
    'walk5.splitNeedsSession': true;
    'walk5.composer.resumable': true;
    'walk5.composer.closed': true;
    'walk5.composer.folderGone': true;
    'walk5.composer.endedAsk': true;
  }
}

export const en = {
  'walk5.signIn': 'Sign in to an agent (Providers)',
  'walk5.splitNeedsSession': 'Splits open beside a session: open a session tab, then split.',
  'walk5.composer.resumable': '{name} is resumable: read only',
  'walk5.composer.closed': '{name} is closed: read only',
  'walk5.composer.folderGone': "{name}'s folder is gone: read only",
  'walk5.composer.endedAsk': '{name} stopped before you answered “{ask}”. That question is no longer open. Press Resume, then reply in the chat.',
};

export const ko = {
  'walk5.signIn': '에이전트에 로그인 (프로바이더)',
  'walk5.splitNeedsSession': '분할은 세션 옆에 열립니다. 세션 탭을 연 뒤 나누세요.',
  'walk5.composer.resumable': "{name} 재개 가능: 읽기 전용",
  'walk5.composer.closed': '{name} 닫힘: 읽기 전용',
  'walk5.composer.folderGone': '{name}의 폴더가 없습니다: 읽기 전용',
  'walk5.composer.endedAsk': '{name}이(가) “{ask}”에 답하기 전에 멈췄습니다. 그 질문은 더 이상 열려 있지 않습니다. 재개를 누른 뒤 채팅에서 답하세요.',
};

export const ja = {
  'walk5.signIn': "エージェントにログイン（プロバイダー）",
  'walk5.splitNeedsSession': '分割はセッションの横に開きます。セッションのタブを開いてから分割してください。',
  'walk5.composer.resumable': '{name} は停止中（再開できます）：読み取り専用',
  'walk5.composer.closed': '{name} は閉じています：読み取り専用',
  'walk5.composer.folderGone': '{name} のフォルダーがありません：読み取り専用',
  'walk5.composer.endedAsk': '{name} は「{ask}」への回答を受け取る前に停止しました。この質問はもう受け付けていません。「再開」を押してから、チャットで返信してください。',
};

export const zhHans = {
  'walk5.signIn': '登录代理（提供方）',
  'walk5.splitNeedsSession': "拆分会在会话旁打开：先打开一个会话选项卡，再拆分。",
  'walk5.composer.resumable': '{name} 已停止（可恢复）：只读',
  'walk5.composer.closed': '{name} 已关闭：只读',
  'walk5.composer.folderGone': '{name} 的文件夹已不存在：只读',
  'walk5.composer.endedAsk': '{name} 在你回答“{ask}”之前已停止：该请求已不存在，请恢复后在聊天中回复。',
};

export const zhHant = {
  'walk5.signIn': '登入代理（提供者）',
  'walk5.splitNeedsSession': "分割會在工作階段旁開啟：先開啟一個工作階段選項卡，再分割。",
  'walk5.composer.resumable': '{name} 已停止（可繼續）：唯讀',
  'walk5.composer.closed': '{name} 已關閉：唯讀',
  'walk5.composer.folderGone': '{name} 的資料夾已不存在：唯讀',
  'walk5.composer.endedAsk': '{name} 在你回答「{ask}」之前已停止：該請求已不存在，請繼續後在聊天中回覆',
};

export const es = {
  'walk5.signIn': 'Iniciar sesión en un agente (Proveedores)',
  'walk5.splitNeedsSession': 'Las divisiones se abren junto a una sesión: abre una pestaña de sesión y luego divide.',
  'walk5.composer.resumable': '{name} está detenida (se puede reanudar): solo lectura',
  'walk5.composer.closed': '{name} está cerrada: solo lectura',
  'walk5.composer.folderGone': 'La carpeta de {name} ya no existe: solo lectura',
  'walk5.composer.endedAsk': '{name} se detuvo antes de que respondieras a “{ask}”. Esa pregunta ya no está abierta. Pulsa Reanudar y responde en el chat.',
};

export const fr = {
  'walk5.signIn': 'Se connecter à un agent (Fournisseurs)',
  'walk5.splitNeedsSession': "Une division s’ouvre à côté d’une session : ouvrez un onglet de session, puis divisez.",
  'walk5.composer.resumable': '{name} est arrêtée (peut être reprise) : lecture seule',
  'walk5.composer.closed': '{name} est fermée : lecture seule',
  'walk5.composer.folderGone': "Le dossier de {name} n’existe plus : lecture seule",
  'walk5.composer.endedAsk': "{name} s’est arrêtée avant votre réponse à « {ask} ». Cette question n’est plus ouverte. Appuyez sur Reprendre, puis répondez dans la conversation.",
};

export const pt = {
  'walk5.signIn': 'Entrar em um agente (Provedores)',
  'walk5.splitNeedsSession': 'As divisões abrem ao lado de uma sessão: abra uma aba de sessão e depois divida.',
  'walk5.composer.resumable': '{name} pode ser retomada: somente leitura',
  'walk5.composer.closed': '{name} está fechada: somente leitura',
  'walk5.composer.folderGone': 'A pasta de {name} não existe mais: somente leitura',
  'walk5.composer.endedAsk': '{name} parou antes de você responder a “{ask}”. Essa pergunta não está mais aberta. Pressione Retomar e responda na conversa.',
};
