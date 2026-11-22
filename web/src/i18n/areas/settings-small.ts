// Ticket 354: small Settings answers that used to be silent (a refused port, agents.toml not written yet).
// Ticket 991 Q6-11: the name of one paired browser's Revoke button (the row was an article with the name before).
declare module '../index' {
  interface AreaKeys {
    'settingsSmall.portRange': true;
    'settingsSmall.noAgentsFile': true;
    'settingsSmall.revokeOne': true;
  }
}

export const en = {
  'settingsSmall.portRange': "Enter a port from 1024 to 65535. The port in use stays {port}.",
  'settingsSmall.noAgentsFile': "agents.toml is not there yet: it is written when the first agent is added. The path above can be copied.",
  'settingsSmall.revokeOne': "Revoke {name}",
};

export const ko = {
  'settingsSmall.portRange': "포트는 1024에서 65535 사이로 입력하세요. 지금 쓰는 포트는 {port} 그대로입니다.",
  'settingsSmall.noAgentsFile': "agents.toml 파일이 아직 없습니다. 첫 에이전트를 추가하면 만들어집니다. 위의 경로는 복사할 수 있습니다.",
  'settingsSmall.revokeOne': "{name} 해제",
};

export const ja = {
  'settingsSmall.portRange': "ポートは 1024 から 65535 の間で入力してください。使用中のポートは {port} のままです。",
  'settingsSmall.noAgentsFile': "agents.toml はまだありません。最初のエージェントを追加すると作成されます。上のパスはコピーできます。",
  'settingsSmall.revokeOne': "{name} を解除",
};

export const zhHans = {
  'settingsSmall.portRange': "请输入 1024 到 65535 之间的端口。当前使用的端口仍为 {port}。",
  'settingsSmall.noAgentsFile': "agents.toml 尚不存在：添加第一个代理时会写入。上面的路径可以复制。",
  'settingsSmall.revokeOne': "撤销 {name} 的授权",
};

export const zhHant = {
  'settingsSmall.portRange': "請輸入 1024 到 65535 之間的連接埠。目前使用的連接埠仍為 {port}。",
  'settingsSmall.noAgentsFile': "agents.toml 尚不存在：新增第一個代理時會寫入。上方的路徑可以複製。",
  'settingsSmall.revokeOne': "撤銷 {name}",
};

export const es = {
  'settingsSmall.portRange': "Escribe un puerto entre 1024 y 65535. El puerto en uso sigue siendo {port}.",
  'settingsSmall.noAgentsFile': "agents.toml aún no existe: se escribe al añadir el primer agente. La ruta de arriba se puede copiar.",
  'settingsSmall.revokeOne': "Revocar {name}",
};

export const fr = {
  'settingsSmall.portRange': "Saisissez un port entre 1024 et 65535. Le port utilisé reste {port}.",
  'settingsSmall.noAgentsFile': "agents.toml n’existe pas encore : il est écrit à l’ajout du premier agent. Le chemin ci-dessus peut être copié.",
  'settingsSmall.revokeOne': "Révoquer {name}",
};

export const pt = {
  'settingsSmall.portRange': "Digite uma porta de 1024 a 65535. A porta em uso continua sendo {port}.",
  'settingsSmall.noAgentsFile': "O agents.toml ainda não existe: ele é gravado quando o primeiro agente é adicionado. O caminho acima pode ser copiado.",
  'settingsSmall.revokeOne': "Revogar {name}",
};
