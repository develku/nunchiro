// Ticket 990 slice g (docs/design/leader-room/team-j.html ②): the lead's band of tasks from the core's ledger, the seats'
// faces and the room button. All eight languages.
declare module '../index' {
  interface AreaKeys {
    'lead.task.band': true;
    'lead.task.empty': true;
    'lead.task.group': true;
    'lead.task.group.needs': true;
    'lead.task.group.review': true;
    'lead.task.group.working': true;
    'lead.task.group.asked': true;
    'lead.task.group.approved': true;
    'lead.task.group.idle': true;
    'lead.task.state.changes': true;
    'lead.task.state.approved': true;
    'lead.task.state.merge': true;
    'lead.task.answer': true;
    'lead.task.asks': true;
    'lead.task.stale': true;
    'lead.task.reviewedBy': true;
    'lead.task.changesBy': true;
    'lead.task.told': true;
    'lead.task.today': true;
    'lead.task.closed.done': true;
    'lead.task.closed.dropped': true;
    'lead.task.show': true;
    'lead.task.hide': true;
    'lead.role.builder': true;
    'lead.role.reviewer': true;
    'lead.face': true;
    'lead.face.you': true;
    'lead.face.work': true;
    'lead.face.asked': true;
    'lead.face.idle': true;
    'lead.face.ended': true;
    'lead.tasks.one': true;
    'lead.tasks.other': true;
    'lead.tasks.needs': true;
    'lead.wakes.one': true;
    'lead.wakes.other': true;
    'lead.wakes.view': true;
    'lead.way.solo': true;
    'lead.way.team': true;
    'lead.way.strict': true;
    'lead.way.soloNote': true;
    'lead.way.teamNote': true;
    'lead.way.strictNote': true;
    'lead.way.menu': true;
    'lead.way.group': true;
    'lead.way.failed': true;
    'lead.seats.group': true;
    'lead.seats.ask': true;
    'lead.seats.edits': true;
    'lead.seats.note': true;
    'lead.auto.group': true;
    'lead.auto.on': true;
    'lead.auto.off': true;
    'lead.auto.note': true;
    'lead.cap.group': true;
    'lead.cap.note': true;
    'lead.seats.askShort': true;
    'lead.seats.editsShort': true;
    'lead.place.title': true;
    'lead.place.project': true;
    'lead.place.quiet': true;
    'lead.place.seatsAsk': true;
    'lead.place.seatsEdits': true;
    'lead.place.autoNote': true;
    'lead.account.group': true;
    'lead.account.note': true;
    'lead.account.own': true;
    'lead.day.solo': true;
    'lead.day.team': true;
    'lead.day.strict': true;
    'lead.day.change': true;
    'lead.task.reviewWaits': true;
    'lead.task.reviewStarted': true;
    'lead.waits.seat.one': true;
    'lead.waits.seat.other': true;
    'lead.task.stalled': true;
    'lead.task.stalledWhy': true;
    'lead.waits.review.one': true;
    'lead.waits.review.other': true;
    'lead.waits.merge': true;
    'lead.waits.stalled': true;
    'lead.note.advance': true;
    'lead.note.auto': true;
    'lead.seen.now': true;
    'lead.seen.min': true;
    'lead.day.intro': true;
    'lead.day.roles': true;
    'lead.roleCard.title': true;
    'lead.roleCard.readOnly': true;
    'lead.roleCard.add': true;
    'lead.roleCard.notNow': true;
    'lead.roleCard.quiet': true;
    'lead.roleCard.onCard': true;
    'shell.widget.team': true;
    'lead.team.toTab': true;
    'lead.team.toSide': true;
    'lead.team.open': true;
    'lead.team.parts': true;
    'lead.task.mergeAsk': true;
    'lead.task.mergeSoon': true;
    'lead.task.mergeResume': true;
  }
}

export const en = {
  'lead.tasks.one': '{n} task',
  'lead.tasks.other': '{n} tasks',
  'lead.tasks.needs': '{n} needs you',
  'lead.wakes.one': '1 worker update',
  'lead.wakes.other': '{n} worker updates',
  'lead.wakes.view': 'View in Team',
  'lead.way.solo': 'Build only',
  'lead.way.team': 'Build + review',
  'lead.way.strict': 'Strict',
  'lead.way.soloNote': 'A Builder builds each task; nothing reviews it before the merge.',
  'lead.way.teamNote': 'A Builder builds each task; a fresh Reviewer checks it before the merge.',
  'lead.way.strictNote': 'The same as build + review, with a security review of each change.',
  'lead.way.menu': 'Working mode of this project',
  'lead.way.group': 'Way of working',
  'lead.way.failed': 'That did not change. Try again.',
  'lead.seats.group': 'What seats may do',
  'lead.seats.ask': 'Ask before each edit and command',
  'lead.seats.edits': 'Edit files without asking; commands still ask',
  'lead.seats.note': 'A role has no permissions of its own. The project gives them.',
  // Ticket 1081: English only until ticket 1035's pass.
  'lead.auto.group': 'Auto-advance',
  'lead.auto.on': 'On',
  'lead.auto.off': 'Off',
  'lead.auto.note': 'The core nudges a stalled seat once, asks you when it stays stalled, and tells the lead what waits.',
  'lead.cap.group': 'Live seats',
  // Ticket 1099 (mockup docs/design/cohesion-1099): English only until ticket 1035's pass.
  'lead.cap.note': 'At most {n} seats work at once here. Extra reviews wait for a free seat.',
  'lead.seats.askShort': 'Ask first',
  'lead.seats.editsShort': 'Edit files',
  'lead.place.title': 'How this place works',
  'lead.place.project': 'Project',
  'lead.place.quiet': 'Only you change these. A lead can ask for a different seat count; its card comes to Decisions.',
  // The approved mockup's sentences (cohesion-1099 panel 1).
  'lead.place.seatsAsk': 'Seats ask you before each edit and command.',
  'lead.place.seatsEdits': 'Seats edit files without asking. Commands still ask you.',
  'lead.place.autoNote': 'A stalled seat gets one nudge; if it stays stalled, you get asked.',
  // Ticket 1120: English only until ticket 1035's pass.
  'lead.account.group': 'Seats run on',
  'lead.account.note': "The account a Builder or Reviewer seat here starts on. A lead can use it as its own.",
  'lead.account.own': "The lead's own account",
  'lead.day.solo': 'Nothing reviews a task before the merge',
  'lead.day.team': 'Reviewers check each task automatically',
  'lead.day.strict': 'Reviewers and a security review check each task',
  'lead.day.change': 'Change',
  'lead.task.reviewWaits': 'review waits',
  'lead.task.reviewStarted': 'auto review',
  'lead.waits.seat.one': '{n} review waits for a free seat',
  'lead.waits.seat.other': '{n} reviews wait for a free seat',
  'lead.task.stalled': 'stalled',
  'lead.task.stalledWhy': '{name}: {why}',
  'lead.waits.review.one': '{n} report waiting',
  'lead.waits.review.other': '{n} reports waiting',
  'lead.waits.merge': '{n} approved to merge',
  'lead.waits.stalled': '{n} stalled',
  'lead.note.advance': '{name}',
  'lead.note.auto': 'Auto-advance is now {name}',
  'lead.seen.now': 'now',
  'lead.seen.min': '{n} min ago',
  'lead.day.intro': 'Tell {name} what you want. It creates a task, assigns your roles to it and asks you before a merge.',
  'lead.day.roles': 'Your roles',
  'lead.roleCard.title': 'A new role is proposed',
  'lead.roleCard.readOnly': 'reviews, never edits',
  'lead.roleCard.add': 'Add the role',
  'lead.roleCard.notNow': 'Not now',
  'lead.roleCard.quiet': 'A role has no memory of its own. What it learns is saved as notes (Settings > Notes).',
  'lead.roleCard.onCard': 'Add it from its card in Decisions',
  'lead.task.band': 'Tasks',
  'lead.task.empty': 'No task yet. The leader makes a task when you give it work.',
  'lead.task.group': '{name} · {n}',
  'lead.task.group.needs': 'Needs you',
  'lead.task.group.review': 'In review',
  'lead.task.group.working': 'Working',
  'lead.task.group.asked': "Waiting for an answer",
  'lead.task.group.approved': 'Ready to merge',
  'lead.task.group.idle': 'Idle',
  'lead.task.state.changes': 'changes asked',
  'lead.task.state.approved': 'ready to merge',
  'lead.task.state.merge': 'merge approved',
  'lead.task.answer': 'Answer',
  'lead.task.asks': '{who} asks: {text}',
  'lead.task.stale': 'changed after the review',
  'lead.task.reviewedBy': 'reviewed by {name}',
  'lead.task.changesBy': '{name} asked for changes',
  'lead.task.told': 'You told {name}: {text}',
  'lead.task.today': '{list} today',
  'lead.task.closed.done': 'done',
  'lead.task.closed.dropped': 'dropped',
  'lead.task.show': 'Show',
  'lead.task.hide': 'Hide',
  'lead.role.builder': 'Builder',
  'lead.role.reviewer': 'Reviewer',
  'lead.face': '{label}: {state}',
  'lead.face.you': 'waiting for you',
  'lead.face.work': 'working',
  'lead.face.asked': 'waiting for an answer',
  'lead.face.idle': 'ready',
  'lead.face.ended': 'ended',
  'shell.widget.team': 'Team',
  'lead.team.toTab': 'Open as a tab',
  'lead.team.toSide': 'Back to the side',
  'lead.team.open': 'Open Team',
  'lead.team.parts': 'Team views',
  'lead.task.mergeAsk': 'asks you to merge',
  'lead.task.mergeSoon': 'You said yes. The lead merges it next.',
  'lead.task.mergeResume': 'You said yes. It merges when the lead is resumed.',
};

export const ko = {
  'lead.tasks.one': '작업 {n}개',
  'lead.tasks.other': '작업 {n}개',
  'lead.tasks.needs': '내 답 대기 {n}',
  'lead.way.solo': '빌드만',
  'lead.way.team': '빌드 + 검토',
  'lead.way.strict': '빌드 + 검토 + 보안',
  'lead.way.soloNote': '빌더가 작업마다 만들고, 병합 전에 검토하지 않습니다.',
  'lead.way.teamNote': '빌더가 작업마다 만들고, 새 검토자가 병합 전에 확인합니다.',
  'lead.way.strictNote': '빌드 + 검토에 더해 변경마다 보안 검토를 합니다.',
  'lead.way.menu': '이 프로젝트의 작업 방식',
  'lead.way.group': '작업 방식',
  'lead.way.failed': '바뀌지 않았습니다. 다시 해 보세요.',
  'lead.seats.group': '이 프로젝트의 역할',
  'lead.seats.ask': '편집과 명령마다 먼저 묻기',
  'lead.seats.edits': '파일은 묻지 않고 편집, 명령은 계속 묻기',
  'lead.seats.note': '역할에는 자기 권한이 없습니다. 권한은 프로젝트가 줍니다.',
  'lead.day.intro': '{name}에게 원하는 것을 말하세요. 작업을 만들고, 내 역할로 자리를 채우고, 병합 전에 묻습니다.',
  'lead.day.roles': '내 역할',
  'lead.roleCard.title': '새 역할이 제안되었습니다',
  'lead.roleCard.readOnly': '검토만 하고 편집하지 않음',
  'lead.roleCard.add': '역할 추가',
  'lead.roleCard.notNow': '나중에',
  'lead.roleCard.quiet': '역할에는 자기 기억이 없습니다. 배운 것은 노트로 저장됩니다(설정 > 노트).',
  'lead.roleCard.onCard': '결정 목록의 카드에서 추가하세요',
  'lead.task.band': '작업',
  'lead.task.empty': '아직 작업이 없습니다. 일을 주면 리더가 작업을 만듭니다.',
  'lead.task.group': '{name} · {n}',
  'lead.task.group.needs': '내 답 대기',
  'lead.task.group.review': '검토 중',
  'lead.task.group.working': '작업 중',
  'lead.task.group.asked': "답 대기",
  'lead.task.group.approved': '병합 준비됨',
  'lead.task.group.idle': '쉬는 중',
  'lead.task.state.changes': '수정 요청됨',
  'lead.task.state.approved': '병합 준비됨',
  'lead.task.state.merge': '병합 승인됨',
  'lead.task.answer': '답하기',
  'lead.task.asks': '{who}의 질문: {text}',
  'lead.task.stale': '검토 뒤에 바뀜',
  'lead.task.reviewedBy': '{name}이(가) 검토함',
  'lead.task.changesBy': '{name}이(가) 수정을 요청함',
  'lead.task.told': '{name}에게 직접 말함: {text}',
  'lead.task.today': '오늘 {list}',
  'lead.task.closed.done': '끝남',
  'lead.task.closed.dropped': '버림',
  'lead.task.show': '보기',
  'lead.task.hide': '접기',
  'lead.role.builder': '빌더',
  'lead.role.reviewer': '검토자',
  'lead.face': '{label}: {state}',
  'lead.face.you': '내 답 대기',
  'lead.face.work': '작업 중',
  'lead.face.asked': '답 대기',
  'lead.face.idle': '준비됨',
  'lead.face.ended': '끝남',
  'shell.widget.team': '팀',
  'lead.team.toTab': '탭으로 열기',
  'lead.team.toSide': '옆으로 되돌리기',
  'lead.team.open': '팀 열기',
  'lead.team.parts': '팀 보기',
  'lead.task.mergeAsk': '병합 여부를 묻습니다',
  'lead.task.mergeSoon': '승인함 · 리더가 다음에 병합합니다',
  'lead.task.mergeResume': '승인함 · 리더를 다시 시작하면 병합합니다',
};

export const ja = {
  'lead.tasks.one': 'タスク {n} 件',
  'lead.tasks.other': 'タスク {n} 件',
  'lead.tasks.needs': '要対応 {n}',
  'lead.way.solo': 'ビルドのみ',
  'lead.way.team': 'ビルド + レビュー',
  'lead.way.strict': 'ビルド + レビュー + セキュリティ',
  'lead.way.soloNote': 'タスクごとにビルダーが作り、マージ前のレビューはありません。',
  'lead.way.teamNote': 'タスクごとにビルダーが作り、新しいレビュアーがマージ前に確認します。',
  'lead.way.strictNote': 'ビルド + レビューに加えて、変更ごとにセキュリティレビューを行います。',
  'lead.way.menu': 'このプロジェクトの進め方',
  'lead.way.group': '進め方',
  'lead.way.failed': '変更できませんでした。もう一度お試しください。',
  'lead.seats.group': 'このプロジェクトのロール',
  'lead.seats.ask': '編集とコマンドごとに確認',
  'lead.seats.edits': 'ファイルは確認なしで編集、コマンドは確認',
  'lead.seats.note': 'ロールに権限はありません。権限はプロジェクトが与えます。',
  'lead.day.intro': '{name} にやりたいことを伝えてください。タスクを作ってあなたのロールを割り当て、マージ前に確認します。',
  'lead.day.roles': 'あなたのロール',
  'lead.roleCard.title': '新しいロールの提案',
  'lead.roleCard.readOnly': 'レビューのみ、編集しない',
  'lead.roleCard.add': 'ロールを追加',
  'lead.roleCard.notNow': '今はしない',
  'lead.roleCard.quiet': 'ロール自体に記憶はありません。学んだことはノートとして保存されます（設定 > ノート）。',
  'lead.roleCard.onCard': '「判断」のカードから追加してください',
  'lead.task.band': 'タスク',
  'lead.task.empty': 'タスクはまだありません。作業を渡すとリーダーがタスクを作ります。',
  'lead.task.group': '{name} · {n}',
  'lead.task.group.needs': '要対応',
  'lead.task.group.review': 'レビュー中',
  'lead.task.group.working': '作業中',
  'lead.task.group.asked': "回答待ち",
  'lead.task.group.approved': 'マージ可能',
  'lead.task.group.idle': 'アイドル',
  'lead.task.state.changes': '修正依頼あり',
  'lead.task.state.approved': 'マージ可能',
  'lead.task.state.merge': 'マージ承認済み',
  'lead.task.answer': '回答',
  'lead.task.asks': '{who} の質問：{text}',
  'lead.task.stale': 'レビュー後に変更あり',
  'lead.task.reviewedBy': '{name} がレビュー済み',
  'lead.task.changesBy': '{name} が修正を依頼',
  'lead.task.told': '{name} に直接伝えた内容：{text}',
  'lead.task.today': '今日 {list}',
  'lead.task.closed.done': '完了',
  'lead.task.closed.dropped': '破棄',
  'lead.task.show': '表示',
  'lead.task.hide': '隠す',
  'lead.role.builder': 'ビルダー',
  'lead.role.reviewer': 'レビュアー',
  'lead.face': '{label}：{state}',
  'lead.face.you': 'あなたの対応待ち',
  'lead.face.work': '作業中',
  'lead.face.asked': '回答待ち',
  'lead.face.idle': '準備完了',
  'lead.face.ended': '終了',
  'shell.widget.team': 'チーム',
  'lead.team.toTab': 'タブで開く',
  'lead.team.toSide': 'サイドに戻す',
  'lead.team.open': 'チームを開く',
  'lead.team.parts': 'チームの表示',
  'lead.task.mergeAsk': 'マージするか確認しています',
  'lead.task.mergeSoon': '承認済み。次にリーダーがマージします',
  'lead.task.mergeResume': '承認済み。リーダーを再開するとマージします',
};

export const zhHans = {
  'lead.tasks.one': '{n} 个任务',
  'lead.tasks.other': '{n} 个任务',
  'lead.tasks.needs': '{n} 项等你处理',
  'lead.way.solo': '仅构建',
  'lead.way.team': '构建 + 审查',
  'lead.way.strict': '构建 + 审查 + 安全',
  'lead.way.soloNote': '每个任务由构建者完成，合并前不审查。',
  'lead.way.teamNote': '每个任务由构建者完成，合并前由新的审查者检查。',
  'lead.way.strictNote': '在构建 + 审查之外，每次改动再做安全审查。',
  'lead.way.menu': '此项目的工作方式',
  'lead.way.group': '工作方式',
  'lead.way.failed': '更改未生效。请重试。',
  'lead.seats.group': '此项目的角色',
  'lead.seats.ask': '每次编辑和命令前都询问',
  'lead.seats.edits': '编辑文件不询问，命令仍会询问',
  'lead.seats.note': '角色本身没有权限，权限由项目授予。',
  'lead.day.intro': '告诉 {name} 你想要什么。它会创建任务，把你的角色分配给任务，并在合并前询问你。',
  'lead.day.roles': '你的角色',
  'lead.roleCard.title': '有新的角色提议',
  'lead.roleCard.readOnly': '只审查，从不编辑',
  'lead.roleCard.add': '添加角色',
  'lead.roleCard.notNow': '以后',
  'lead.roleCard.quiet': '角色没有自己的记忆。它学到的内容会保存为笔记（设置 > 笔记）。',
  'lead.roleCard.onCard': '请在决策小组件的卡片中添加',
  'lead.task.band': '任务',
  'lead.task.empty': '还没有任务。把工作交给负责人后，它会创建任务。',
  'lead.task.group': '{name} · {n}',
  'lead.task.group.needs': '等你处理',
  'lead.task.group.review': '审查中',
  'lead.task.group.working': '工作中',
  'lead.task.group.asked': "等待答复",
  'lead.task.group.approved': '可以合并',
  'lead.task.group.idle': '空闲',
  'lead.task.state.changes': '要求修改',
  'lead.task.state.approved': '可以合并',
  'lead.task.state.merge': '已批准合并',
  'lead.task.answer': '回答',
  'lead.task.asks': '{who} 提问：{text}',
  'lead.task.stale': '审查后有改动',
  'lead.task.reviewedBy': '已由 {name} 审查',
  'lead.task.changesBy': '{name} 要求修改',
  'lead.task.told': '你对 {name} 说：{text}',
  'lead.task.today': '今天 {list}',
  'lead.task.closed.done': '已完成',
  'lead.task.closed.dropped': '已放弃',
  'lead.task.show': '显示',
  'lead.task.hide': '隐藏',
  'lead.role.builder': '构建者',
  'lead.role.reviewer': '审查者',
  'lead.face': '{label}：{state}',
  'lead.face.you': '等你处理',
  'lead.face.work': '工作中',
  'lead.face.asked': '等待答复',
  'lead.face.idle': '就绪',
  'lead.face.ended': '已结束',
  'shell.widget.team': '团队',
  'lead.team.toTab': '在选项卡中打开',
  'lead.team.toSide': '放回侧边栏',
  'lead.team.open': '打开团队',
  'lead.team.parts': '团队视图',
  'lead.task.mergeAsk': '请你决定是否合并',
  'lead.task.mergeSoon': '已同意；负责人接下来会合并。',
  'lead.task.mergeResume': '已同意；负责人恢复后合并。',
};

export const zhHant = {
  'lead.tasks.one': '{n} 個任務',
  'lead.tasks.other': '{n} 個任務',
  'lead.tasks.needs': '{n} 項等你處理',
  'lead.way.solo': '僅建構',
  'lead.way.team': '建構 + 審查',
  'lead.way.strict': '建構 + 審查 + 安全',
  'lead.way.soloNote': '每個任務由建構者完成，合併前不審查。',
  'lead.way.teamNote': '每個任務由建構者完成，合併前由新的審查者檢查。',
  'lead.way.strictNote': '在建構 + 審查之外，每次變更再做安全審查。',
  'lead.way.menu': '此專案的工作方式',
  'lead.way.group': '工作方式',
  'lead.way.failed': '未能變更。請再試一次。',
  'lead.seats.group': '此專案的角色',
  'lead.seats.ask': '每次編輯和指令前都詢問',
  'lead.seats.edits': '編輯檔案不詢問，指令仍會詢問',
  'lead.seats.note': '角色本身沒有權限，權限由專案授予。',
  'lead.day.intro': '告訴 {name} 你想要什麼。它會建立任務，為任務指派你的角色，並在合併前詢問你。',
  'lead.day.roles': '你的角色',
  'lead.roleCard.title': '有新的角色提議',
  'lead.roleCard.readOnly': '只審查，從不編輯',
  'lead.roleCard.add': '新增角色',
  'lead.roleCard.notNow': '暫不',
  'lead.roleCard.quiet': '角色沒有自己的記憶。它學到的內容會存成筆記（設定 > 筆記）。',
  'lead.roleCard.onCard': '請在「決策」的卡片中新增',
  'lead.task.band': '任務',
  'lead.task.empty': '還沒有任務。把工作交給負責人後，它會建立任務。',
  'lead.task.group': '{name} · {n}',
  'lead.task.group.needs': '需要你處理',
  'lead.task.group.review': '審查中',
  'lead.task.group.working': '工作中',
  'lead.task.group.asked': "等待答覆",
  'lead.task.group.approved': '可以合併',
  'lead.task.group.idle': '閒置',
  'lead.task.state.changes': '要求修改',
  'lead.task.state.approved': '可以合併',
  'lead.task.state.merge': '已核准合併',
  'lead.task.answer': '回答',
  'lead.task.asks': '{who} 提問：{text}',
  'lead.task.stale': '審查後有變更',
  'lead.task.reviewedBy': '已由 {name} 審查',
  'lead.task.changesBy': '{name} 要求修改',
  'lead.task.told': '你對 {name} 說：{text}',
  'lead.task.today': '今天 {list}',
  'lead.task.closed.done': '已完成',
  'lead.task.closed.dropped': '已放棄',
  'lead.task.show': '顯示',
  'lead.task.hide': '隱藏',
  'lead.role.builder': '建構者',
  'lead.role.reviewer': '審查者',
  'lead.face': '{label}：{state}',
  'lead.face.you': '等你處理',
  'lead.face.work': '工作中',
  'lead.face.asked': '等待答覆',
  'lead.face.idle': '就緒',
  'lead.face.ended': '已結束',
  'shell.widget.team': '團隊',
  'lead.team.toTab': '在選項卡中開啟',
  'lead.team.toSide': '放回側邊欄',
  'lead.team.open': '開啟團隊',
  'lead.team.parts': '團隊檢視',
  'lead.task.mergeAsk': '請你決定是否合併',
  'lead.task.mergeSoon': '已同意；負責人接著合併',
  'lead.task.mergeResume': '已同意；負責人繼續後合併',
};

export const es = {
  'lead.tasks.one': '{n} tarea',
  'lead.tasks.other': '{n} tareas',
  'lead.tasks.needs': 'Te necesitan: {n}',
  'lead.way.solo': 'solo construir',
  'lead.way.team': 'construir + revisar',
  'lead.way.strict': 'construir + revisar + seguridad',
  'lead.way.soloNote': 'Un Constructor hace cada tarea; nadie la revisa antes de fusionar.',
  'lead.way.teamNote': 'Un Constructor hace cada tarea; un Revisor nuevo la comprueba antes de fusionar.',
  'lead.way.strictNote': 'Como construir + revisar, más una revisión de seguridad de cada cambio.',
  'lead.way.menu': 'Modo de trabajo de este proyecto',
  'lead.way.group': 'Modo de trabajo',
  'lead.way.failed': 'No cambió. Inténtalo de nuevo.',
  'lead.seats.group': 'Roles en este proyecto',
  'lead.seats.ask': 'Preguntar antes de cada edición y comando',
  'lead.seats.edits': 'Editar archivos sin preguntar; los comandos siguen preguntando',
  'lead.seats.note': 'Un rol no tiene permisos propios; los concede el proyecto.',
  'lead.day.intro': 'Dile a {name} lo que quieres. Crea una tarea, la asigna a tus roles y te pregunta antes de fusionar.',
  'lead.day.roles': 'Tus roles',
  'lead.roleCard.title': 'Se propone un rol nuevo',
  'lead.roleCard.readOnly': 'revisa, nunca edita',
  'lead.roleCard.add': 'Añadir el rol',
  'lead.roleCard.notNow': 'Ahora no',
  'lead.roleCard.quiet': 'Un rol no tiene memoria propia; lo que aprende son notas (Ajustes > Notas).',
  'lead.roleCard.onCard': 'Añádelo desde su tarjeta en Decisiones',
  'lead.task.band': 'Tareas',
  'lead.task.empty': 'Aún no hay tareas. El líder crea una tarea cuando le das trabajo.',
  'lead.task.group': '{name} · {n}',
  'lead.task.group.needs': 'Te necesita',
  'lead.task.group.review': 'En revisión',
  'lead.task.group.working': 'Trabajando',
  'lead.task.group.asked': "Espera respuesta",
  'lead.task.group.approved': 'Lista para fusionar',
  'lead.task.group.idle': 'Inactiva',
  'lead.task.state.changes': 'cambios pedidos',
  'lead.task.state.approved': 'lista para fusionar',
  'lead.task.state.merge': 'fusión aprobada',
  'lead.task.answer': 'Responder',
  'lead.task.asks': '{who} pregunta: {text}',
  'lead.task.stale': 'cambió tras la revisión',
  'lead.task.reviewedBy': 'revisada por {name}',
  'lead.task.changesBy': '{name} pidió cambios',
  'lead.task.told': 'Le dijiste a {name}: {text}',
  'lead.task.today': '{list} hoy',
  'lead.task.closed.done': 'terminadas',
  'lead.task.closed.dropped': 'descartadas',
  'lead.task.show': 'Mostrar',
  'lead.task.hide': 'Ocultar',
  'lead.role.builder': 'Constructor',
  'lead.role.reviewer': 'Revisor',
  'lead.face': '{label}: {state}',
  'lead.face.you': 'espera tu respuesta',
  'lead.face.work': 'trabajando',
  'lead.face.asked': 'espera respuesta',
  'lead.face.idle': 'listo',
  'lead.face.ended': 'terminó',
  'shell.widget.team': 'Equipo',
  'lead.team.toTab': 'Abrir como pestaña',
  'lead.team.toSide': 'Volver al lateral',
  'lead.team.open': 'Abrir Equipo',
  'lead.team.parts': 'Vistas del equipo',
  'lead.task.mergeAsk': 'te pide fusionar',
  'lead.task.mergeSoon': 'Aprobado; el líder la fusiona a continuación.',
  'lead.task.mergeResume': 'Aprobado; se fusiona cuando se reanude al líder.',
};

export const fr = {
  'lead.tasks.one': '{n} tâche',
  'lead.tasks.other': '{n} tâches',
  'lead.tasks.needs': '{n} en attente de votre réponse',
  'lead.way.solo': 'développement seul',
  'lead.way.team': 'développement + relecture',
  'lead.way.strict': 'développement + relecture + sécurité',
  'lead.way.soloNote': 'Un Développeur fait chaque tâche ; personne ne la relit avant la fusion.',
  'lead.way.teamNote': 'Un Développeur fait chaque tâche ; un nouveau Relecteur la vérifie avant la fusion.',
  'lead.way.strictNote': 'Comme développement + relecture, avec en plus une relecture de sécurité de chaque modification.',
  'lead.way.menu': 'Méthode de travail de ce projet',
  'lead.way.group': 'Méthode de travail',
  'lead.way.failed': 'Rien n’a changé. Réessayez.',
  'lead.seats.group': 'Rôles dans ce projet',
  'lead.seats.ask': 'Demander avant chaque modification et commande',
  'lead.seats.edits': 'Modifier les fichiers sans demander ; les commandes demandent toujours',
  'lead.seats.note': 'Un rôle n’a pas d’autorisations propres ; c’est le projet qui les accorde.',
  'lead.day.intro': 'Dites à {name} ce que vous voulez. Il crée une tâche, la confie à vos rôles et vous demande avant une fusion.',
  'lead.day.roles': 'Vos rôles',
  'lead.roleCard.title': 'Un nouveau rôle est proposé',
  'lead.roleCard.readOnly': 'relit, ne modifie jamais',
  'lead.roleCard.add': 'Ajouter le rôle',
  'lead.roleCard.notNow': 'Pas maintenant',
  'lead.roleCard.quiet': 'Un rôle n’a pas de mémoire propre ; ce qu’il apprend devient des notes (Réglages > Notes)',
  'lead.roleCard.onCard': 'Ajoutez-le depuis sa carte dans Décisions',
  'lead.task.band': 'Tâches',
  'lead.task.empty': 'Aucune tâche pour l’instant. Le responsable crée une tâche quand vous lui confiez du travail.',
  'lead.task.group': '{name} · {n}',
  'lead.task.group.needs': 'Attend votre réponse',
  'lead.task.group.review': 'En relecture',
  'lead.task.group.working': 'En cours',
  'lead.task.group.asked': "Attend une réponse",
  'lead.task.group.approved': 'Prête à fusionner',
  'lead.task.group.idle': 'Inactive',
  'lead.task.state.changes': 'modifications demandées',
  'lead.task.state.approved': 'prête à fusionner',
  'lead.task.state.merge': 'fusion approuvée',
  'lead.task.answer': 'Répondre',
  'lead.task.asks': '{who} demande : {text}',
  'lead.task.stale': 'modifiée après la relecture',
  'lead.task.reviewedBy': 'relue par {name}',
  'lead.task.changesBy': '{name} a demandé des modifications',
  'lead.task.told': 'Vous avez dit à {name} : {text}',
  'lead.task.today': '{list} aujourd’hui',
  'lead.task.closed.done': 'terminées',
  'lead.task.closed.dropped': 'abandonnées',
  'lead.task.show': 'Afficher',
  'lead.task.hide': 'Masquer',
  'lead.role.builder': 'Développeur',
  'lead.role.reviewer': 'Relecteur',
  'lead.face': '{label} : {state}',
  'lead.face.you': 'attend votre réponse',
  'lead.face.work': 'en cours',
  'lead.face.asked': 'attend une réponse',
  'lead.face.idle': 'prêt',
  'lead.face.ended': 'terminé',
  'shell.widget.team': 'Équipe',
  'lead.team.toTab': 'Ouvrir dans un onglet',
  'lead.team.toSide': 'Remettre sur le côté',
  'lead.team.open': 'Ouvrir Équipe',
  'lead.team.parts': 'Vues de l’équipe',
  'lead.task.mergeAsk': 'vous demande de fusionner',
  'lead.task.mergeSoon': 'Vous avez dit oui. Le responsable la fusionne ensuite.',
  'lead.task.mergeResume': 'Vous avez dit oui. La fusion se fera quand le responsable reprendra.',
};

export const pt = {
  'lead.tasks.one': '{n} tarefa',
  'lead.tasks.other': '{n} tarefas',
  'lead.tasks.needs': 'Precisam de você: {n}',
  'lead.way.solo': 'só construir',
  'lead.way.team': 'construir + revisar',
  'lead.way.strict': 'construir + revisar + segurança',
  'lead.way.soloNote': 'Um Construtor faz cada tarefa; ninguém a revisa antes de mesclar.',
  'lead.way.teamNote': 'Um Construtor faz cada tarefa; um Revisor novo a confere antes de mesclar.',
  'lead.way.strictNote': 'Como construir + revisar, mais uma revisão de segurança de cada mudança.',
  'lead.way.menu': 'Modo de trabalho deste projeto',
  'lead.way.group': 'Modo de trabalho',
  'lead.way.failed': 'Não mudou. Tente de novo.',
  'lead.seats.group': 'Papéis neste projeto',
  'lead.seats.ask': 'Perguntar antes de cada edição e comando',
  'lead.seats.edits': 'Editar arquivos sem perguntar; comandos ainda perguntam',
  'lead.seats.note': 'Um papel não tem permissões próprias; o projeto as concede.',
  'lead.day.intro': 'Diga a {name} o que você quer. Ele cria uma tarefa, a entrega aos seus papéis e pergunta antes de mesclar.',
  'lead.day.roles': 'Seus papéis',
  'lead.roleCard.title': 'Um novo papel é proposto',
  'lead.roleCard.readOnly': 'revisa, nunca edita',
  'lead.roleCard.add': 'Adicionar o papel',
  'lead.roleCard.notNow': 'Agora não',
  'lead.roleCard.quiet': 'Um papel não tem memória própria; o que aprende vira notas (Configurações > Notas)',
  'lead.roleCard.onCard': 'Adicione pelo cartão em Decisões',
  'lead.task.band': 'Tarefas',
  'lead.task.empty': 'Ainda não há tarefas. O líder cria uma tarefa quando você lhe dá trabalho.',
  'lead.task.group': '{name} · {n}',
  'lead.task.group.needs': 'Precisa de você',
  'lead.task.group.review': 'Em revisão',
  'lead.task.group.working': 'Trabalhando',
  'lead.task.group.asked': "Aguarda resposta",
  'lead.task.group.approved': 'Pronta para mesclar',
  'lead.task.group.idle': 'Inativa',
  'lead.task.state.changes': 'alterações pedidas',
  'lead.task.state.approved': 'pronta para mesclar',
  'lead.task.state.merge': 'mesclagem aprovada',
  'lead.task.answer': 'Responder',
  'lead.task.asks': '{who} pergunta: {text}',
  'lead.task.stale': 'mudou após a revisão',
  'lead.task.reviewedBy': 'revisada por {name}',
  'lead.task.changesBy': '{name} pediu alterações',
  'lead.task.told': 'Você disse a {name}: {text}',
  'lead.task.today': '{list} hoje',
  'lead.task.closed.done': 'concluídas',
  'lead.task.closed.dropped': 'descartadas',
  'lead.task.show': 'Mostrar',
  'lead.task.hide': 'Ocultar',
  'lead.role.builder': 'Construtor',
  'lead.role.reviewer': 'Revisor',
  'lead.face': '{label}: {state}',
  'lead.face.you': 'aguarda sua resposta',
  'lead.face.work': 'trabalhando',
  'lead.face.asked': 'aguarda resposta',
  'lead.face.idle': 'pronto',
  'lead.face.ended': 'terminou',
  'shell.widget.team': 'Equipe',
  'lead.team.toTab': 'Abrir como aba',
  'lead.team.toSide': 'Voltar para a lateral',
  'lead.team.open': 'Abrir Equipe',
  'lead.team.parts': 'Visões da equipe',
  'lead.task.mergeAsk': 'pergunta se deve mesclar',
  'lead.task.mergeSoon': 'Você aprovou; o líder mescla em seguida',
  'lead.task.mergeResume': 'Você aprovou; mescla quando o líder for retomado',
};
