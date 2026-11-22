// Ticket 601 round 2: one plain line per group of core reasons that share a next step (`err.h.*`; `src/errors-groups.ts` maps the
// reasons to them), 8 languages. Each says what happened and what to do; the core's own text stays under Details.
declare module '../index' {
  interface AreaKeys {
    'err.h.later': true;
    'err.h.fileBad': true;
    'err.h.limit': true;
    'err.h.value': true;
    'err.h.notFor': true;
    'err.h.signIn': true;
    'err.h.ghAnswer': true;
    'err.h.checkFirst': true;
    'err.h.agentStart': true;
    'err.h.inside': true;
    'err.h.io': true;
    'err.h.changed': true;
    'err.h.widgetBad': true;
    'err.h.machineFail': true;
    'err.h.actRefused': true;
    'err.h.ownSignin': true;
    'err.h.signOutFail': true;
    'err.h.gitOld': true;
    'err.h.homeFolder': true;
    'err.h.boardCycle': true;
    'err.h.notText': true;
    'err.h.onMac': true;
    'err.h.riskyCard': true;
    'err.h.shellPath': true;
    'err.h.answerDecisions': true;
    'err.h.nothingUndo': true;
    'err.h.noLimit': true;
    'err.h.nothingInterrupt': true;
    'err.h.cleanup': true;
    'err.h.teamLeft': true;
    'err.h.outboxOpen': true;
  }
}

export const en = {
  'err.h.later': "Nunchiro is busy or not ready right now. Wait a moment, then try again.",
  'err.h.fileBad': "A settings or data file has a problem. Details below name the file and the fault. Fix or remove that file, then try again.",
  'err.h.limit': "A limit was reached. Remove something you do not need, then try again.",
  'err.h.value': "A value you gave is not allowed here. Details below say which one. Change it, then try again.",
  'err.h.notFor': "That is not available for this kind of session, agent or item. Pick another one, or do it in the agent itself.",
  'err.h.signIn': "That service has no signed-in account. Sign in with its own tool in a terminal, then try again.",
  'err.h.ghAnswer': "The gh tool gave an answer Nunchiro cannot use. Update gh and check that it is signed in, then try again.",
  'err.h.checkFirst': "This needs a check first. Run the check, then try again.",
  'err.h.agentStart': "The agent did not start or did not answer. Details below say why. Check its command in a terminal, then run the check again.",
  'err.h.inside': "Something inside Nunchiro is not ready. Wait a moment, then try again. If it stays, restart Nunchiro.",
  'err.h.io': "A file operation failed. Details below say why. Check the folder’s permissions and free space, then try again.",
  'err.h.changed': "Something changed while you were working. Refresh, then try again.",
  'err.h.widgetBad': "The widget’s folder or widget.toml has a problem. Details below say what. Fix it, then check the widget again.",
  'err.h.machineFail': "Nunchiro could not reach that machine over SSH. Details below say why. Check the machine and your network, then try again.",
  'err.h.actRefused': "The widget’s action was refused and nothing was sent. Details below say why. Change what the widget sends, then try again.",
  'err.h.ownSignin': "This agent signs in with its own account, in a terminal and not in the browser. Use a terminal, or add another account.",
  'err.h.signOutFail': "The agent could not sign out here. Sign out in the agent’s own terminal.",
  'err.h.gitOld': "Your git is too old to read this repository safely. Install git 2.31 or later (for example `brew install git`), then try again.",
  'err.h.homeFolder': "That agent cannot run in your home folder itself. Pick a project folder.",
  'err.h.boardCycle': "That link would make a loop between cards. Pick another card.",
  'err.h.notText': "Nunchiro cannot show that file as text. Open it in an editor instead.",
  'err.h.onMac': "Answer this on the Mac where Nunchiro runs.",
  'err.h.riskyCard': "This request is risky, so it needs an extra step. Focus the answer in the decision card, then press Enter.",
  'err.h.shellPath': "Nunchiro could not read PATH from your login shell. Check your shell startup files, then try again.",
  'err.h.answerDecisions': "Another request is waiting that you have not seen. Answer it in the Decisions widget first, then try again.",
  'err.h.nothingUndo': "There is nothing to undo here yet. Make a change first.",
  'err.h.noLimit': "This session shows no usage limit with a reset time right now, so there is nothing to resume. Try again when the limit shows.",
  'err.h.nothingInterrupt': "The agent is idle, so there is nothing to interrupt. Type your message to send it.",
  'err.h.cleanup': "The cleanup script of the worktree failed, so the worktree was kept. Its cleanup tab shows the reason. Fix the script in Settings › Git & worktrees, then remove the worktree again.",
  'err.h.teamLeft': "The teammate was removed, but something it left could not be stopped or switched off. Details below say what is left to do.",
  'err.h.outboxOpen': "Your mail app or Calendar did not open, so the card is still waiting. Details below say why. Check that app, then press the button again.",
};

export const ko = {
  'err.h.later': "지금은 바쁘거나 준비되지 않았습니다. 잠시 기다린 뒤 다시 시도하세요.",
  'err.h.fileBad': "설정 또는 데이터 파일에 문제가 있습니다. 아래 상세 내용에 파일과 문제가 나와 있습니다. 그 파일을 고치거나 지운 뒤 다시 시도하세요.",
  'err.h.limit': "한도에 도달했습니다. 필요 없는 것을 지운 뒤 다시 시도하세요.",
  'err.h.value': "입력한 값을 여기서는 쓸 수 없습니다. 아래 상세 내용에서 어떤 값인지 확인하고, 바꾼 뒤 다시 시도하세요.",
  'err.h.notFor': "이 종류의 세션, 에이전트 또는 항목에서는 쓸 수 없습니다. 다른 것을 고르거나 에이전트에서 직접 하세요.",
  'err.h.signIn': "그 서비스에는 로그인된 계정이 없습니다. 터미널에서 그 도구로 로그인한 뒤 다시 시도하세요.",
  'err.h.ghAnswer': "gh 도구가 Nunchiro가 쓸 수 없는 응답을 주었습니다. gh를 업데이트하고 로그인되어 있는지 확인한 뒤 다시 시도하세요.",
  'err.h.checkFirst': "먼저 확인이 필요합니다. 확인을 실행한 뒤 다시 시도하세요.",
  'err.h.agentStart': "에이전트가 시작되지 않았거나 응답하지 않았습니다. 아래 상세 내용에 이유가 있습니다. 터미널에서 에이전트 명령을 확인한 뒤 다시 확인을 실행하세요.",
  'err.h.inside': "Nunchiro 내부가 아직 준비되지 않았습니다. 잠시 기다린 뒤 다시 시도하세요. 계속되면 Nunchiro를 다시 시작하세요.",
  'err.h.io': "파일 작업이 실패했습니다. 아래 상세 내용에 이유가 있습니다. 폴더 권한과 남은 공간을 확인한 뒤 다시 시도하세요.",
  'err.h.changed': "작업하는 사이에 내용이 바뀌었습니다. 새로 고친 뒤 다시 시도하세요.",
  'err.h.widgetBad': "위젯의 폴더 또는 widget.toml에 문제가 있습니다. 아래 상세 내용에 내용이 나와 있습니다. 고친 뒤 위젯을 다시 확인하세요.",
  'err.h.machineFail': "Nunchiro가 SSH로 그 머신에 연결하지 못했습니다. 아래 상세 내용에 이유가 있습니다. 머신과 네트워크를 확인한 뒤 다시 시도하세요.",
  'err.h.actRefused': "위젯의 동작이 거부되어 아무것도 전송되지 않았습니다. 아래 상세 내용에 이유가 있습니다. 위젯이 보내는 내용을 바꾼 뒤 다시 시도하세요.",
  'err.h.ownSignin': "에이전트 자체 계정은 브라우저가 아니라 터미널에서 로그인합니다. 터미널을 쓰거나 다른 계정을 추가하세요.",
  'err.h.signOutFail': "에이전트가 여기서 로그아웃하지 못했습니다. 에이전트의 터미널에서 직접 로그아웃하세요.",
  'err.h.gitOld': "git 버전이 너무 오래되어 이 저장소를 안전하게 읽을 수 없습니다. git 2.31 이상을 설치한 뒤(예: `brew install git`) 다시 시도하세요.",
  'err.h.homeFolder': "그 에이전트는 홈 폴더 자체에서는 실행할 수 없습니다. 프로젝트 폴더를 고르세요.",
  'err.h.boardCycle': "그 연결은 카드 사이에 순환을 만듭니다. 다른 카드를 고르세요.",
  'err.h.notText': "Nunchiro가 그 파일을 텍스트로 보여 줄 수 없습니다. 대신 편집기에서 여세요.",
  'err.h.onMac': "Nunchiro가 실행 중인 Mac에서 답하세요.",
  'err.h.riskyCard': "위험한 요청이라 한 단계가 더 필요합니다. 결정 카드에서 답을 선택한 뒤 Enter를 누르세요.",
  'err.h.shellPath': "Nunchiro가 로그인 셸에서 PATH를 읽지 못했습니다. 셸 시작 파일을 확인한 뒤 다시 시도하세요.",
  'err.h.answerDecisions': "아직 보지 못한 다른 요청이 대기 중입니다. 먼저 결정 위젯에서 답한 뒤 다시 시도하세요.",
  'err.h.nothingUndo': "여기에는 아직 되돌릴 것이 없습니다. 먼저 변경하세요.",
  'err.h.noLimit': "이 세션에는 지금 초기화 시각이 있는 사용 한도가 표시되지 않아 이어서 할 것이 없습니다. 한도가 표시되면 다시 시도하세요.",
  'err.h.nothingInterrupt': "에이전트가 쉬는 중이라 중단할 것이 없습니다. 보낼 메시지를 입력하세요.",
  'err.h.cleanup': "워크트리의 정리 스크립트가 오류 없이 끝나지 않아 워크트리를 남겨 두었습니다. 이유는 정리 탭에 나옵니다. 설정 › Git과 워크트리에서 스크립트를 고친 뒤 워크트리를 다시 제거하세요.",
  'err.h.teamLeft': "팀원은 제거했지만 남은 것 중 일부를 멈추거나 끄지 못했습니다. 남은 할 일은 아래 상세 내용에 나와 있습니다.",
  'err.h.outboxOpen': "메일 앱이나 캘린더가 열리지 않아 카드가 그대로 기다리고 있습니다. 이유는 아래 상세 내용에 나와 있습니다. 그 앱을 확인한 뒤 버튼을 다시 눌러 주세요.",
};

export const ja = {
  'err.h.later': "今は処理中か、準備ができていません。少し待ってから、もう一度お試しください。",
  'err.h.fileBad': "設定ファイルまたはデータファイルに問題があります。下の詳細にファイル名と原因があります。そのファイルを直すか削除してから、もう一度お試しください。",
  'err.h.limit': "上限に達しました。不要なものを削除してから、もう一度お試しください。",
  'err.h.value': "指定した値はここでは使えません。下の詳細でどの値か確認し、変更してから、もう一度お試しください。",
  'err.h.notFor': "この種類のセッション、エージェント、項目では使えません。別のものを選ぶか、エージェント上で直接行ってください。",
  'err.h.signIn': "そのサービスにはログイン済みのアカウントがありません。ターミナルでそのツールからログインしてから、もう一度お試しください。",
  'err.h.ghAnswer': "gh ツールが Nunchiro で使えない応答を返しました。gh を更新し、ログイン済みか確認してから、もう一度お試しください。",
  'err.h.checkFirst': "先に確認が必要です。確認を実行してから、もう一度お試しください。",
  'err.h.agentStart': "エージェントが起動しないか、応答しませんでした。下の詳細に理由があります。ターミナルでエージェントのコマンドを確認してから、もう一度チェックを実行してください。",
  'err.h.inside': "Nunchiro の内部がまだ準備できていません。少し待ってから、もう一度お試しください。続く場合は Nunchiro を再起動してください。",
  'err.h.io': "ファイル操作に失敗しました。下の詳細に理由があります。フォルダーのアクセス権と空き容量を確認してから、もう一度お試しください。",
  'err.h.changed': "操作している間に内容が変わりました。更新してから、もう一度お試しください。",
  'err.h.widgetBad': "ウィジェットのフォルダーまたは widget.toml に問題があります。下の詳細に内容があります。直してから、ウィジェットをもう一度確認してください。",
  'err.h.machineFail': "Nunchiro が SSH でそのマシンに接続できませんでした。下の詳細に理由があります。マシンとネットワークを確認してから、もう一度お試しください。",
  'err.h.actRefused': "ウィジェットの操作が拒否され、何も送信されていません。下の詳細に理由があります。ウィジェットが送る内容を変えてから、もう一度お試しください。",
  'err.h.ownSignin': "このエージェントは独自のアカウントを使い、ブラウザではなくターミナルでログインします。ターミナルを使うか、別のアカウントを追加してください。",
  'err.h.signOutFail': "エージェントがここからログアウトできませんでした。エージェント自身のターミナルでログアウトしてください。",
  'err.h.gitOld': "git が古すぎるため、このリポジトリを安全に読めません。git 2.31 以降をインストールしてから（例：`brew install git`）、もう一度お試しください。",
  'err.h.homeFolder': "そのエージェントはホームフォルダー自体では実行できません。プロジェクトのフォルダーを選んでください。",
  'err.h.boardCycle': "そのリンクはカード間でループを作ります。別のカードを選んでください。",
  'err.h.notText': "Nunchiro はそのファイルをテキストとして表示できません。代わりにエディターで開いてください。",
  'err.h.onMac': "Nunchiro が動いている Mac で答えてください。",
  'err.h.riskyCard': "危険な要求のため、もう一手順必要です。判断カードで答えにフォーカスしてから Enter を押してください。",
  'err.h.shellPath': "Nunchiro がログインシェルから PATH を読み取れませんでした。シェルの起動ファイルを確認してから、もう一度お試しください。",
  'err.h.answerDecisions': "まだ見ていない別の要求が待っています。先に判断ウィジェットで答えてから、もう一度お試しください。",
  'err.h.nothingUndo': "ここにはまだ元に戻す操作がありません。先に変更を加えてください。",
  'err.h.noLimit': "このセッションには今、リセット時刻のある使用上限が表示されていないため、再開するものがありません。上限が表示されたら、もう一度お試しください。",
  'err.h.nothingInterrupt': "エージェントはアイドル状態のため、中断するものがありません。送るメッセージを入力してください。",
  'err.h.cleanup': "ワークツリーのクリーンアップスクリプトが失敗したため、ワークツリーを残しました。理由はクリーンアップタブに表示されます。設定 › Git とワークツリーでスクリプトを直してから、もう一度削除してください。",
  'err.h.teamLeft': "チームメイトは削除しましたが、残ったものの一部を止めることもオフにすることもできませんでした。残りの作業は下の詳細に表示されます。",
  'err.h.outboxOpen': "メールアプリまたはカレンダーが開かなかったため、カードはそのまま待っています。理由は下の詳細に表示されます。そのアプリを確認してから、もう一度ボタンを押してください。",
};

export const zhHans = {
  'err.h.later': "目前正忙或尚未就绪。请稍候片刻后重试。",
  'err.h.fileBad': "设置或数据文件有问题。下方详情指出了文件和问题。请修复或移除该文件，然后重试。",
  'err.h.limit': "已达到上限。请移除不需要的内容，然后重试。",
  'err.h.value': "你提供的值在此处不允许。下方详情说明是哪一个。请修改后重试。",
  'err.h.notFor': "此类会话、代理或项目不支持该操作。请换一个，或直接在代理中操作。",
  'err.h.signIn': "该服务没有已登录的账户。请在终端中用其自带的工具登录，然后重试。",
  'err.h.ghAnswer': "gh 返回了 Nunchiro 无法识别的结果。请更新 gh 并确认它已登录，然后重试。",
  'err.h.checkFirst': "需要先做检查。请运行检查，然后重试。",
  'err.h.agentStart': "代理没有启动或没有回答。下方详情说明原因。请在终端中检查它的命令，然后重新运行检查。",
  'err.h.inside': "Nunchiro 内部尚未就绪。请稍候片刻后重试。若一直如此，请重新启动 Nunchiro。",
  'err.h.io': "文件操作失败。下方详情说明原因。请检查文件夹的权限和可用空间，然后重试。",
  'err.h.changed': "你操作期间内容已变化。请刷新后重试。",
  'err.h.widgetBad': "小组件的文件夹或 widget.toml 有问题。下方详情说明具体内容。请修复后重新检查该小组件。",
  'err.h.machineFail': "Nunchiro 无法通过 SSH 连接该机器。下方详情说明原因。请检查机器和网络，然后重试。",
  'err.h.actRefused': "小组件的操作被拒绝，未发送任何内容。下方详情说明原因。请更改小组件发送的内容，然后重试。",
  'err.h.ownSignin': "代理自带的账户需在终端中登录，不能在浏览器中登录。请使用终端，或添加另一个账户。",
  'err.h.signOutFail': "代理无法在此退出登录。请在代理自己的终端中退出登录。",
  'err.h.gitOld': "git 版本太旧，无法安全读取此仓库。请安装 git 2.31 或更高版本（例如 `brew install git`），然后重试。",
  'err.h.homeFolder': "该代理不能直接在主文件夹中运行。请选择一个项目文件夹。",
  'err.h.boardCycle': "该链接会让卡片之间形成循环。请选择另一张卡片。",
  'err.h.notText': "Nunchiro 无法以文本显示该文件。请改用编辑器打开。",
  'err.h.onMac': "请在运行 Nunchiro 的 Mac 上回答。",
  'err.h.riskyCard': "该请求有风险，需要多一步。请在决策卡片中选中答案，然后按 Enter。",
  'err.h.shellPath': "Nunchiro 无法从你的登录 Shell 读取 PATH。请检查 Shell 启动文件，然后重试。",
  'err.h.answerDecisions': "还有一个你没看到的请求在等待。请先在决策小组件中回答，然后重试。",
  'err.h.nothingUndo': "这里还没有可撤销的内容。请先做一次更改。",
  'err.h.noLimit': "此会话目前没有显示带重置时间的使用上限，因此没有可继续的内容。待显示上限后再试。",
  'err.h.nothingInterrupt': "代理处于空闲状态，没有可中断的内容。请输入要发送的消息。",
  'err.h.cleanup': "工作树的清理脚本执行出错，因此保留了该工作树。原因见清理选项卡。请在“设置 › Git 与工作树”中修复脚本，然后再次移除该工作树。",
  'err.h.teamLeft': "队友已移除，但它留下的部分内容无法停止或关闭。剩下要做的事见下方详情。",
  'err.h.outboxOpen': "邮件应用或日历没有打开，因此该卡片仍在等待。原因见下方详情。请检查该应用，然后再次按下按钮。",
};

export const zhHant = {
  'err.h.later': "目前正忙或尚未就緒。請稍候片刻後再試一次。",
  'err.h.fileBad': "設定或資料檔案有問題。下方詳細資料指出了檔案和問題。請修復或刪除該檔案，然後再試一次。",
  'err.h.limit': "已達到上限。請刪除不需要的內容，然後再試一次。",
  'err.h.value': "你提供的值在此處不允許。下方詳細資料說明是哪一個。請修改後再試一次。",
  'err.h.notFor': "此類工作階段、代理或項目不支援該操作。請換一個，或直接在代理中操作。",
  'err.h.signIn': "該服務沒有已登入的帳戶。請在終端中用它自己的工具登入，然後再試一次。",
  'err.h.ghAnswer': "gh 工具回傳了 Nunchiro 無法使用的結果。請更新 gh 並確認已登入，然後再試一次。",
  'err.h.checkFirst': "需要先做檢查。請執行檢查，然後再試一次。",
  'err.h.agentStart': "代理沒有啟動或沒有回答。下方詳細資料說明原因。請在終端中檢查它的指令，然後重新執行檢查。",
  'err.h.inside': "Nunchiro 內部尚未就緒。請稍候片刻後再試一次。若一直如此，請重新啟動 Nunchiro。",
  'err.h.io': "檔案操作失敗。下方詳細資料說明原因。請檢查資料夾的權限和可用空間，然後再試一次。",
  'err.h.changed': "你操作期間內容已變化。請重新整理後再試一次。",
  'err.h.widgetBad': "小工具的資料夾或 widget.toml 有問題。下方詳細資料說明具體內容。請修復後重新檢查該小工具。",
  'err.h.machineFail': "Nunchiro 無法透過 SSH 連線該機器。下方詳細資料說明原因。請檢查機器和網路，然後再試一次。",
  'err.h.actRefused': "小工具的動作被拒絕，未傳送任何內容。下方詳細資料說明原因。請更改小工具傳送的內容，然後再試一次。",
  'err.h.ownSignin': "代理自己的帳戶需要在終端中登入，不能在瀏覽器中登入。請使用終端，或新增另一個帳戶。",
  'err.h.signOutFail': "代理無法在此登出。請在代理自己的終端中登出。",
  'err.h.gitOld': "git 版本太舊，無法安全讀取此儲存庫。請安裝 git 2.31 或更新版本（例如 `brew install git`），然後再試一次。",
  'err.h.homeFolder': "該代理不能直接在主資料夾中執行。請選擇一個專案資料夾。",
  'err.h.boardCycle': "該連結會讓卡片之間形成迴圈。請選擇另一張卡片。",
  'err.h.notText': "Nunchiro 無法以文字顯示該檔案。請改用編輯器開啟。",
  'err.h.onMac': "請在執行 Nunchiro 的 Mac 上回答。",
  'err.h.riskyCard': "該要求有風險，需要多一步。請在決策卡片中選取答案，然後按 Enter。",
  'err.h.shellPath': "Nunchiro 無法從你的登入 shell 讀取 PATH。請檢查 shell 啟動檔案，然後再試一次。",
  'err.h.answerDecisions': "還有一個你沒看到的要求在等待。請先在決策小工具中回答，然後再試一次。",
  'err.h.nothingUndo': "這裡還沒有可復原的內容。請先做一次變更。",
  'err.h.noLimit': "此工作階段目前沒有顯示帶重置時間的用量上限，因此沒有可繼續的內容。待顯示上限後再試一次。",
  'err.h.nothingInterrupt': "代理處於閒置狀態，沒有可中斷的內容。請輸入要傳送的訊息。",
  'err.h.cleanup': "工作樹的清理指令碼未能順利完成，因此保留了該工作樹。原因顯示在清理選項卡中。請在「設定 › Git 與工作樹」中修正指令碼，再重新移除。",
  'err.h.teamLeft': "隊友已移除，但它留下的部分內容無法停止或關閉。剩下要做的事見下方詳細資料。",
  'err.h.outboxOpen': "郵件 App 或行事曆沒有開啟，因此該卡片仍在等待。原因見下方詳細資料。請檢查該 App，然後再按一次按鈕。",
};

export const es = {
  'err.h.later': "Nunchiro está ocupado o aún no está listo. Espera un momento y vuelve a intentarlo.",
  'err.h.fileBad': "Un archivo de ajustes o de datos tiene un problema. Los detalles de abajo nombran el archivo y el fallo. Corrige o elimina ese archivo y vuelve a intentarlo.",
  'err.h.limit': "Se alcanzó un límite. Elimina algo que no necesites y vuelve a intentarlo.",
  'err.h.value': "Un valor que indicaste no se permite aquí. Los detalles de abajo dicen cuál. Cámbialo y vuelve a intentarlo.",
  'err.h.notFor': "Eso no está disponible para este tipo de sesión, agente o elemento. Elige otro, o hazlo en el propio agente.",
  'err.h.signIn': "Ese servicio no tiene ninguna cuenta con la sesión iniciada. Inicia sesión con su propia herramienta en un terminal y vuelve a intentarlo.",
  'err.h.ghAnswer': "La herramienta gh dio una respuesta que Nunchiro no puede usar. Actualiza gh y comprueba que tenga la sesión iniciada; luego vuelve a intentarlo.",
  'err.h.checkFirst': "Eso necesita una comprobación antes. Ejecuta la comprobación y vuelve a intentarlo.",
  'err.h.agentStart': "El agente no se inició o no respondió. Los detalles de abajo dicen por qué. Comprueba su comando en un terminal y ejecuta la comprobación de nuevo.",
  'err.h.inside': "Algo dentro de Nunchiro aún no está listo. Espera un momento y vuelve a intentarlo. Si sigue igual, reinicia Nunchiro.",
  'err.h.io': "Falló una operación con archivos. Los detalles de abajo dicen por qué. Comprueba los permisos y el espacio libre de la carpeta y vuelve a intentarlo.",
  'err.h.changed': "Eso cambió mientras trabajabas. Actualiza y vuelve a intentarlo.",
  'err.h.widgetBad': "La carpeta del widget o su widget.toml tiene un problema. Los detalles de abajo dicen cuál. Corrígelo y comprueba el widget de nuevo.",
  'err.h.machineFail': "Nunchiro no pudo conectar con esa máquina por SSH. Los detalles de abajo dicen por qué. Comprueba la máquina y tu red y vuelve a intentarlo.",
  'err.h.actRefused': "Se rechazó la acción del widget y no se envió nada. Los detalles de abajo dicen por qué. Cambia lo que envía el widget y vuelve a intentarlo.",
  'err.h.ownSignin': "La cuenta propia del agente inicia sesión en un terminal, no en el navegador. Usa un terminal o añade otra cuenta.",
  'err.h.signOutFail': "El agente no pudo cerrar sesión aquí. Cierra sesión en el terminal del propio agente.",
  'err.h.gitOld': "Tu git es demasiado antiguo para leer este repositorio con seguridad. Instala git 2.31 o posterior (por ejemplo `brew install git`) y vuelve a intentarlo.",
  'err.h.homeFolder': "Ese agente no puede ejecutarse en tu carpeta de inicio en sí. Elige una carpeta de proyecto.",
  'err.h.boardCycle': "Ese vínculo crearía un bucle entre tarjetas. Elige otra tarjeta.",
  'err.h.notText': "Nunchiro no puede mostrar ese archivo como texto. Ábrelo en un editor.",
  'err.h.onMac': "Responde esto en el Mac donde se ejecuta Nunchiro.",
  'err.h.riskyCard': "Esta solicitud es arriesgada, así que necesita un paso más. Enfoca la respuesta en la tarjeta de decisión y pulsa Enter.",
  'err.h.shellPath': "Nunchiro no pudo leer PATH de tu shell de inicio de sesión. Comprueba tus archivos de inicio del shell y vuelve a intentarlo.",
  'err.h.answerDecisions': "Hay otra solicitud esperando que no has visto. Respóndela primero en el widget de decisiones y vuelve a intentarlo.",
  'err.h.nothingUndo': "Aún no hay nada que deshacer aquí. Haz un cambio primero.",
  'err.h.noLimit': "Esta sesión no muestra ahora ningún límite de uso con hora de reinicio, así que no hay nada que reanudar. Inténtalo de nuevo cuando aparezca el límite.",
  'err.h.nothingInterrupt': "El agente está inactivo, así que no hay nada que interrumpir. Escribe tu mensaje para enviarlo.",
  'err.h.cleanup': "El script de limpieza del árbol de trabajo no terminó sin errores, así que el árbol de trabajo se conservó. Su pestaña de limpieza muestra por qué. Corrige el script en Ajustes › Git y árboles de trabajo y vuelve a eliminarlo.",
  'err.h.teamLeft': "Se quitó al compañero, pero algo que dejó no se pudo detener ni desactivar. Los detalles de abajo dicen qué falta por hacer.",
  'err.h.outboxOpen': "Tu app de correo o Calendario no se abrió, así que la tarjeta sigue esperando. Los detalles de abajo dicen por qué. Revisa esa app y vuelve a pulsar el botón.",
};

export const fr = {
  'err.h.later': "Nunchiro est occupé ou n’est pas prêt pour le moment. Patientez un instant, puis réessayez.",
  'err.h.fileBad': "Un fichier de réglages ou de données pose problème. Les détails ci-dessous nomment le fichier et le défaut. Corrigez ou supprimez ce fichier, puis réessayez.",
  'err.h.limit': "Une limite est atteinte. Supprimez ce dont vous n’avez pas besoin, puis réessayez.",
  'err.h.value': "Une valeur saisie n’est pas autorisée ici. Les détails ci-dessous disent laquelle. Modifiez-la, puis réessayez.",
  'err.h.notFor': "Ce n’est pas disponible pour ce type de session, d’agent ou d’élément. Choisissez-en un autre, ou faites-le dans l’agent lui-même.",
  'err.h.signIn': "Ce service n’a aucun compte connecté. Connectez-vous avec son propre outil dans un terminal, puis réessayez.",
  'err.h.ghAnswer': "L’outil gh a donné une réponse que Nunchiro ne peut pas utiliser. Mettez gh à jour et vérifiez qu’il est connecté, puis réessayez.",
  'err.h.checkFirst': "Une vérification est nécessaire d’abord. Lancez-la, puis réessayez.",
  'err.h.agentStart': "L’agent n’a pas démarré ou n’a pas répondu. Les détails ci-dessous disent pourquoi. Vérifiez sa commande dans un terminal, puis relancez la vérification.",
  'err.h.inside': "Quelque chose dans Nunchiro n’est pas encore prêt. Patientez un instant, puis réessayez. Si cela persiste, redémarrez Nunchiro.",
  'err.h.io': "Une opération sur un fichier a échoué. Les détails ci-dessous disent pourquoi. Vérifiez les autorisations et l’espace libre du dossier, puis réessayez.",
  'err.h.changed': "Cela a changé pendant que vous travailliez. Actualisez, puis réessayez.",
  'err.h.widgetBad': "Le dossier du widget ou son widget.toml pose problème. Les détails ci-dessous disent lequel. Corrigez-le, puis vérifiez de nouveau le widget.",
  'err.h.machineFail': "Nunchiro n’a pas pu joindre cette machine par SSH. Les détails ci-dessous disent pourquoi. Vérifiez la machine et votre réseau, puis réessayez.",
  'err.h.actRefused': "L’action du widget a été refusée et rien n’a été envoyé. Les détails ci-dessous disent pourquoi. Changez ce que le widget envoie, puis réessayez.",
  'err.h.ownSignin': "Le compte propre de l’agent se connecte dans un terminal, pas dans le navigateur. Utilisez un terminal ou ajoutez un autre compte.",
  'err.h.signOutFail': "L’agent n’a pas pu se déconnecter ici. Déconnectez-vous dans le terminal de l’agent lui-même.",
  'err.h.gitOld': "Votre git est trop ancien pour lire ce dépôt en toute sécurité. Installez git 2.31 ou plus récent (par exemple `brew install git`), puis réessayez.",
  'err.h.homeFolder': "Cet agent ne peut pas s’exécuter dans votre dossier personnel lui-même. Choisissez un dossier de projet.",
  'err.h.boardCycle': "Ce lien créerait une boucle entre des cartes. Choisissez une autre carte.",
  'err.h.notText': "Nunchiro ne peut pas afficher ce fichier comme du texte. Ouvrez-le plutôt dans un éditeur.",
  'err.h.onMac': "Répondez à ceci sur le Mac où Nunchiro s’exécute.",
  'err.h.riskyCard': "Cette demande est risquée, il faut donc une étape de plus. Placez le focus sur la réponse dans la carte de décision, puis appuyez sur Entrée.",
  'err.h.shellPath': "Nunchiro n’a pas pu lire PATH depuis votre shell de connexion. Vérifiez les fichiers de démarrage du shell, puis réessayez.",
  'err.h.answerDecisions': "Une autre demande que vous n’avez pas vue est en attente. Répondez-y d’abord dans le widget Décisions, puis réessayez.",
  'err.h.nothingUndo': "Il n’y a encore rien à annuler ici. Faites d’abord une modification.",
  'err.h.noLimit': "Cette session n’affiche pour l’instant aucune limite d’utilisation avec une heure de réinitialisation, il n’y a donc rien à reprendre. Réessayez quand la limite s’affiche.",
  'err.h.nothingInterrupt': "L’agent est inactif, il n’y a donc rien à interrompre. Saisissez votre message pour l’envoyer.",
  'err.h.cleanup': "Le script de nettoyage de l’arbre de travail ne s’est pas terminé sans erreur, l’arbre de travail a donc été conservé. Son onglet de nettoyage indique pourquoi. Corrigez le script dans Réglages › Git et arbres de travail, puis supprimez-le à nouveau.",
  'err.h.teamLeft': "Le coéquipier a été retiré, mais une partie de ce qu’il laisse n’a pas pu être arrêtée ou désactivée. Les détails ci-dessous indiquent ce qu’il reste à faire.",
  'err.h.outboxOpen': "Votre app de mail ou Calendrier ne s’est pas ouverte, la carte attend donc toujours. Les détails ci-dessous indiquent pourquoi. Vérifiez cette app, puis appuyez à nouveau sur le bouton.",
};

export const pt = {
  'err.h.later': "Isso está ocupado ou não está pronto agora. Espere um instante e tente de novo.",
  'err.h.fileBad': "Um arquivo de configurações ou de dados tem um problema. Os detalhes abaixo dizem o arquivo e a falha. Corrija ou remova esse arquivo e tente de novo.",
  'err.h.limit': "Um limite foi atingido. Remova algo de que você não precisa e tente de novo.",
  'err.h.value': "Um valor que você informou não é permitido aqui. Os detalhes abaixo dizem qual. Altere-o e tente de novo.",
  'err.h.notFor': "Isso não está disponível para este tipo de sessão, agente ou item. Escolha outro, ou faça no próprio agente.",
  'err.h.signIn': "Esse serviço não tem nenhuma conta com login feito. Faça login com a própria ferramenta dele em um terminal e tente de novo.",
  'err.h.ghAnswer': "A ferramenta gh deu uma resposta que o Nunchiro não consegue usar. Atualize o gh e confira se o login dele está feito; depois tente de novo.",
  'err.h.checkFirst': "Isso precisa de uma verificação antes. Execute a verificação e tente de novo.",
  'err.h.agentStart': "O agente não iniciou ou não respondeu. Os detalhes abaixo dizem por quê. Confira o comando dele em um terminal e execute a verificação de novo.",
  'err.h.inside': "Algo dentro do Nunchiro ainda não está pronto. Espere um instante e tente de novo. Se continuar, reinicie o Nunchiro.",
  'err.h.io': "Uma operação com arquivos falhou. Os detalhes abaixo dizem por quê. Confira as permissões e o espaço livre da pasta e tente de novo.",
  'err.h.changed': "Isso mudou enquanto você trabalhava. Atualize e tente de novo.",
  'err.h.widgetBad': "A pasta do widget ou o widget.toml tem um problema. Os detalhes abaixo dizem qual. Corrija e verifique o widget de novo.",
  'err.h.machineFail': "O Nunchiro não conseguiu alcançar essa máquina por SSH. Os detalhes abaixo dizem por quê. Confira a máquina e sua rede e tente de novo.",
  'err.h.actRefused': "A ação do widget foi recusada e nada foi enviado. Os detalhes abaixo dizem por quê. Mude o que o widget envia e tente de novo.",
  'err.h.ownSignin': "A conta do próprio agente faz login em um terminal, não no navegador. Use um terminal ou adicione outra conta.",
  'err.h.signOutFail': "O agente não conseguiu sair da conta aqui. Saia da conta no terminal do próprio agente.",
  'err.h.gitOld': "Seu git é antigo demais para ler este repositório com segurança. Instale o git 2.31 ou mais recente (por exemplo `brew install git`) e tente de novo.",
  'err.h.homeFolder': "Esse agente não pode rodar na própria pasta pessoal. Escolha uma pasta de projeto.",
  'err.h.boardCycle': "Esse vínculo criaria um ciclo entre cartões. Escolha outro cartão.",
  'err.h.notText': "O Nunchiro não consegue mostrar esse arquivo como texto. Abra-o em um editor.",
  'err.h.onMac': "Responda isto no Mac em que o Nunchiro está rodando.",
  'err.h.riskyCard': "Este pedido é arriscado, então precisa de mais um passo. Dê foco à resposta no cartão de decisão e pressione Enter.",
  'err.h.shellPath': "O Nunchiro não conseguiu ler o PATH do seu shell de login. Confira os arquivos de inicialização do shell e tente de novo.",
  'err.h.answerDecisions': "Há outra solicitação aguardando que você ainda não viu. Responda-a primeiro no widget de decisões e tente de novo.",
  'err.h.nothingUndo': "Ainda não há nada para desfazer aqui. Faça uma alteração primeiro.",
  'err.h.noLimit': "Esta sessão não mostra agora nenhum limite de uso com hora de reinício, então não há nada para retomar. Tente de novo quando o limite aparecer.",
  'err.h.nothingInterrupt': "O agente está ocioso, então não há nada para interromper. Digite sua mensagem para enviá-la.",
  'err.h.cleanup': "O script de limpeza da árvore de trabalho não terminou sem erros, então a árvore de trabalho foi mantida. A aba de limpeza mostra o motivo. Corrija o script em Configurações › Git e árvores de trabalho e remova-a novamente.",
  'err.h.teamLeft': "O colega foi removido, mas algo que ele deixou não pôde ser parado nem desativado. Os detalhes abaixo dizem o que falta fazer.",
  'err.h.outboxOpen': "Seu app de e-mail ou o Calendário não abriu, então o cartão continua esperando. Os detalhes abaixo dizem por quê. Verifique esse app e pressione o botão novamente.",
};
