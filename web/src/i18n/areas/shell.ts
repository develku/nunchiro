// V2.5-26 window shell: the Settings scope picker (needs 140).
declare module '../index' {
  interface AreaKeys {
    'shell.scope.all': true;
    'shell.tree.card': true;
    'shell.menu.pathCopy': true;
    'shell.menu.pathReveal': true;
    'shell.menu.messageCopy': true;
    'shell.menu.iconHide': true;
    'shell.menu.iconMove': true;
    'shell.menu.iconSplit': true;
    'shell.status.staleTip': true;
    'shell.widget.tree': true;
    'shell.widget.agents': true;
    'shell.widget.waiting': true;
    'shell.widget.terminal': true;
    'shell.widget.composer': true;
    'shell.widget.diff': true;
    'shell.widget.files': true;
    'shell.widget.board': true;
    'shell.widget.search': true;
    'shell.widget.preview': true;
    'shell.widget.artifacts': true;
    'shell.widget.decisions': true;
    'shell.widget.settings': true;
    'shell.widget.layout': true;
    'shell.widget.browser': true;
    'shell.tip.tree': true;
    'shell.tip.diff': true;
    'shell.tip.terminal': true;
    'shell.tip.artifacts': true;
    'shell.tip.layout': true;
    'shell.layout.editing': true;
    'shell.layout.done': true;
    'shell.zone.chat': true;
    'shell.centreStays': true;
    'shell.terminalIcon.noSession': true;
    'shell.terminalIcon.inCentre': true;
    'shell.browserIcon.noSession': true;
    'shell.boot.starting': true;
    'shell.boot.startingNote': true;
    'shell.rail.left': true;
    'shell.rail.right': true;
    'shell.rail.folded': true;
    'shell.rail.more': true;
    'shell.rail.moreMenu': true;
    'shell.rail.cutOff': true;
    'shell.rail.removeLeft': true;
    'shell.rail.removeRight': true;
    'shell.boot.fail.start': true;
    'shell.boot.fail.cli': true;
    'shell.boot.fail.refused': true;
    'shell.boot.fail.timeout': true;
    'shell.crash.title': true;
    'shell.crash.note': true;
    'shell.crash.reload': true;
    'shell.crash.copy': true;
  }
}

export const en = {
  'shell.scope.all': 'All projects',
  // needs 157 (2): the Tree card's line in Layout's widget library (placement item 2, mockup m2).
  'shell.tree.card': "Always in the layout; you can move it",
  // system4: the path and message menus (data-menu-arg is the text).
  'shell.menu.pathCopy': 'Copy path',
  'shell.menu.pathReveal': 'Reveal in Finder',
  'shell.menu.messageCopy': 'Copy',
  // system5 (ticket 196): the icon bar icon's menu.
  'shell.menu.iconHide': 'Hide',
  'shell.menu.iconMove': 'Move to the other bar',
  'shell.menu.iconSplit': 'Open as split',
  // system5 (ticket 196): tooltips of the status line's two counts.
  'shell.status.staleTip': 'Jump to a stale session',
  // V2.5-54 A12: the rails, their tooltips and the zone tab strip follow the language (English kind ids stay searchable).
  'shell.widget.tree': 'Tree',
  'shell.widget.agents': 'Agents',
  'shell.widget.waiting': 'Answer strip',
  'shell.widget.terminal': 'Terminal',
  'shell.widget.composer': 'Composer',
  'shell.widget.diff': 'Diff',
  'shell.widget.files': 'Files',
  'shell.widget.board': 'Board',
  'shell.widget.search': 'Search',
  'shell.widget.preview': 'Preview',
  'shell.widget.artifacts': 'Artifacts',
  'shell.widget.decisions': 'Decisions',
  'shell.widget.settings': 'Settings',
  'shell.widget.layout': 'Layout',
  'shell.widget.browser': 'Browser',
  'shell.tip.tree': 'Tree: projects, worktrees and sessions',
  'shell.tip.diff': 'Diff: changes since the session started',
  'shell.tip.terminal': 'Terminal: this session’s side pane',
  'shell.tip.artifacts': 'Artifacts: this session’s attachments, artifacts and changed files',
  'shell.tip.layout': 'Layout: bars, widgets and zones',
  'shell.layout.editing': 'Editing layout · Done',
  'shell.layout.done': 'Done',
  'shell.zone.chat': 'Chat',
  'shell.centreStays': 'The centre chat stays in the window: place other widgets beside it',
  'shell.terminalIcon.noSession': 'Open an agent session to see its terminal',
  'shell.terminalIcon.inCentre': 'This session shows its terminal in the centre',
  'shell.browserIcon.noSession': 'Open an agent session to use its browser',
  // Ticket 425: the window while the core is only slow to start (no attempt failed yet).
  'shell.boot.starting': 'Nunchiro is starting',
  "shell.boot.startingNote": "The background service is still starting. This window opens by itself when it is ready.",
  // Ticket 408 / rail names: the icon bars' own names (bar, folded icon, the overflow button and menu, edit-mode remove).
  'shell.rail.left': 'Left bar',
  'shell.rail.right': 'Right bar',
  'shell.rail.folded': '{name} (folded)',
  'shell.rail.more': '{n} more icons',
  'shell.rail.moreMenu': 'More icons',
  'shell.rail.cutOff': 'Cut off by the window height',
  'shell.rail.removeLeft': 'Remove {name} from the left bar',
  'shell.rail.removeRight': 'Remove {name} from the right bar',
  // Ticket 430: a start failure as the window shows it, by kind (main.rs `Failed`); the raw reason is only logged.
  "shell.boot.fail.start": "Nunchiro could not start or update its background service. Retry, or quit and open Nunchiro again.",
  'shell.boot.fail.cli': 'Nunchiro could not run its own command-line tool. Reinstall Nunchiro if this keeps happening.',
  "shell.boot.fail.refused": "The background service refused this window. Quit Nunchiro and open it again.",
  "shell.boot.fail.timeout": "The background service did not answer in time. Retry, or quit and open Nunchiro again.",
  // S3: the crash screen (CrashScreen.tsx) when the window throws while drawing; "Copied" is about.copied, "Could not copy" about.copyFailed.
  'shell.crash.title': 'This window hit a problem',
  "shell.crash.note": "Your sessions keep running in the background service. Reload the window to see them again.",
  'shell.crash.reload': 'Reload window',
  'shell.crash.copy': 'Copy details',
};

export const ko = {
  'shell.scope.all': '모든 프로젝트',
  // needs 157 (2): the Tree card's line in Layout's widget library (placement item 2, mockup m2).
  'shell.tree.card': "항상 배치에 있고, 옮길 수 있음",
  // system4: the path and message menus (data-menu-arg is the text).
  'shell.menu.pathCopy': '경로 복사',
  'shell.menu.pathReveal': 'Finder에서 보기',
  'shell.menu.messageCopy': '복사',
  // system5 (ticket 196): the icon bar icon's menu.
  'shell.menu.iconHide': '숨기기',
  'shell.menu.iconMove': '다른 바로 이동',
  'shell.menu.iconSplit': '분할로 열기',
  // system5 (ticket 196): tooltips of the status line's two counts.
  'shell.status.staleTip': "멈춘 세션으로 이동",
  // V2.5-54 A12: the rails, their tooltips and the zone tab strip follow the language (English kind ids stay searchable).
  'shell.widget.tree': '트리',
  'shell.widget.agents': '에이전트',
  'shell.widget.waiting': '답변 띠',
  'shell.widget.terminal': '터미널',
  'shell.widget.composer': '입력창',
  'shell.widget.diff': 'Diff',
  'shell.widget.files': '파일',
  'shell.widget.board': '보드',
  'shell.widget.search': '검색',
  'shell.widget.preview': '미리보기',
  'shell.widget.artifacts': "아티팩트",
  'shell.widget.decisions': '결정',
  'shell.widget.settings': '설정',
  'shell.widget.layout': '배치',
  'shell.widget.browser': '브라우저',
  'shell.tip.tree': "트리: 프로젝트, 워크트리, 세션",
  'shell.tip.diff': 'Diff: 세션 시작 이후 바뀐 내용',
  'shell.tip.terminal': "터미널: 이 세션의 옆 패널",
  'shell.tip.artifacts': "아티팩트: 이 세션의 첨부, 아티팩트, 바뀐 파일",
  'shell.tip.layout': '배치: 바, 위젯, 영역',
  'shell.layout.editing': '배치 편집 중 · 완료',
  'shell.layout.done': '완료',
  'shell.zone.chat': '채팅',
  'shell.centreStays': '중앙 채팅은 창에 남아 있어야 합니다: 다른 위젯은 그 옆에 놓으세요',
  'shell.terminalIcon.noSession': '터미널을 보려면 에이전트 세션을 여세요',
  'shell.terminalIcon.inCentre': '이 세션은 터미널을 중앙에 보여 줍니다',
  'shell.browserIcon.noSession': '브라우저를 쓰려면 에이전트 세션을 여세요',
  // Ticket 425: the window while the core is only slow to start (no attempt failed yet).
  'shell.boot.starting': 'Nunchiro를 시작하는 중',
  "shell.boot.startingNote": "백그라운드 서비스가 아직 시작하는 중입니다. 준비되면 이 창이 저절로 열립니다.",
  // Ticket 408 / rail names: the icon bars' own names (bar, folded icon, the overflow button and menu, edit-mode remove).
  'shell.rail.left': "왼쪽 바",
  'shell.rail.right': "오른쪽 바",
  'shell.rail.folded': '{name} (접힘)',
  'shell.rail.more': '아이콘 {n}개 더',
  'shell.rail.moreMenu': '아이콘 더 보기',
  'shell.rail.cutOff': '창 높이 때문에 잘림',
  'shell.rail.removeLeft': "왼쪽 바에서 {name} 제거",
  'shell.rail.removeRight': "오른쪽 바에서 {name} 제거",
  "shell.boot.fail.start": "Nunchiro가 백그라운드 서비스를 시작하거나 업데이트하지 못했습니다. 다시 시도하거나, Nunchiro를 종료한 뒤 다시 여세요.",
  'shell.boot.fail.cli': 'Nunchiro가 자체 명령줄 도구를 실행하지 못했습니다. 계속되면 Nunchiro를 다시 설치하세요.',
  "shell.boot.fail.refused": "백그라운드 서비스가 이 창을 거부했습니다. Nunchiro를 종료한 뒤 다시 여세요.",
  "shell.boot.fail.timeout": "백그라운드 서비스가 제시간에 응답하지 않았습니다. 다시 시도하거나, Nunchiro를 종료한 뒤 다시 여세요.",
  'shell.crash.title': '이 창에 문제가 생겼습니다',
  "shell.crash.note": "세션은 백그라운드 서비스에서 계속 실행 중입니다. 창을 다시 불러오면 다시 보입니다.",
  'shell.crash.reload': '창 다시 불러오기',
  'shell.crash.copy': '세부 정보 복사',
};

export const ja = {
  'shell.scope.all': 'すべてのプロジェクト',
  // needs 157 (2): the Tree card's line in Layout's widget library (placement item 2, mockup m2).
  'shell.tree.card': "常にレイアウトにあり、移動できます",
  // system4: the path and message menus (data-menu-arg is the text).
  'shell.menu.pathCopy': 'パスをコピー',
  'shell.menu.pathReveal': 'Finder で表示',
  'shell.menu.messageCopy': 'コピー',
  // system5 (ticket 196): the icon bar icon's menu.
  'shell.menu.iconHide': '非表示にする',
  'shell.menu.iconMove': 'もう一方のバーへ移動',
  'shell.menu.iconSplit': '分割で開く',
  // system5 (ticket 196): tooltips of the status line's two counts.
  'shell.status.staleTip': "停滞中のセッションへ移動",
  // V2.5-54 A12: the rails, their tooltips and the zone tab strip follow the language (English kind ids stay searchable).
  'shell.widget.tree': 'ツリー',
  'shell.widget.agents': 'エージェント',
  'shell.widget.waiting': "回答ストリップ",
  'shell.widget.terminal': 'ターミナル',
  'shell.widget.composer': '入力欄',
  'shell.widget.diff': '差分',
  'shell.widget.files': 'ファイル',
  'shell.widget.board': 'ボード',
  'shell.widget.search': '検索',
  'shell.widget.preview': 'プレビュー',
  'shell.widget.artifacts': "アーティファクト",
  'shell.widget.decisions': "判断",
  'shell.widget.settings': '設定',
  'shell.widget.layout': 'レイアウト',
  'shell.widget.browser': "ブラウザ",
  'shell.tip.tree': 'ツリー：プロジェクト、ワークツリー、セッション',
  'shell.tip.diff': '差分：セッション開始後の変更',
  'shell.tip.terminal': 'ターミナル：このセッションのサイドペイン',
  'shell.tip.artifacts': "アーティファクト：このセッションの添付、アーティファクト、変更されたファイル",
  'shell.tip.layout': 'レイアウト：バー、ウィジェット、ゾーン',
  'shell.layout.editing': 'レイアウト編集中 · 完了',
  'shell.layout.done': '完了',
  'shell.zone.chat': 'チャット',
  'shell.centreStays': '中央のチャットはウィンドウに残ります：ほかのウィジェットはその横に置いてください',
  'shell.terminalIcon.noSession': 'ターミナルを見るにはエージェントセッションを開いてください',
  'shell.terminalIcon.inCentre': 'このセッションはターミナルを中央に表示しています',
  'shell.browserIcon.noSession': 'ブラウザを使うにはエージェントセッションを開いてください',
  // Ticket 425: the window while the core is only slow to start (no attempt failed yet).
  'shell.boot.starting': 'Nunchiro を起動しています',
  "shell.boot.startingNote": "バックグラウンドサービスはまだ起動中です。準備ができるとこのウィンドウは自動で開きます。",
  // Ticket 408 / rail names: the icon bars' own names (bar, folded icon, the overflow button and menu, edit-mode remove).
  'shell.rail.left': '左バー',
  'shell.rail.right': '右バー',
  'shell.rail.folded': '{name}（折りたたみ）',
  'shell.rail.more': 'ほかのアイコン {n} 個',
  'shell.rail.moreMenu': 'ほかのアイコン',
  'shell.rail.cutOff': 'ウィンドウの高さで隠れています',
  'shell.rail.removeLeft': '左バーから{name}を外す',
  'shell.rail.removeRight': '右バーから{name}を外す',
  "shell.boot.fail.start": "Nunchiro はバックグラウンドサービスを起動または更新できませんでした。再試行するか、Nunchiro を終了してもう一度開いてください。",
  'shell.boot.fail.cli': 'Nunchiro は自身のコマンドラインツールを実行できませんでした。繰り返す場合は Nunchiro を再インストールしてください。',
  "shell.boot.fail.refused": "バックグラウンドサービスがこのウィンドウを拒否しました。Nunchiro を終了してもう一度開いてください。",
  "shell.boot.fail.timeout": "バックグラウンドサービスが時間内に応答しませんでした。再試行するか、Nunchiro を終了してもう一度開いてください。",
  'shell.crash.title': 'このウィンドウで問題が起きました',
  "shell.crash.note": "セッションはバックグラウンドサービスで動き続けています。ウィンドウを再読み込みすると再び表示されます。",
  'shell.crash.reload': 'ウィンドウを再読み込み',
  'shell.crash.copy': '詳細をコピー',
};

export const zhHans = {
  'shell.scope.all': '所有项目',
  // needs 157 (2): the Tree card's line in Layout's widget library (placement item 2, mockup m2).
  'shell.tree.card': "始终在布局中，可移动",
  // system4: the path and message menus (data-menu-arg is the text).
  'shell.menu.pathCopy': '复制路径',
  'shell.menu.pathReveal': '在访达中显示',
  'shell.menu.messageCopy': '复制',
  // system5 (ticket 196): the icon bar icon's menu.
  'shell.menu.iconHide': '隐藏',
  'shell.menu.iconMove': '移到另一侧的栏',
  'shell.menu.iconSplit': "在拆分中打开",
  // system5 (ticket 196): tooltips of the status line's two counts.
  'shell.status.staleTip': '跳到停滞的会话',
  // V2.5-54 A12: the rails, their tooltips and the zone tab strip follow the language (English kind ids stay searchable).
  'shell.widget.tree': '树',
  'shell.widget.agents': '代理',
  'shell.widget.waiting': "回答栏",
  'shell.widget.terminal': '终端',
  'shell.widget.composer': '输入框',
  'shell.widget.diff': '差异',
  'shell.widget.files': '文件',
  'shell.widget.board': '看板',
  'shell.widget.search': '搜索',
  'shell.widget.preview': '预览',
  'shell.widget.artifacts': "产物",
  'shell.widget.decisions': "决策",
  'shell.widget.settings': '设置',
  'shell.widget.layout': '布局',
  'shell.widget.browser': '浏览器',
  'shell.tip.tree': '树：项目、工作树和会话',
  'shell.tip.diff': '差异：会话开始后的更改',
  'shell.tip.terminal': "终端：此会话的侧边面板",
  'shell.tip.artifacts': "产物：此会话的附件、产物和已更改文件",
  'shell.tip.layout': '布局：栏、小组件和区域',
  'shell.layout.editing': '正在编辑布局 · 完成',
  'shell.layout.done': '完成',
  'shell.zone.chat': '聊天',
  'shell.centreStays': '中央聊天会保留在窗口中：请把其他小组件放在它旁边',
  'shell.terminalIcon.noSession': '打开一个代理会话即可查看其终端',
  'shell.terminalIcon.inCentre': '此会话在中央显示其终端',
  'shell.browserIcon.noSession': '打开一个代理会话即可使用其浏览器',
  // Ticket 425: the window while the core is only slow to start (no attempt failed yet).
  'shell.boot.starting': 'Nunchiro 正在启动',
  "shell.boot.startingNote": "后台服务仍在启动。准备就绪后，此窗口会自动打开。",
  // Ticket 408 / rail names: the icon bars' own names (bar, folded icon, the overflow button and menu, edit-mode remove).
  'shell.rail.left': '左栏',
  'shell.rail.right': '右栏',
  'shell.rail.folded': '{name}（已折叠）',
  'shell.rail.more': '另外 {n} 个图标',
  'shell.rail.moreMenu': '更多图标',
  'shell.rail.cutOff': '因窗口高度被截断',
  'shell.rail.removeLeft': '从左栏移除 {name}',
  'shell.rail.removeRight': '从右栏移除 {name}',
  "shell.boot.fail.start": "Nunchiro 无法启动或更新其后台服务。请重试，或退出后重新打开 Nunchiro。",
  'shell.boot.fail.cli': 'Nunchiro 无法运行自带的命令行工具。如果反复出现，请重新安装 Nunchiro。',
  "shell.boot.fail.refused": "后台服务拒绝了此窗口。请退出 Nunchiro 后重新打开。",
  "shell.boot.fail.timeout": "后台服务未及时响应。请重试，或退出后重新打开 Nunchiro。",
  'shell.crash.title': '此窗口出现问题',
  "shell.crash.note": "会话仍在后台服务中运行。重新载入窗口即可再次看到它们。",
  'shell.crash.reload': '重新载入窗口',
  'shell.crash.copy': '复制详细信息',
};

export const zhHant = {
  'shell.scope.all': '所有專案',
  // needs 157 (2): the Tree card's line in Layout's widget library (placement item 2, mockup m2).
  'shell.tree.card': "始終在配置中，可移動",
  // system4: the path and message menus (data-menu-arg is the text).
  'shell.menu.pathCopy': '複製路徑',
  'shell.menu.pathReveal': '在 Finder 中顯示',
  'shell.menu.messageCopy': '複製',
  // system5 (ticket 196): the icon bar icon's menu.
  'shell.menu.iconHide': '隱藏',
  'shell.menu.iconMove': '移到另一側的圖示欄',
  'shell.menu.iconSplit': '在分割視窗中開啟',
  // system5 (ticket 196): tooltips of the status line's two counts.
  'shell.status.staleTip': '跳到停滯的工作階段',
  // V2.5-54 A12: the rails, their tooltips and the zone tab strip follow the language (English kind ids stay searchable).
  'shell.widget.tree': '樹狀清單',
  'shell.widget.agents': "代理",
  'shell.widget.waiting': '回答列',
  'shell.widget.terminal': '終端',
  'shell.widget.composer': '輸入框',
  'shell.widget.diff': '差異',
  'shell.widget.files': '檔案',
  'shell.widget.board': '看板',
  'shell.widget.search': '搜尋',
  'shell.widget.preview': '預覽',
  'shell.widget.artifacts': "產物",
  'shell.widget.decisions': "決策",
  'shell.widget.settings': '設定',
  'shell.widget.layout': "配置",
  'shell.widget.browser': '瀏覽器',
  'shell.tip.tree': '樹狀清單：專案、工作樹和工作階段',
  'shell.tip.diff': '差異：工作階段開始後的變更',
  'shell.tip.terminal': '終端：此工作階段的側邊面板',
  'shell.tip.artifacts': "產物：此工作階段的附件、產物和已變更檔案",
  'shell.tip.layout': "配置：圖示欄、小工具和區域",
  'shell.layout.editing': "正在編輯配置 · 完成",
  'shell.layout.done': '完成',
  'shell.zone.chat': '聊天',
  'shell.centreStays': '中央聊天會保留在視窗中：請把其他小工具放在它旁邊',
  'shell.terminalIcon.noSession': '開啟一個代理工作階段即可查看其終端',
  'shell.terminalIcon.inCentre': '此工作階段在中央顯示其終端',
  'shell.browserIcon.noSession': '開啟一個代理工作階段即可使用其瀏覽器',
  // Ticket 425: the window while the core is only slow to start (no attempt failed yet).
  'shell.boot.starting': 'Nunchiro 正在啟動',
  "shell.boot.startingNote": "背景服務仍在啟動。準備就緒後，此視窗會自動開啟。",
  // Ticket 408 / rail names: the icon bars' own names (bar, folded icon, the overflow button and menu, edit-mode remove).
  'shell.rail.left': '左側圖示欄',
  'shell.rail.right': '右側圖示欄',
  'shell.rail.folded': '{name}（已摺疊）',
  'shell.rail.more': '另外 {n} 個圖示',
  'shell.rail.moreMenu': '更多圖示',
  'shell.rail.cutOff': '因視窗高度被截斷',
  'shell.rail.removeLeft': '從左側圖示欄移除 {name}',
  'shell.rail.removeRight': '從右側圖示欄移除 {name}',
  "shell.boot.fail.start": "Nunchiro 無法啟動或更新其背景服務。請重試，或結束後重新開啟 Nunchiro。",
  'shell.boot.fail.cli': 'Nunchiro 無法執行內建的命令列工具。若反覆發生，請重新安裝 Nunchiro。',
  "shell.boot.fail.refused": "背景服務拒絕了此視窗。請結束 Nunchiro 後重新開啟。",
  "shell.boot.fail.timeout": "背景服務未及時回應。請重試，或結束後重新開啟 Nunchiro。",
  'shell.crash.title': '此視窗發生問題',
  "shell.crash.note": "工作階段仍在背景服務中執行。重新載入視窗即可再次看到它們。",
  'shell.crash.reload': '重新載入視窗',
  'shell.crash.copy': '複製詳細資訊',
};

export const es = {
  'shell.scope.all': 'Todos los proyectos',
  // needs 157 (2): the Tree card's line in Layout's widget library (placement item 2, mockup m2).
  'shell.tree.card': "siempre en la disposición; puedes moverlo",
  // system4: the path and message menus (data-menu-arg is the text).
  'shell.menu.pathCopy': 'Copiar ruta',
  'shell.menu.pathReveal': 'Mostrar en Finder',
  'shell.menu.messageCopy': 'Copiar',
  // system5 (ticket 196): the icon bar icon's menu.
  'shell.menu.iconHide': 'Ocultar',
  'shell.menu.iconMove': 'Mover a la otra barra',
  'shell.menu.iconSplit': 'Abrir en división',
  // system5 (ticket 196): tooltips of the status line's two counts.
  'shell.status.staleTip': 'Ir a una sesión estancada',
  // V2.5-54 A12: the rails, their tooltips and the zone tab strip follow the language (English kind ids stay searchable).
  'shell.widget.tree': 'Árbol',
  'shell.widget.agents': 'Agentes',
  'shell.widget.waiting': "Franja de respuestas",
  'shell.widget.terminal': 'Terminal',
  'shell.widget.composer': "Campo de escritura",
  'shell.widget.diff': 'Diff',
  'shell.widget.files': 'Archivos',
  'shell.widget.board': 'Tablero',
  'shell.widget.search': 'Buscar',
  'shell.widget.preview': 'Vista previa',
  'shell.widget.artifacts': 'Artefactos',
  'shell.widget.decisions': 'Decisiones',
  'shell.widget.settings': 'Ajustes',
  'shell.widget.layout': "Disposición",
  'shell.widget.browser': 'Navegador',
  'shell.tip.tree': "Árbol: proyectos, árboles de trabajo y sesiones",
  'shell.tip.diff': 'Diff: cambios desde que empezó la sesión',
  'shell.tip.terminal': 'Terminal: panel lateral de esta sesión',
  'shell.tip.artifacts': 'Artefactos: adjuntos, artefactos y archivos cambiados de esta sesión',
  'shell.tip.layout': "Disposición: barras, widgets y zonas",
  'shell.layout.editing': "Editando la disposición · Listo",
  'shell.layout.done': 'Listo',
  'shell.zone.chat': 'Chat',
  'shell.centreStays': 'El chat central se queda en la ventana: coloca otros widgets a su lado',
  'shell.terminalIcon.noSession': 'Abre una sesión de agente para ver su terminal',
  'shell.terminalIcon.inCentre': 'Esta sesión muestra su terminal en el centro',
  'shell.browserIcon.noSession': 'Abre una sesión de agente para usar su navegador',
  // Ticket 425: the window while the core is only slow to start (no attempt failed yet).
  'shell.boot.starting': 'Nunchiro se está iniciando',
  "shell.boot.startingNote": "El servicio en segundo plano aún se está iniciando. Esta ventana se abrirá sola cuando esté listo.",
  // Ticket 408 / rail names: the icon bars' own names (bar, folded icon, the overflow button and menu, edit-mode remove).
  'shell.rail.left': 'Barra izquierda',
  'shell.rail.right': 'Barra derecha',
  'shell.rail.folded': '{name} (plegado)',
  'shell.rail.more': '{n} iconos más',
  'shell.rail.moreMenu': 'Más iconos',
  'shell.rail.cutOff': 'Cortado por la altura de la ventana',
  'shell.rail.removeLeft': 'Quitar {name} de la barra izquierda',
  'shell.rail.removeRight': 'Quitar {name} de la barra derecha',
  "shell.boot.fail.start": "Nunchiro no pudo iniciar ni actualizar su servicio en segundo plano. Reintenta, o cierra Nunchiro y ábrelo de nuevo.",
  'shell.boot.fail.cli': 'Nunchiro no pudo ejecutar su propia herramienta de línea de comandos. Si sigue pasando, reinstala Nunchiro.',
  "shell.boot.fail.refused": "El servicio en segundo plano rechazó esta ventana. Cierra Nunchiro y ábrelo de nuevo.",
  "shell.boot.fail.timeout": "El servicio en segundo plano no respondió a tiempo. Reintenta, o cierra Nunchiro y ábrelo de nuevo.",
  'shell.crash.title': 'Esta ventana tuvo un problema',
  "shell.crash.note": "Tus sesiones siguen ejecutándose en el servicio en segundo plano. Recarga la ventana para volver a verlas.",
  'shell.crash.reload': 'Recargar ventana',
  'shell.crash.copy': 'Copiar detalles',
};

export const fr = {
  'shell.scope.all': 'Tous les projets',
  // needs 157 (2): the Tree card's line in Layout's widget library (placement item 2, mockup m2).
  'shell.tree.card': "toujours dans la disposition ; vous pouvez le déplacer",
  // system4: the path and message menus (data-menu-arg is the text).
  'shell.menu.pathCopy': 'Copier le chemin',
  'shell.menu.pathReveal': "Afficher dans le Finder",
  'shell.menu.messageCopy': 'Copier',
  // system5 (ticket 196): the icon bar icon's menu.
  'shell.menu.iconHide': 'Masquer',
  'shell.menu.iconMove': 'Déplacer vers l’autre barre',
  'shell.menu.iconSplit': "Ouvrir en division",
  // system5 (ticket 196): tooltips of the status line's two counts.
  'shell.status.staleTip': "Aller à une session immobile",
  // V2.5-54 A12: the rails, their tooltips and the zone tab strip follow the language (English kind ids stay searchable).
  'shell.widget.tree': 'Arborescence',
  'shell.widget.agents': 'Agents',
  'shell.widget.waiting': "Bande de réponse",
  'shell.widget.terminal': 'Terminal',
  'shell.widget.composer': 'Zone de saisie',
  'shell.widget.diff': 'Diff',
  'shell.widget.files': 'Fichiers',
  'shell.widget.board': 'Tableau',
  'shell.widget.search': 'Recherche',
  'shell.widget.preview': 'Aperçu',
  'shell.widget.artifacts': 'Artefacts',
  'shell.widget.decisions': 'Décisions',
  'shell.widget.settings': 'Réglages',
  'shell.widget.layout': 'Disposition',
  'shell.widget.browser': 'Navigateur',
  'shell.tip.tree': 'Arborescence : projets, arbres de travail et sessions',
  'shell.tip.diff': 'Diff : changements depuis le début de la session',
  'shell.tip.terminal': "Terminal : le volet latéral de cette session",
  'shell.tip.artifacts': 'Artefacts : pièces jointes, artefacts et fichiers modifiés de cette session',
  'shell.tip.layout': 'Disposition : barres, widgets et zones',
  'shell.layout.editing': 'Modification de la disposition · Terminé',
  'shell.layout.done': 'Terminé',
  'shell.zone.chat': "Conversation",
  'shell.centreStays': "La conversation centrale reste dans la fenêtre : placez les autres widgets à côté",
  'shell.terminalIcon.noSession': 'Ouvrez une session d’agent pour voir son terminal',
  'shell.terminalIcon.inCentre': 'Cette session affiche son terminal au centre',
  'shell.browserIcon.noSession': 'Ouvrez une session d’agent pour utiliser son navigateur',
  // Ticket 425: the window while the core is only slow to start (no attempt failed yet).
  'shell.boot.starting': 'Nunchiro démarre',
  "shell.boot.startingNote": "Le service d’arrière-plan est encore en train de démarrer. Cette fenêtre s’ouvre d’elle-même dès qu’il est prêt.",
  // Ticket 408 / rail names: the icon bars' own names (bar, folded icon, the overflow button and menu, edit-mode remove).
  'shell.rail.left': 'Barre de gauche',
  'shell.rail.right': 'Barre de droite',
  'shell.rail.folded': '{name} (replié)',
  'shell.rail.more': '{n} icônes de plus',
  'shell.rail.moreMenu': 'Plus d’icônes',
  'shell.rail.cutOff': 'Coupé par la hauteur de la fenêtre',
  'shell.rail.removeLeft': 'Retirer {name} de la barre de gauche',
  'shell.rail.removeRight': 'Retirer {name} de la barre de droite',
  "shell.boot.fail.start": "Nunchiro n’a pas pu démarrer ni mettre à jour son service d’arrière-plan. Réessayez, ou quittez Nunchiro et rouvrez-le.",
  'shell.boot.fail.cli': 'Nunchiro n’a pas pu lancer son propre outil en ligne de commande. Si cela se répète, réinstallez Nunchiro.',
  "shell.boot.fail.refused": "Le service d’arrière-plan a refusé cette fenêtre. Quittez Nunchiro et rouvrez-le.",
  "shell.boot.fail.timeout": "Le service d’arrière-plan n’a pas répondu à temps. Réessayez, ou quittez Nunchiro et rouvrez-le.",
  'shell.crash.title': 'Cette fenêtre a rencontré un problème',
  "shell.crash.note": "Vos sessions continuent de tourner dans le service d’arrière-plan. Rechargez la fenêtre pour les revoir.",
  'shell.crash.reload': 'Recharger la fenêtre',
  'shell.crash.copy': 'Copier les détails',
};

export const pt = {
  'shell.scope.all': 'Todos os projetos',
  // needs 157 (2): the Tree card's line in Layout's widget library (placement item 2, mockup m2).
  'shell.tree.card': "Sempre na disposição; você pode movê-la",
  // system4: the path and message menus (data-menu-arg is the text).
  'shell.menu.pathCopy': 'Copiar caminho',
  'shell.menu.pathReveal': 'Mostrar no Finder',
  'shell.menu.messageCopy': 'Copiar',
  // system5 (ticket 196): the icon bar icon's menu.
  'shell.menu.iconHide': 'Ocultar',
  'shell.menu.iconMove': 'Mover para a outra barra',
  'shell.menu.iconSplit': 'Abrir em divisão',
  // system5 (ticket 196): tooltips of the status line's two counts.
  'shell.status.staleTip': 'Ir para uma sessão parada',
  // V2.5-54 A12: the rails, their tooltips and the zone tab strip follow the language (English kind ids stay searchable).
  'shell.widget.tree': 'Árvore',
  'shell.widget.agents': 'Agentes',
  'shell.widget.waiting': "Faixa de respostas",
  'shell.widget.terminal': 'Terminal',
  'shell.widget.composer': "Caixa de mensagem",
  'shell.widget.diff': 'Diff',
  'shell.widget.files': 'Arquivos',
  'shell.widget.board': 'Quadro',
  'shell.widget.search': 'Busca',
  'shell.widget.preview': "Prévia",
  'shell.widget.artifacts': 'Artefatos',
  'shell.widget.decisions': 'Decisões',
  'shell.widget.settings': 'Configurações',
  'shell.widget.layout': "Disposição",
  'shell.widget.browser': 'Navegador',
  'shell.tip.tree': "Árvore: projetos, árvores de trabalho e sessões",
  'shell.tip.diff': 'Diff: mudanças desde o início da sessão',
  'shell.tip.terminal': 'Terminal: painel lateral desta sessão',
  'shell.tip.artifacts': 'Artefatos: anexos, artefatos e arquivos alterados desta sessão',
  'shell.tip.layout': "Disposição: barras, widgets e zonas",
  'shell.layout.editing': "Editando a disposição · Concluído",
  'shell.layout.done': 'Concluído',
  'shell.zone.chat': "Conversa",
  'shell.centreStays': "A conversa central fica na janela: coloque os outros widgets ao lado dela",
  'shell.terminalIcon.noSession': 'Abra uma sessão de agente para ver o terminal',
  'shell.terminalIcon.inCentre': 'Esta sessão mostra o terminal no centro',
  'shell.browserIcon.noSession': 'Abra uma sessão de agente para usar o navegador',
  // Ticket 425: the window while the core is only slow to start (no attempt failed yet).
  'shell.boot.starting': 'O Nunchiro está iniciando',
  "shell.boot.startingNote": "O serviço em segundo plano ainda está iniciando. Esta janela abre sozinha quando ele estiver pronto.",
  // Ticket 408 / rail names: the icon bars' own names (bar, folded icon, the overflow button and menu, edit-mode remove).
  'shell.rail.left': 'Barra esquerda',
  'shell.rail.right': 'Barra direita',
  'shell.rail.folded': '{name} (recolhido)',
  'shell.rail.more': 'Mais {n} ícones',
  'shell.rail.moreMenu': 'Mais ícones',
  'shell.rail.cutOff': 'Cortado pela altura da janela',
  'shell.rail.removeLeft': 'Remover {name} da barra esquerda',
  'shell.rail.removeRight': 'Remover {name} da barra direita',
  "shell.boot.fail.start": "O Nunchiro não conseguiu iniciar nem atualizar o serviço em segundo plano. Tente de novo, ou feche o Nunchiro e abra-o outra vez.",
  'shell.boot.fail.cli': 'O Nunchiro não conseguiu executar a própria ferramenta de linha de comando. Se continuar, reinstale o Nunchiro.',
  "shell.boot.fail.refused": "O serviço em segundo plano recusou esta janela. Feche o Nunchiro e abra-o outra vez.",
  "shell.boot.fail.timeout": "O serviço em segundo plano não respondeu a tempo. Tente de novo, ou feche o Nunchiro e abra-o outra vez.",
  'shell.crash.title': 'Esta janela teve um problema',
  "shell.crash.note": "Suas sessões continuam em execução no serviço em segundo plano. Recarregue a janela para vê-las de novo.",
  'shell.crash.reload': 'Recarregar janela',
  'shell.crash.copy': 'Copiar detalhes',
};
