# UI language terms

These catalogues translate window text only (needs 93; GLOSSARY.md, **UI language**).
Agent transcripts, terminal contents and user-created names remain in their original language.
Proper agent/model names, commands, placeholders, key names, paths and flags remain literal (French names four keys in French: see the 2026-11-20 decision below).

| Product term | ko | ja | zh-Hans | zh-Hant | es | fr | pt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Session | 세션 | セッション | 会话 | 工作階段 | sesión | session | sessão |
| Project | 프로젝트 | プロジェクト | 项目 | 專案 | proyecto | projet | projeto |
| Project group | 프로젝트 그룹 | プロジェクトグループ | 项目组 | 專案群組 | grupo de proyectos | groupe de projets | grupo de projetos |
| Worktree | 워크트리 | ワークツリー | 工作树 | 工作樹 | árbol de trabajo | arbre de travail | árvore de trabalho |
| Agent | 에이전트 | エージェント | 代理 | 代理 | agente | agent | agente |
| Model | 모델 | モデル | 模型 | 模型 | modelo | modèle | modelo |
| Board | 보드 | ボード | 看板 | 看板 | tablero | tableau | quadro |
| Card | 카드 | カード | 卡片 | 卡片 | tarjeta | carte | cartão |
| Artifact | 아티팩트 | アーティファクト | 产物 | 產物 | artefacto | artefact | artefato |
| Side chat | 보조 채팅 | サイドチャット | 侧边聊天 | 側邊聊天 | chat lateral | discussion latérale | conversa lateral |
| Side pane | 옆 패널 | サイドペイン | 侧边面板 | 側邊面板 | panel lateral | volet latéral | painel lateral |
| Decision | 결정 | 判断 | 决策 | 決策 | decisión | décision | decisão |
| Library | 라이브러리 | ライブラリ | 库 | 程式庫 | biblioteca | bibliothèque | biblioteca |
| Layout | 배치 | レイアウト | 布局 | 配置 | disposición | disposition | disposição |
| Tab | 탭 | タブ | 选项卡 | 選項卡 | pestaña | onglet | aba |
| Terminal | 터미널 | ターミナル | 终端 | 終端 | terminal | terminal | terminal |
| Machine | 머신 | マシン | 机器 | 機器 | máquina | machine | máquina |
| Branch | 브랜치 | ブランチ | 分支 | 分支 | rama | branche | branch |
| Chat | 채팅 | チャット | 聊天 | 聊天 | chat | conversation | conversa |
| Kind key | 종류 키 | 種類キー | 类别键 | 類別鍵 | tecla de tipo | touche de type | tecla de tipo |
| Background service (the core, when the window names it) | 백그라운드 서비스 | バックグラウンドサービス | 后台服务 | 背景服務 | servicio en segundo plano | service d'arrière-plan | serviço em segundo plano |

Korean uses short noun or action labels and formal sentences. The English `Space`
retired from the project tree remains retired in translations: groups are Project groups.
Portuguese uses Brazilian UI spelling; Spanish and French avoid regional keyboard names.

Term traps the drafts got wrong, now fixed and worth keeping fixed:

- **Key** is a keyboard key (`키`, `キー`, `按键`/`按鍵`, `tecla`, `touche`, `tecla`), never a
  door key, a credential, or a "kind"/"gentle" adjective. `kindKey` is a key of a kind
  group, not an amiable key.
- **Kind** is a category, not `amable`/`gentil`/`gentil`/`善良`.
- **Branch** is Git, not a tree bough, a phone line, or a Portuguese `filial`.
- **Session** stays `session` in French; `séance` reads as a cinema showing.
- **Tab** is the UI tab; the Spanish `cortina a la italiana` is a window blind.
- **Terminal** is the emulator; Japanese uses `ターミナル` throughout, never `端末`.
- **Sign in/out** keeps one verb per language (`로그인`/`ログイン`/`登录`/`登入`/`iniciar sesión`/
  `connexion`/`Entrar`); Japanese does not mix `サインイン` with `ログイン`. Portuguese buttons say `Entrar`
  (sentences may say `fazer login`), and `login` stays the noun (`Método de login`).
- **Machine** is the SSH host; Japanese `機械` is a physical device, not a computer.
- **Retry / Show / Dismiss / Custom / Actions / Resume** are UI verbs, not `rever`, `espectáculo`,
  `despedir`, `coutume`, `actes` or a CV.

Decided 2026-11-16 (ticket 991, the native-level read): ko **Worktree** is `워크트리`. `작업 트리` is Git's own Korean for the working tree (the checked-out files), a different thing; Korean developers say `워크트리` for `git worktree`, and the other Korean product terms are loanwords too (세션, 보드, 아티팩트). ko **Hook** is `훅` (the standard loanword form). ko UI bars are `바` (왼쪽 바), not `막대`.

Decided 2026-11-19 (the Q9 native reads): the **Diff** pane. ko keeps the name `Diff` in Latin in every place (the Korean read found three words for it: 변경, 변경 사항, 변경 비교); ja is `差分`; zh-Hans `差异`, zh-Hant `差異`; es, fr and pt keep `Diff` as the pane's name. The scans keep `Diff` as a name (tests/fixtures/ui-scan.ts).

Decided 2026-11-20 (the Q5 native read, French), following Apple's French macOS, then Microsoft and Google:

- fr **Key names**: `Entrée`, `Échap`, `Maj` and `Espace`, in sentences and in chords (`Maj+Tab`, `Ctrl+Espace`,
  `Ctrl+Entrée`, `⌘Entrée`, `⌃Espace`); never `Enter`, `Esc`, `Shift` or `Space`. `Ctrl`, `Cmd`, `Option`, `Alt`, `Meta`,
  `Tab` and the symbols `⌘ ⌃ ⌥ ⇧ ↵` stay as they are. A lower-case English hint stays lower case (`esc` is `échap`).
  The spoken names in `a11y.key.*` keep the long forms (`Contrôle`, `Commande`, `Tabulation`).
- fr **Bypass permissions** is `Contourner les autorisations`, like its siblings `Accepter les modifications` and
  `Automatique`; a sentence says `le mode Contourner les autorisations`, and the tree badge says
  `Contourner les autorisations : activé`. The setting name `disableBypassPermissionsMode` stays literal.
  Codex's **Full access** is `Accès complet`.
- fr **Apostrophe** is the typographic `’` (U+2019) in every line (`l’agent`, `d’autorisation`, `aujourd’hui`).
  A straight `'` stays only inside a literal command, path or code sample.

Decided 2026-11-20 (the Q5 native read), Korean only. Each rule follows Apple's macOS Korean first, then Microsoft and Google, then the form most ko strings already had:

- ko **owner state words**, one Korean phrase per English phrase: `your turn` is `내 차례`; `needs you` and `waiting for you` are `내 답 대기`; `waiting for an answer` (an agent asked another agent) is `답 대기`; `waiting` is `대기 중`; `needs decision` (the board column and card state) is `결정 필요`; `needs attention` (a failed or stale session, not the owner's turn) is `주의 필요`. Do not write `확인 필요`, `내 확인 필요`, `내 답이 필요함` or `확인을 기다리는 중` for these. A full sentence may still say `내 답이 필요할 때`.
- ko **you** (the owner) is `나`/`내` (`내 결정`, `나에게 보고`), not `사용자`. `사용자` stays for an OS user and for the SSH user field.
- ko **confirm questions** (a dialog or card that asks before Nunchiro acts) end in `…하시겠습니까?` (`“{name}”을(를) 제거하시겠습니까?`), not `…할까요?`. A question that is not a confirmation keeps its own form (`무엇을 만들까요?`, `글자가 안 맞나요?`).
- ko **requests** end in `…하세요` (`다시 시도하세요`, `여세요`, `고르세요`), not `…해 주세요` and not `…하십시오`. The one kept `…해 주세요` is `settings.appearance.sampleAsk`, an example of what the user types to an agent.
- ko **Remove** is `제거`, **Delete** is `삭제`, **Clear** is `지우기`; follow the English verb. `지우다` is only Clear. A diff line that English calls removed is `삭제` (`{del}줄 삭제`, `삭제된 줄`), the usual Korean diff word. `Take out of a group` stays `빼기`. `palette.kw.*` search words may keep the other verbs as synonyms.
- ko **Edit** is `편집` in labels, sentences and counts (`편집`, `편집할 수 없습니다`, `편집 {n}건`). `고치다` is only Fix. `수정됨` stays for a file's Modified state and `수정 요청` for changes asked.
- ko **Scrollback** is `스크롤백` (Apple Terminal's Korean), never `스크롤 기록`, `출력 기록` or a bare `기록`. **Terminal history** (the saved-output setting) is `터미널 기록`.
- ko **Preview** and **Peek**, as a noun or a name, are `미리보기` in one word (Apple's form). The verb stays two words (`미리 보고`); for a sound it is `미리 듣기`.
- ko **Credentials** is `자격 증명`, not `인증 정보`.
- ko **particle after a placeholder**: write the paired form directly after `{name}` (one closing quote may sit between): `을(를)`, `이(가)`, `은(는)`, `와(과)`, `(으)로`, `(이)라는`. `makeT` picks the right one from the inserted word (`web/src/i18n/index.ts`, `particles`), so a fixed `{path}를` or `{agent}로` is a bug. The pair is not resolved after a bracket (`{name}({project})(으)로`) or when the caller fills the placeholder itself (`rich`, or `t` with no args): there, put a fixed noun before the particle (`{name}({project}) 세션으로 이동`, `ssh {alias} 명령을`), or keep the fixed particle that fits the fixed word (`{fullDisk}을`; `Home({name})이`, where the particle follows the word before the bracket).
- ko **quotes** are curly around a UI name or a user's name (`“ ”`, or `‘ ’` where English has single quotes). ASCII `"` stays only around a typed literal that English quotes the same way (`"{command}"`, `".."`).
- ko **punctuation** beside Hangul is the half-width ASCII form (`, : ? ( )`); full-width marks are for Japanese and Chinese only. `메뉴 막대` is Apple's name for the macOS menu bar and is outside the `바` rule. `Home` stays `Home` as a name.

Decided 2026-11-13 (ticket 527), following the large localized apps (VS Code, GitHub, Apple):

- pt **Sign in** is `Entrar`: GitHub pt-BR and Google label the button `Entrar`/`Fazer login`; the earlier
  glossary line said `login`, which reads as a noun on a button, so `login` stays only the noun.
- fr **Kind key** is `touche de type`: `touche` is a key on the keyboard; `clé` is a lock, data or SSH/API key.
  Every keyboard key on the Keys page is `touche`; `clé` stays for SSH, API, host and data keys.
- fr **Tree** is `arborescence`: VS Code fr names tree views so; `arbre` alone reads as a tree in a garden,
  and `arbre de travail` (Worktree) stays as it is.
- pt **Key** (keyboard) and **Kind key** are `tecla` and `tecla de tipo`: Apple and Google pt-BR say `tecla` for a key on
  the keyboard, as French says `touche`; `chave` is a lock, data, SSH or API key. Spanish likewise uses `tecla`, never
  `clave`, for a keyboard key. `Start at login` is `Iniciar no login` (the macOS login, a noun).
- es **register** is `tú` (the catalogue's form: `Elige`, `Marca`, `Pulsa`), not `usted` imperatives (`Elija`, `Marque`,
  `Presione`); checkbox labels use the infinitive (`Mantener este Mac activo`).

Consistency (ticket 527): Japanese writes `フォルダー` and `ウィンドウ` (the long-vowel and small-ィ forms the
catalogue already used most). Spanish quotes with `“ ”` (the form most lines and the English catalogue use;
not `« »` or ASCII `"`), except a quoted literal such as `".."`. Portuguese calls Nunchiro's settings
`Configurações`; `Ajustes do Sistema` (and its `Ajustes` button) is Apple's name for macOS System Settings.
French UI lines say `vous`; a prompt Nunchiro sends to an agent, and an example of what the user types to
one, keep `tu`. `tests/i18n-glossary-terms.spec.ts` counts each old term and lists the keys kept with a reason.

Each locale has the exact English key set, including both `.one` and `.other` entries.
Korean, Japanese and Chinese do not inflect count nouns; both entries express the count.
Spanish, French and Portuguese have singular and plural wording. A plural category other
than `one` is represented by the existing `.other` entry; no new suffix is a public key.
Callers keep their existing suffixes; `makeT` resolves count-bearing translated pairs with
`Intl.PluralRules`. Fixed-count singular strings without `{n}` retain the caller’s suffix
so zero cannot display a literal one. Missing translations still fall back per string to English.

Decided 2026-11-20 (the Q5 native read, Japanese cross-file choices; `ja` only):

- **Punctuation beside Japanese text is full-width**: `（ ）` and `：`, with no space outside the parentheses and none after the colon (`保存先：board.toml`, `停止（Esc）`, `ベースブランチ（デフォルト：テキストから）`). The label colon is full-width after a placeholder, a Latin word or a key name too (`{name}：{state}`, `Esc：{effect}`, `この Mac：{local}`). ASCII `:` `(` `)` stay only inside a literal: a URL or path (`https://`, `user@host:path`), `http(s)`, `Copyright (c)`, a clock time, code, or a list of the characters themselves. Apple's macOS Japanese writes it this way; the catalogue was mixed.
- **Spacing**: one half-width space between Japanese text and a Latin word or a number (`Nunchiro が`, `{n} 件`, `1 つ`, `2 分後`, `URL を開く`), and around a placeholder that holds a Latin name, number, time, path or error (`{name} を削除`, `{time} にリセット`). No space when the placeholder holds a Japanese UI word such as a page, widget, setting, command or kind name (`{page}を開く`, `{name}を閉じる`, `{label}をデフォルトに戻す`; "設定 を閉じる" was a defect, see `ja_close_label_has_no_stray_space`), between a duration and `前` (`{age}前に質問`), or next to full-width punctuation. Apple's own Japanese omits the Latin/Japanese space; this catalogue keeps it because 94% of its lines already have it, as Microsoft, Google and VS Code do.
- **Session states**: Waiting (a session waits for the user's answer) is `待機中`; Idle is `アイドル`. `待機` is not used for idle, for resting assistants (`休憩中`) or for queued messages (`キュー`, `キュー内のメッセージ`).
- **Needs you** is `要対応` as a label, chip or count and `あなたの対応が必要` in a sentence. **Waiting for you** is `あなたの対応待ち`. **Your turn** is `あなたの番`. **Waiting for an answer** is `回答待ち`. **Needs decision** is `要判断`. An answer is `回答`, not `返答`; `返信` is a reply message.
- **Update** (a tool or app update) is `アップデート` (`今すぐアップデート`, `アップデートできません`), as Apple's macOS Japanese writes it; `更新` stays for refreshing a list or a page. **Conflict** (Git) is `競合`, not `コンフリクト`. **Pause** is `一時停止` (its pair is `再開`); `停止` is Stop. **Editor** is `エディター`.
- **Home** is `ホーム` (`ホームのリーダー`, `ホームのルーム`), as the window label shows; not the Latin `Home`.
- **Buttons, menu items, commands, option and checkbox labels** end on the noun of a する-verb (`パスをコピー`, `カードを編集`, `作成して開始`, `毎回確認`), never `〜する`. Native verbs keep the dictionary form (`開く`, `閉じる`, `巻き戻す`) and `〜にする` stays (`オンにする`, `デフォルトにする`). A description or tooltip that explains what happens may be a full sentence (`〜します`).
- **macOS pane names** follow Apple's wording but keep this catalogue's `フォルダー` (`ファイルとフォルダー`; Apple writes `ファイルとフォルダ`), so one sentence never mixes the two spellings and `tests/i18n-glossary-terms.spec.ts` needs no kept key.

Decided 2026-11-20 (the Q5 native read), **Simplified Chinese (zh-Hans)**, following Apple's own zh_CN strings first, then the form most of the catalogue uses:

- **New X** as a command, button or dialog name is `新建X` (`新建会话`, `新建工作树`, `新建终端`, `新建项目`), as Apple writes `新建窗口` and `新建标签页`. A new thing as a noun stays `新X` (`新会话默认值`, `用于新会话`, the untitled tab name `新选项卡`).
- **Shell** is written `Shell`, capitalised, in every shown string (Apple Terminal: `默认登录Shell`, `在Shell中运行`); never `shell`.
- **Not now** (button) is `以后` (Apple's `Not Now`). **Not yet** is `暂不`, **Later** is `稍后`. A note about a declined card says `你暂缓了…` and does not quote the button.
- **Ask now** is `立即询问`; the permission question is `询问`, not `请求`.
- **Agents / Roles in the Room and Team view** are `代理` and `角色`. `席位` (seat) is retired, as in English.
- **Place** (where a lead works: a project or Home) is `此处` / `每处`, not `位置` beside `负责人` or `角色`, where it reads as a job post. `位置` stays for a location (`工作位置`, `所在位置`).
- **gh** is named `GitHub CLI (gh)` where English says "the GitHub CLI (gh)"; plain `gh` stays where English says `gh` (a command to run, or "your gh").
- **Key names** stay as English shows them: `Esc` (not `Escape`), `Enter`, `Shift`, `Space`.
- **Final 。**: a string that is a sentence, or has a clause break (，；：), ends in `。`. Labels, buttons, titles, compact status lines joined with `·` or `=`, and strings that end in a bracket take none.
- **Spaces**: one space between Chinese and a Latin word, a number, or a placeholder that holds Latin text, a number or a user-given name (`设置 {label}`, `{n} 天前`, `新 {n}`). No space when the placeholder always holds translated Chinese UI text (a page, section, command, widget or state name: `更改{title}`, `将{section}恢复默认`) or a count phrase (`{files}中有 {matches}`), and none beside full-width punctuation.
- **Brackets**: half-width `( )` with a space outside when the bracket holds only a key, symbol, number, unit or Latin code (`关闭 (Esc)`, `GitHub CLI (gh)`, `可清理 ({n})`, `({mb} MB)`), as Apple writes `安全Shell (ssh)`. Full-width `（）` when the bracket holds Chinese or a placeholder that can hold Chinese (`（{project}）`, `（发送给代理）`). `tests/i18n-translations.spec.ts` fails a half-width bracket with Chinese inside.
- **Count chips**: "new {n}" is `新 {n}` in every chip (tree row, tree group, board, strip).

Decided 2026-11-20 (the Q5 native read), zh-Hant. Where forms compete, the order is: Apple's macOS zh_TW strings, then Microsoft and Google, then the form most strings in the catalogue use.

- zh-Hant **Tree** (the widget) is `樹狀清單` in every shown string (`從樹狀清單移除…`, `專案樹狀清單`); a row in it is `樹狀清單列`. Not `樹`, `專案樹`, `樹狀結構` or `樹狀`. `工作樹` (Worktree) stays.
- zh-Hant **Home** is `首頁`, as the window label shows; not `主頁` or Latin `Home`. The user's home folder is `主資料夾`.
- zh-Hant **Receipt** (the board's proof of work) is `佐證`; `憑證` is credentials only.
- zh-Hant **Shell** is written `shell`, lower case (Apple zh_TW: `登入 shell`), in every shown string; **Needs you** (a label, chip or count) is `需要你處理`, **Waiting for you** is `等你處理`; the GitHub CLI is `GitHub CLI（gh）` where English names it; **Place** is `此處`, not `位置`, beside `負責人`.
- zh-Hant **Seat** is retired: follow the English (`角色` role, `代理` agent, `工作階段` session); no `席位`.
- zh-Hant **Bar** (the icon bar at a window edge) is `圖示欄` (`左側圖示欄`, `右側圖示欄`); **Sidebar** is `側邊欄` (Apple). `側欄` is not used.
- zh-Hant **App** is `App`, with a space on each CJK side (`此 App`, `App 內瀏覽器`), as Apple writes it; a CLI or terminal **program** is `程式`. `應用程式` stays only as a palette search word.
- zh-Hant **Reset** is `重置` (Apple; also the Codex `重置券`): `重置為預設值`, `{time} 重置`. **Restore/Revert** is `還原` and **Undo** is `復原`. `重設` stays only as a palette search word.
- zh-Hant **New X** as a command, a button or a dialog title is `新增 X` (Apple: `新增標籤頁`): `新增工作階段`, `新增工作樹…`. `新`/`新的` is the adjective (`新工作階段的預設值`) and the default name of an untitled thing (`新終端`). **Create** is `建立`, **Add** is `新增`; `新建` is not used.
- zh-Hant **Pane** is `面板` (`側邊面板`, `面板模式`), not `窗格`.
- zh-Hant **Collapse** is `收合` and **Expand** is `展開`; `摺疊` is only **folded** (an icon folded on a bar).
- zh-Hant **record / log / history** is `記錄`, not `紀錄`.
- zh-Hant parentheses are full-width `（ ）` with no space around them, also around a key, a count or a file name (`停止（Esc）`, `全部更新（{n}）`). ASCII `( )` stays only inside a literal (`http(s)`, `Copyright (c)`).
- zh-Hant key names are written as English writes them (`Esc`, `Enter`, `Space`, `Shift`), not `esc` or `Escape`; the spoken names in `a11y.key.*` stay translated.
- zh-Hant palette search words (`palette.kw.*`) carry Apple's `標籤頁` beside `選項卡` for Tab. `分頁` is what most Taiwan users type, but `web/tests/i18n-glossary-terms.spec.ts` counts it as an old term on every key: add it only together with a `palette.kw.` exemption on that rule.

The initial drafts used Google Translate on the public MIT English catalogue, followed by
terminology and UI review. The app bundles literal strings; it never calls a translation
service or sends user/agent content for translation. Automated parity tests verify keys and
placeholder multiplicity, not linguistic quality; these are not native-speaker certification.

Decided 2026-11-20 (the Q5 native read, Spanish cross-file choices), following Apple's Spanish macOS first, then Microsoft and Google, then the form most lines already use:

- es **Home** is `Inicio` (`Líder de Inicio`, `la sala de Inicio`, `compañeros de Inicio`); it is not kept as a product name.
- es **PR / pull request** is masculine and stays in English: `el PR`, `este PR`, `un PR`, `el pull request`; the states agree (`Abierto`, `Cerrado`, `Fusionado`, `Aprobado`). The plural is written without `s`: `los PR`, `lista de PR`, never `PRs`. `solicitud de incorporación` stays only as a palette search word.
- es **Remove** has one verb per object. `Eliminar` when files or data on disk go: árbol de trabajo, cuenta, perfil del navegador, biblioteca de artefactos, tema importado, vista (and English Delete: tarjeta, columna). `Quitar` when the thing only leaves a list, bar, group or Nunchiro: proyecto del árbol, máquina, extensión, servidor MCP, compañero, nota, modelo añadido, comando ACP, tecla, widget, franja de respuestas. `Borrar` is Clear (cookies, historial). Palette search words keep both verbs.
- es **Rename** is `Renombrar` on buttons, menu items, commands and their accessible names (Apple's Finder command); running prose may say `cambiar el nombre`. The worktree label command is `Cambiar etiqueta…`, not `Cambiar nombre de etiqueta`.
- es **Prompt** has four words by sense: the message a user sends to an agent is `mensaje` (`Primer mensaje`, `Mensaje de usuario`); a question a terminal program shows and waits on is `pregunta` (`pregunta en el terminal`); what an agent asks for on a decision card, and a permission prompt, is `solicitud` (`solicitud de permiso`); the shell's or agent's input prompt is `prompt` (masculine). Not `aviso` or `indicador`.
- es **Menu bar** is `barra de menús` (Apple), and its number is `el contador de la barra de menús`, not `barra de menú` or `recuento`.
- es **Session states** agree with `sesión` (feminine): `estancada`, `inactiva`, `fallida`, `no leída`, `terminada`, `cerrada`.
- es A worktree record whose folder is gone is a `registro sin carpeta`, not a `registro desaparecido`.
- es Labels and menu hints start with a capital (`Comando de proyecto`, `Carpeta`). A line that is a full sentence ends with a full stop, as its English does; labels, legends with `=` and lower-case fragments take none.

Decided 2026-11-20 (the Q5 native read, Portuguese cross-file choices):

- pt **Signed in / Signed out** (a state, not a button): `Conectado` (`conectado a {host}`, `conectado como {account}`) and `Sem login`. `Signed out` and `Not signed in` are the same state and both read `Sem login`. `Desconectado` is only a lost connection (the window, the background service, a machine), never an account. Buttons stay `Entrar` / `Sair`; `login` stays the noun. Not `Login feito`.
- pt **Search** and **Find** are both `Buscar` (Apple pt-BR: Finder, Mail, Editar > Buscar); the noun is `busca` (`Limpar busca`, `texto da busca`, `resultados de busca`), and the Search pane and widget are named `Busca`. Searching inside something takes `em`: `Buscar nas sessões`, `Buscar nas configurações`, `Buscar no terminal`. Not `Pesquisar`, `Pesquisa` or `Localizar` in shown text; `palette.kw.*` keyword lists keep all three as synonyms. A web search engine is `mecanismo de busca`. `Encontrar` is find = locate (`Encontrar projeto`); `Procurar` is Browse and looking for agents or updates.
- pt **Retry / Check again / Test again / Sign in again** buttons end in `novamente` (`Tentar novamente`, `Verificar novamente`, `Testar novamente`, `Entrar novamente`), as Apple, Microsoft and Google label them. A sentence that names the button quotes it the same way (`Pressione Verificar novamente`). Ordinary sentences may say `de novo` (`tente de novo`).
- pt **Stale** is `parado`, agreeing with the noun it marks: a board card (`cartão`) is `parado` (`parado há {n} min`, `selo “parado”`), a session is `parada` (`paradas: {n}`), a project row is `parado`. Never `obsoleto`. `parado` is not used for idle (`inativo` / `inativa`) or for resumable (`pode ser retomada`). Other words on a board card agree with `cartão` too (`movido por você`).
- pt **Home** is `Início`, with the article in a sentence (`do Início`, `no Início`).
- pt **Key names** stay literal, also in the names VoiceOver reads (`a11y.key.*`): Control, Option, Shift, Command, Enter, Esc, Tab. Punctuation keys and Space are spoken words (`vírgula`, `ponto`, `barra`, `Espaço`).
- pt **Role ids** a user types stay literal: the Notes role example is `reviewer, builder…`, because a role note is matched against the seat's role id, not against the translated chip (`Revisor`, `Construtor`).
