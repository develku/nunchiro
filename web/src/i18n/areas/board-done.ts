// V2.5-34 (needs 149): the Done card's PR lines on the board. State words reuse `chat.pr.*`.
declare module '../index' {
  interface AreaKeys {
    "board.done.checks.pass": true;
    "board.done.checks.fail": true;
    "board.done.checks.pending": true;
    "board.done.checks.none": true;
    "board.done.details": true;
    "board.done.hide": true;
    "board.done.detail": true;
    "board.done.branch": true;
    "board.done.files": true;
    "board.done.review.changes": true;
    "board.done.review.required": true;
  }
}

export const en = {
  "board.done.checks.pass": "All checks passing",
  "board.done.checks.fail": "Checks failing",
  "board.done.checks.pending": "Checks pending",
  "board.done.checks.none": "No checks found",
  "board.done.details": "Details",
  "board.done.hide": "Hide",
  "board.done.detail": "Pull request detail",
  "board.done.branch": "{head} → {base}",
  "board.done.files": "Files changed: {n}",
  "board.done.review.changes": "Changes requested",
  "board.done.review.required": "Review required",
};

export const ko = {
  "board.done.checks.pass": "검사 모두 통과",
  "board.done.checks.fail": "검사 실패",
  "board.done.checks.pending": "검사 진행 중",
  "board.done.checks.none": "검사 없음",
  "board.done.details": "자세히",
  "board.done.hide": "접기",
  "board.done.detail": "풀 리퀘스트 상세",
  "board.done.branch": "{head} → {base}",
  "board.done.files": "파일 {n}개 변경",
  "board.done.review.changes": "변경 요청됨",
  "board.done.review.required": "리뷰 필요",
};

// Check and review words follow `pr.ts` in each language.
export const ja = {
  "board.done.checks.pass": "チェックすべて成功",
  "board.done.checks.fail": "チェック失敗",
  "board.done.checks.pending": "チェック実行中",
  "board.done.checks.none": "チェックなし",
  "board.done.details": "詳細",
  "board.done.hide": "閉じる",
  "board.done.detail": "プルリクエストの詳細",
  "board.done.branch": "{head} → {base}",
  "board.done.files": "変更ファイル：{n}",
  "board.done.review.changes": "変更依頼あり",
  "board.done.review.required": "レビュー必須",
};

export const zhHans = {
  "board.done.checks.pass": "检查全部通过",
  "board.done.checks.fail": "检查失败",
  "board.done.checks.pending": "检查进行中",
  "board.done.checks.none": "无检查",
  "board.done.details": "详情",
  "board.done.hide": "收起",
  "board.done.detail": "拉取请求详情",
  "board.done.branch": "{head} → {base}",
  "board.done.files": "更改的文件：{n}",
  "board.done.review.changes": "需要修改",
  "board.done.review.required": "需要审查",
};

export const zhHant = {
  "board.done.checks.pass": "檢查全部通過",
  "board.done.checks.fail": "檢查失敗",
  "board.done.checks.pending": "檢查進行中",
  "board.done.checks.none": "無檢查",
  "board.done.details": "詳情",
  "board.done.hide": "收起",
  "board.done.detail": "Pull Request 詳情",
  "board.done.branch": "{head} → {base}",
  "board.done.files": "變更的檔案：{n}",
  "board.done.review.changes": "需要修改",
  "board.done.review.required": "需要審查",
};

export const es = {
  "board.done.checks.pass": "Todas las comprobaciones correctas",
  "board.done.checks.fail": "Comprobaciones fallidas",
  "board.done.checks.pending": "Comprobaciones en curso",
  "board.done.checks.none": "Sin comprobaciones",
  "board.done.details": "Detalles",
  "board.done.hide": "Ocultar",
  "board.done.detail": "Detalle del pull request",
  "board.done.branch": "{head} → {base}",
  "board.done.files": "Archivos cambiados: {n}",
  "board.done.review.changes": "Cambios solicitados",
  "board.done.review.required": "Revisión requerida",
};

export const fr = {
  "board.done.checks.pass": "Toutes les vérifications réussies",
  "board.done.checks.fail": "Vérifications en échec",
  "board.done.checks.pending": "Vérifications en cours",
  "board.done.checks.none": "Aucune vérification",
  "board.done.details": "Détails",
  "board.done.hide": "Masquer",
  "board.done.detail": "Détail de la pull request",
  "board.done.branch": "{head} → {base}",
  "board.done.files": "Fichiers modifiés : {n}",
  "board.done.review.changes": "Modifications demandées",
  "board.done.review.required": "Relecture requise",
};

export const pt = {
  "board.done.checks.pass": "Todas as verificações aprovadas",
  "board.done.checks.fail": "Verificações falharam",
  "board.done.checks.pending": "Verificações em andamento",
  "board.done.checks.none": "Sem verificações",
  "board.done.details": "Detalhes",
  "board.done.hide": "Ocultar",
  "board.done.detail": "Detalhe do pull request",
  "board.done.branch": "{head} → {base}",
  "board.done.files": "Arquivos alterados: {n}",
  "board.done.review.changes": "Alterações solicitadas",
  "board.done.review.required": "Revisão necessária",
};
