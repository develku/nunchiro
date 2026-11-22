// Ticket 518: the tag that says where a setting's value comes from when it is not set in the scope in view.
declare module '../index' {
  interface AreaKeys {
    'settings.source.default': true;
    'settings.source.changedIn': true;
    'settings.source.changedInCount.one': true;
    'settings.source.changedInCount.other': true;
    'settings.source.defaultTip': true;
    'settings.source.allTip': true;
    'settings.source.projectTip': true;
  }
}

export const en = {
  'settings.source.default': 'Default',
  'settings.source.changedIn': 'Changed in {name}',
  'settings.source.changedInCount.one': 'Changed in {n} project',
  'settings.source.changedInCount.other': 'Changed in {n} projects',
  'settings.source.defaultTip': "Not set for this project or All projects: the agent's own default",
  'settings.source.allTip': 'Not set for this project: the value from All projects',
  'settings.source.projectTip': 'A project sets its own value: {where}',
};

export const ko = {
  'settings.source.default': '기본값',
  'settings.source.changedIn': '{name}에서 바꿈',
  'settings.source.changedInCount.one': '프로젝트 {n}개에서 바꿈',
  'settings.source.changedInCount.other': '프로젝트 {n}개에서 바꿈',
  'settings.source.defaultTip': '이 프로젝트와 모든 프로젝트에 설정 없음: 에이전트 자체 기본값',
  'settings.source.allTip': '이 프로젝트에 설정 없음: 모든 프로젝트의 값',
  'settings.source.projectTip': '프로젝트가 자체 값을 씀: {where}',
};

export const ja = {
  'settings.source.default': "デフォルト",
  'settings.source.changedIn': '{name} で変更',
  'settings.source.changedInCount.one': '{n} 件のプロジェクトで変更',
  'settings.source.changedInCount.other': '{n} 件のプロジェクトで変更',
  'settings.source.defaultTip': "このプロジェクトにもすべてのプロジェクトにも設定なし：エージェント自身のデフォルト",
  'settings.source.allTip': 'このプロジェクトに設定なし：すべてのプロジェクトの値',
  'settings.source.projectTip': 'プロジェクトが独自の値を設定：{where}',
};

export const zhHans = {
  'settings.source.default': '默认',
  'settings.source.changedIn': '已在 {name} 中更改',
  'settings.source.changedInCount.one': '已在 {n} 个项目中更改',
  'settings.source.changedInCount.other': '已在 {n} 个项目中更改',
  'settings.source.defaultTip': '此项目和所有项目都未设置：使用代理自身的默认值',
  'settings.source.allTip': '此项目未设置：使用所有项目的值',
  'settings.source.projectTip': '项目设置了自己的值：{where}',
};

export const zhHant = {
  'settings.source.default': '預設',
  'settings.source.changedIn': '已在 {name} 中變更',
  'settings.source.changedInCount.one': '已在 {n} 個專案中變更',
  'settings.source.changedInCount.other': '已在 {n} 個專案中變更',
  'settings.source.defaultTip': '此專案和所有專案都未設定：使用代理自身的預設值',
  'settings.source.allTip': '此專案未設定：使用所有專案的值',
  'settings.source.projectTip': '專案設定了自己的值：{where}',
};

export const es = {
  'settings.source.default': 'Predeterminado',
  'settings.source.changedIn': 'Cambiado en {name}',
  'settings.source.changedInCount.one': 'Cambiado en {n} proyecto',
  'settings.source.changedInCount.other': 'Cambiado en {n} proyectos',
  'settings.source.defaultTip': 'No se ha definido en este proyecto ni en Todos los proyectos: el valor predeterminado del agente',
  'settings.source.allTip': 'No se ha definido en este proyecto: el valor de Todos los proyectos',
  'settings.source.projectTip': 'Un proyecto define su propio valor: {where}',
};

export const fr = {
  'settings.source.default': 'Par défaut',
  'settings.source.changedIn': 'Modifié dans {name}',
  'settings.source.changedInCount.one': 'Modifié dans {n} projet',
  'settings.source.changedInCount.other': 'Modifié dans {n} projets',
  'settings.source.defaultTip': "Non défini pour ce projet ni pour Tous les projets : la valeur par défaut de l’agent",
  'settings.source.allTip': 'Non défini pour ce projet : la valeur de Tous les projets',
  'settings.source.projectTip': 'Un projet définit sa propre valeur : {where}',
};

export const pt = {
  'settings.source.default': 'Padrão',
  'settings.source.changedIn': 'Alterado em {name}',
  'settings.source.changedInCount.one': 'Alterado em {n} projeto',
  'settings.source.changedInCount.other': 'Alterado em {n} projetos',
  'settings.source.defaultTip': 'Não definido neste projeto nem em Todos os projetos: o padrão do agente',
  'settings.source.allTip': 'Não definido neste projeto: o valor de Todos os projetos',
  'settings.source.projectTip': 'Um projeto define seu próprio valor: {where}',
};
