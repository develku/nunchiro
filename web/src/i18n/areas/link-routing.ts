// Ticket 256 (needs 197, G06): Settings › In-app browser › Links (features/link-routing.tsx).
declare module '../index' {
  interface AreaKeys {
    'lroute.links': true;
    'lroute.openIn': true;
    'lroute.openInDesc': true;
    'lroute.system': true;
    'lroute.inApp': true;
    'lroute.shift': true;
    'lroute.background': true;
    'lroute.backgroundDesc': true;
    'field.linksOpenIn': true;
    'field.linksShift': true;
    'field.linksBackground': true;
  }
}

export const en = {
  'lroute.links': 'Links',
  'lroute.openIn': 'Open http(s) links in',
  'lroute.openInDesc': 'Links you click in a terminal, the chat or a file. Artifacts and widgets always use your browser.',
  'lroute.system': 'Your browser',
  'lroute.inApp': 'In-app browser',
  'lroute.shift': 'Shift+click opens the other browser',
  'lroute.background': 'Open in the background',
  'lroute.backgroundDesc': 'A link from a terminal or chat waits for the Browser tab of the session. It loads when you next open that tab, or at once if the tab is already open. A later link replaces it. It pauses the control of the agent over that browser.',
  'field.linksOpenIn': 'Open http(s) links in',
  'field.linksShift': 'Shift+click opens the other one',
  'field.linksBackground': 'Open links in the background',
};

export const ko = {
  'lroute.links': '링크',
  'lroute.openIn': "http(s) 링크 열 위치",
  'lroute.openInDesc': '터미널, 채팅, 파일에서 클릭한 링크입니다. 아티팩트와 위젯은 항상 내 브라우저를 씁니다.',
  'lroute.system': '내 브라우저',
  'lroute.inApp': '앱 안 브라우저',
  'lroute.shift': "Shift+클릭하면 다른 쪽으로 엽니다",
  'lroute.background': '백그라운드에서 열기',
  'lroute.backgroundDesc': '터미널이나 채팅 링크는 세션의 브라우저 탭을 기다립니다. 다음에 그 탭을 열 때 불러오고(나중 링크가 앞 링크를 대신합니다), 탭이 보이고 있으면 바로 불러옵니다. 그 브라우저에 대한 에이전트의 제어는 멈춥니다.',
  'field.linksOpenIn': "http(s) 링크 열 위치",
  'field.linksShift': "Shift+클릭하면 다른 쪽으로 엽니다",
  'field.linksBackground': '링크를 백그라운드에서 열기',
};

export const ja = {
  'lroute.links': 'リンク',
  'lroute.openIn': 'http(s) リンクを開く場所',
  'lroute.openInDesc': "ターミナル、チャット、ファイルでクリックしたリンク。アーティファクトとウィジェットは常に自分のブラウザを使います。",
  'lroute.system': "自分のブラウザ",
  'lroute.inApp': "アプリ内ブラウザ",
  'lroute.shift': 'Shift+クリックでもう一方で開く',
  'lroute.background': 'バックグラウンドで開く',
  'lroute.backgroundDesc': "ターミナルやチャットのリンクはセッションのブラウザタブを待ちます。次にそのタブを開いたときに読み込み（後のリンクが前のリンクに置き換わります）、タブが表示中ならすぐに読み込みます。そのブラウザのエージェント操作は一時停止します。",
  'field.linksOpenIn': 'http(s) リンクを開く場所',
  'field.linksShift': 'Shift+クリックでもう一方で開く',
  'field.linksBackground': 'リンクをバックグラウンドで開く',
};

export const zhHans = {
  'lroute.links': '链接',
  'lroute.openIn': 'http(s) 链接打开位置',
  'lroute.openInDesc': "在终端、聊天或文件中点击的链接。产物和小组件始终使用你的浏览器。",
  'lroute.system': '你的浏览器',
  'lroute.inApp': '应用内浏览器',
  'lroute.shift': 'Shift+点击用另一个打开',
  'lroute.background': '在后台打开',
  'lroute.backgroundDesc': '终端或聊天链接会等待会话的浏览器选项卡：下次打开该选项卡时加载（后一个链接会替换前一个），如果选项卡正在显示则立即加载。这会暂停代理对该浏览器的控制。',
  'field.linksOpenIn': 'http(s) 链接打开位置',
  'field.linksShift': 'Shift+点击用另一个打开',
  'field.linksBackground': '在后台打开链接',
};

export const zhHant = {
  'lroute.links': '連結',
  'lroute.openIn': 'http(s) 連結開啟位置',
  'lroute.openInDesc': "在終端、聊天或檔案中點按的連結。產物和小工具一律使用你的瀏覽器。",
  'lroute.system': '你的瀏覽器',
  'lroute.inApp': 'App 內瀏覽器',
  'lroute.shift': 'Shift+點按用另一個開啟',
  'lroute.background': '在背景開啟',
  'lroute.backgroundDesc': '終端或聊天連結會等待工作階段的瀏覽器選項卡：下次開啟該選項卡時載入（後一個連結會取代前一個），若選項卡正在顯示則立即載入。這會暫停代理對該瀏覽器的控制。',
  'field.linksOpenIn': 'http(s) 連結開啟位置',
  'field.linksShift': 'Shift+點按用另一個開啟',
  'field.linksBackground': '在背景開啟連結',
};

export const es = {
  'lroute.links': 'Enlaces',
  'lroute.openIn': 'Abrir enlaces http(s) en',
  'lroute.openInDesc': 'Enlaces en los que haces clic en un terminal, el chat o un archivo. Los artefactos y widgets siempre usan tu navegador.',
  'lroute.system': 'Tu navegador',
  'lroute.inApp': 'Navegador integrado',
  'lroute.shift': 'Shift+clic abre el otro navegador',
  'lroute.background': 'Abrir en segundo plano',
  'lroute.backgroundDesc': 'Un enlace del terminal o del chat espera a la pestaña Navegador de la sesión: se carga al abrir esa pestaña (un enlace posterior lo sustituye), o al instante si la pestaña está visible. Pausa el control del agente sobre ese navegador.',
  'field.linksOpenIn': 'Abrir enlaces http(s) en',
  'field.linksShift': 'Shift+clic abre el otro',
  'field.linksBackground': 'Abrir enlaces en segundo plano',
};

export const fr = {
  'lroute.links': 'Liens',
  'lroute.openIn': 'Ouvrir les liens http(s) dans',
  'lroute.openInDesc': "Les liens cliqués dans un terminal, la conversation ou un fichier. Les artefacts et widgets utilisent toujours votre navigateur.",
  'lroute.system': 'Votre navigateur',
  'lroute.inApp': 'Navigateur intégré',
  'lroute.shift': 'Maj+clic ouvre l’autre',
  'lroute.background': 'Ouvrir en arrière-plan',
  'lroute.backgroundDesc': "Un lien du terminal ou de la conversation attend l’onglet Navigateur de la session : il se charge à la prochaine ouverture de cet onglet (un lien suivant le remplace), ou tout de suite si l’onglet est affiché. Il met en pause le contrôle de ce navigateur par l’agent.",
  'field.linksOpenIn': 'Ouvrir les liens http(s) dans',
  'field.linksShift': 'Maj+clic ouvre l’autre',
  'field.linksBackground': 'Ouvrir les liens en arrière-plan',
};

export const pt = {
  'lroute.links': 'Links',
  'lroute.openIn': 'Abrir links http(s) em',
  'lroute.openInDesc': "Links clicados em um terminal, na conversa ou em um arquivo. Artefatos e widgets sempre usam seu navegador.",
  'lroute.system': 'Seu navegador',
  'lroute.inApp': 'Navegador integrado',
  'lroute.shift': 'Shift+clique abre o outro',
  'lroute.background': 'Abrir em segundo plano',
  'lroute.backgroundDesc': "Um link do terminal ou da conversa espera pela aba Navegador da sessão: carrega quando você abrir essa aba (um link posterior o substitui), ou de imediato se a aba estiver visível. Ele pausa o controle do agente sobre esse navegador.",
  'field.linksOpenIn': 'Abrir links http(s) em',
  'field.linksShift': 'Shift+clique abre o outro',
  'field.linksBackground': 'Abrir links em segundo plano',
};
