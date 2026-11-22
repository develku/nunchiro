// Ticket 450: Settings > Providers, adding an account starts from one "Add account" button; the name is filled in already.
declare module '../index' {
  interface AreaKeys {
    'accountAdd.open': true;
    'accountAdd.suggested': true;
    'accountAdd.browser': true;
    'accountAdd.note': true;
    'accountAdd.duplicate': true;
  }
}

export const en = {
  'accountAdd.open': 'Add account',
  'accountAdd.suggested': 'Account {n}',
  'accountAdd.browser': 'Sign in with browser',
  'accountAdd.note': 'Your browser opens to sign in. The account appears here when the sign-in is done. You can rename it later.',
  'accountAdd.duplicate': 'An account with this name already exists.',
};

export const ko = {
  'accountAdd.open': '계정 추가',
  'accountAdd.suggested': '계정 {n}',
  'accountAdd.browser': '브라우저로 로그인',
  'accountAdd.note': '브라우저가 열려 로그인합니다. 로그인이 끝나면 계정이 여기에 나타납니다. 이름은 나중에 바꿀 수 있습니다.',
  'accountAdd.duplicate': '이미 있는 계정 이름입니다.',
};

export const ja = {
  'accountAdd.open': 'アカウントを追加',
  'accountAdd.suggested': 'アカウント {n}',
  'accountAdd.browser': "ブラウザでログイン",
  'accountAdd.note': "ログイン用にブラウザが開きます。ログインが終わるとアカウントがここに表示されます。名前は後で変更できます。",
  'accountAdd.duplicate': 'この名前のアカウントは既にあります。',
};

export const zhHans = {
  'accountAdd.open': '添加账户',
  'accountAdd.suggested': '账户 {n}',
  'accountAdd.browser': '在浏览器中登录',
  'accountAdd.note': '浏览器会打开以登录。登录完成后，账户会显示在这里。名称以后可以更改。',
  'accountAdd.duplicate': '已有同名账户。',
};

export const zhHant = {
  'accountAdd.open': '新增帳戶',
  'accountAdd.suggested': '帳戶 {n}',
  'accountAdd.browser': '在瀏覽器中登入',
  'accountAdd.note': '瀏覽器會開啟以登入。登入完成後，帳戶會顯示在這裡。名稱之後可以變更。',
  'accountAdd.duplicate': '已有同名帳戶。',
};

export const es = {
  'accountAdd.open': 'Añadir cuenta',
  'accountAdd.suggested': 'Cuenta {n}',
  'accountAdd.browser': "Iniciar sesión con el navegador",
  'accountAdd.note': 'Se abre el navegador para iniciar sesión. La cuenta aparece aquí cuando termina. Puedes cambiarle el nombre después.',
  'accountAdd.duplicate': 'Ya existe una cuenta con este nombre.',
};

export const fr = {
  'accountAdd.open': 'Ajouter un compte',
  'accountAdd.suggested': 'Compte {n}',
  'accountAdd.browser': 'Se connecter dans le navigateur',
  'accountAdd.note': 'Le navigateur s’ouvre pour la connexion. Le compte apparaît ici une fois la connexion terminée. Vous pourrez le renommer plus tard.',
  'accountAdd.duplicate': 'Un compte porte déjà ce nom.',
};

export const pt = {
  'accountAdd.open': 'Adicionar conta',
  'accountAdd.suggested': 'Conta {n}',
  'accountAdd.browser': 'Entrar pelo navegador',
  'accountAdd.note': 'O navegador abre para você entrar. A conta aparece aqui quando o login termina. Você pode renomeá-la depois.',
  'accountAdd.duplicate': 'Já existe uma conta com este nome.',
};
