// Ticket 960 (P5 detail pass 2): an Artifacts row's source word and a pasted image's name, in the window's language
// (the row showed the model's raw "attachment" / "by agent" and a saved image's sha256 file name).
declare module '../index' {
  interface AreaKeys {
    'artifactsWidget.label.attachment': true;
    'artifactsWidget.label.byAgent': true;
    'artifactsWidget.image': true;
  }
}

export const en = { 'artifactsWidget.label.attachment': 'attachment', 'artifactsWidget.label.byAgent': 'by agent', 'artifactsWidget.image': '{type} image' };
export const ko = { 'artifactsWidget.label.attachment': '첨부', 'artifactsWidget.label.byAgent': '에이전트 작성', 'artifactsWidget.image': '{type} 이미지' };
export const ja = { 'artifactsWidget.label.attachment': '添付', 'artifactsWidget.label.byAgent': 'エージェント作成', 'artifactsWidget.image': '{type} 画像' };
export const zhHans = { 'artifactsWidget.label.attachment': '附件', 'artifactsWidget.label.byAgent': '代理创建', 'artifactsWidget.image': '{type} 图片' };
export const zhHant = { 'artifactsWidget.label.attachment': '附件', 'artifactsWidget.label.byAgent': '代理建立', 'artifactsWidget.image': '{type} 圖片' };
export const es = { 'artifactsWidget.label.attachment': 'adjunto', 'artifactsWidget.label.byAgent': 'del agente', 'artifactsWidget.image': 'imagen {type}' };
export const fr = { 'artifactsWidget.label.attachment': 'pièce jointe', 'artifactsWidget.label.byAgent': 'par l’agent', 'artifactsWidget.image': 'image {type}' };
export const pt = { 'artifactsWidget.label.attachment': 'anexo', 'artifactsWidget.label.byAgent': 'do agente', 'artifactsWidget.image': 'imagem {type}' };
