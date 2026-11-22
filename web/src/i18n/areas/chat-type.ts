// Ticket 258 (needs 197 G09): the chat and UI typography rows on Settings > Appearance.
declare module '../index' {
  interface AreaKeys {
    'chatType.title': true;
    'chatType.system': true;
    'chatType.codeDefault': true;
    'chatType.codeTerminal': true;
    'chatType.normal': true;
    'chatType.high': true;
    'chatType.reset': true;
    'chatType.mathNote': true;
    'field.uiFont': true;
    'field.chatFont': true;
    'field.chatSize': true;
    'field.chatLine': true;
    'field.codeSize': true;
    'field.codeFont': true;
    'field.composerFont': true;
    'field.composerSize': true;
    'field.chatContrast': true;
    'field.chatMath': true;
  }
}

export const en = {
  'chatType.title': 'Chat typography',
  'chatType.system': 'System',
  'chatType.codeDefault': 'Default',
  'chatType.codeTerminal': 'Terminal font',
  'chatType.normal': 'Normal',
  'chatType.high': 'High',
  'chatType.reset': 'Reset typography',
  'chatType.mathNote': 'Shows formulas written as $…$ or $$…$$ as math. KaTeX draws them. When off, dollar amounts stay plain text.',
  'field.uiFont': 'UI font',
  'field.chatFont': 'Chat font',
  'field.chatSize': 'Chat text size',
  'field.chatLine': 'Chat line height',
  'field.codeSize': 'Code text size',
  'field.codeFont': 'Code font',
  'field.composerFont': 'Composer font',
  'field.composerSize': 'Composer text size',
  'field.chatContrast': 'Chat contrast',
  'field.chatMath': 'Math in chat',
};
export const ko = {
  'chatType.title': '채팅 글꼴',
  'chatType.system': '시스템',
  'chatType.codeDefault': '기본',
  'chatType.codeTerminal': '터미널 글꼴',
  'chatType.normal': '보통',
  'chatType.high': '높음',
  'chatType.reset': '글꼴 기본값으로',
  'chatType.mathNote': '$…$ 또는 $$…$$로 쓴 수식을 수식으로 표시합니다. KaTeX가 그립니다. 끄면 달러 금액은 일반 텍스트로 남습니다.',
  'field.uiFont': 'UI 글꼴',
  'field.chatFont': '채팅 글꼴',
  'field.chatSize': '채팅 글자 크기',
  'field.chatLine': '채팅 줄 간격',
  'field.codeSize': '코드 글자 크기',
  'field.codeFont': '코드 글꼴',
  'field.composerFont': '입력창 글꼴',
  'field.composerSize': '입력창 글자 크기',
  'field.chatContrast': '채팅 대비',
  'field.chatMath': '채팅 수식',
};
export const ja = {
  'chatType.title': 'チャットの文字',
  'chatType.system': 'システム',
  'chatType.codeDefault': 'デフォルト',
  'chatType.codeTerminal': 'ターミナルのフォント',
  'chatType.normal': '標準',
  'chatType.high': '高',
  'chatType.reset': '文字設定をリセット',
  'chatType.mathNote': '$…$ や $$…$$ で書かれた数式を KaTeX で数式として表示します。オフにすると、金額の表記は通常のテキストのままです。',
  'field.uiFont': 'UI フォント',
  'field.chatFont': 'チャットのフォント',
  'field.chatSize': 'チャットの文字サイズ',
  'field.chatLine': 'チャットの行間',
  'field.codeSize': 'コードの文字サイズ',
  'field.codeFont': 'コードのフォント',
  'field.composerFont': '入力欄のフォント',
  'field.composerSize': '入力欄の文字サイズ',
  'field.chatContrast': 'チャットのコントラスト',
  'field.chatMath': 'チャットの数式',
};
export const zhHans = {
  'chatType.title': '聊天排版',
  'chatType.system': '系统',
  'chatType.codeDefault': '默认',
  'chatType.codeTerminal': '终端字体',
  'chatType.normal': '正常',
  'chatType.high': '高',
  'chatType.reset': '重置排版',
  'chatType.mathNote': '用 KaTeX 渲染 $…$ 和 $$…$$；关闭时金额保持为文本。',
  'field.uiFont': '界面字体',
  'field.chatFont': '聊天字体',
  'field.chatSize': '聊天文字大小',
  'field.chatLine': '聊天行高',
  'field.codeSize': '代码文字大小',
  'field.codeFont': '代码字体',
  'field.composerFont': '输入框字体',
  'field.composerSize': '输入框文字大小',
  'field.chatContrast': '聊天对比度',
  'field.chatMath': '聊天中的公式',
};
export const zhHant = {
  'chatType.title': '聊天字型',
  'chatType.system': '系統',
  'chatType.codeDefault': '預設',
  'chatType.codeTerminal': '終端字型',
  'chatType.normal': '正常',
  'chatType.high': '高',
  'chatType.reset': '重置字型設定',
  'chatType.mathNote': '以 KaTeX 呈現 $…$ 與 $$…$$；關閉時金額維持為文字',
  'field.uiFont': '介面字型',
  'field.chatFont': '聊天字型',
  'field.chatSize': '聊天文字大小',
  'field.chatLine': '聊天行高',
  'field.codeSize': '程式碼文字大小',
  'field.codeFont': '程式碼字型',
  'field.composerFont': '輸入框字型',
  'field.composerSize': '輸入框文字大小',
  'field.chatContrast': '聊天對比',
  'field.chatMath': '聊天中的公式',
};
export const es = {
  'chatType.title': 'Tipografía del chat',
  'chatType.system': 'Sistema',
  'chatType.codeDefault': 'Predeterminada',
  'chatType.codeTerminal': 'Fuente del terminal',
  'chatType.normal': 'Normal',
  'chatType.high': 'Alto',
  'chatType.reset': 'Restablecer tipografía',
  'chatType.mathNote': 'Muestra como fórmulas matemáticas lo escrito entre $…$ o $$…$$. Las dibuja KaTeX. Si está desactivado, los importes en dólares quedan como texto sin formato.',
  'field.uiFont': 'Fuente de la interfaz',
  'field.chatFont': 'Fuente del chat',
  'field.chatSize': 'Tamaño del texto del chat',
  'field.chatLine': 'Interlineado del chat',
  'field.codeSize': 'Tamaño del código',
  'field.codeFont': 'Fuente del código',
  'field.composerFont': 'Fuente del campo de escritura',
  'field.composerSize': 'Tamaño del texto del campo de escritura',
  'field.chatContrast': 'Contraste del chat',
  'field.chatMath': 'Fórmulas en el chat',
};
export const fr = {
  'chatType.title': 'Typographie de la conversation',
  'chatType.system': 'Système',
  'chatType.codeDefault': 'Par défaut',
  'chatType.codeTerminal': 'Police du terminal',
  'chatType.normal': 'Normal',
  'chatType.high': 'Élevé',
  'chatType.reset': 'Réinitialiser la typographie',
  'chatType.mathNote': 'Affiche $…$ et $$…$$ avec KaTeX ; désactivé, les montants restent du texte',
  'field.uiFont': "Police de l’interface",
  'field.chatFont': 'Police de la conversation',
  'field.chatSize': 'Taille du texte de la conversation',
  'field.chatLine': 'Interligne de la conversation',
  'field.codeSize': 'Taille du code',
  'field.codeFont': 'Police du code',
  'field.composerFont': 'Police de la zone de saisie',
  'field.composerSize': 'Taille du texte de la zone de saisie',
  'field.chatContrast': 'Contraste de la conversation',
  'field.chatMath': 'Formules dans la conversation',
};
export const pt = {
  'chatType.title': 'Tipografia da conversa',
  'chatType.system': 'Sistema',
  'chatType.codeDefault': 'Padrão',
  'chatType.codeTerminal': 'Fonte do terminal',
  'chatType.normal': 'Normal',
  'chatType.high': 'Alto',
  'chatType.reset': 'Redefinir tipografia',
  'chatType.mathNote': 'Mostra como fórmulas o que está escrito entre $…$ ou $$…$$, desenhadas pelo KaTeX. Quando desativado, valores em dólar ficam como texto simples.',
  'field.uiFont': 'Fonte da interface',
  'field.chatFont': 'Fonte da conversa',
  'field.chatSize': 'Tamanho do texto da conversa',
  'field.chatLine': 'Altura da linha da conversa',
  'field.codeSize': 'Tamanho do código',
  'field.codeFont': 'Fonte do código',
  'field.composerFont': "Fonte da caixa de mensagem",
  'field.composerSize': "Tamanho do texto da caixa de mensagem",
  'field.chatContrast': 'Contraste da conversa',
  'field.chatMath': 'Fórmulas na conversa',
};
