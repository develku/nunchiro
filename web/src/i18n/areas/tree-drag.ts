// needs 171 (ticket 195): dragging a project head onto a group head, and the Undo line of "Remove from group". One file for the lane; every language has every key.
declare module '../index' {
  interface AreaKeys {
    "tree.drag.over": true;
    "tree.drag.moved": true;
    "tree.move.removed": true;
  }
}

export const en = { "tree.drag.over": "Move to {group}", "tree.drag.moved": "Moved {name} to {group}", "tree.move.removed": "Removed {name} from {group}" };
export const ko = { "tree.drag.over": "{group}(으)로 이동", "tree.drag.moved": "{name}을(를) {group}(으)로 옮겼습니다", "tree.move.removed": "{name}을(를) {group}에서 제거했습니다" };
export const ja = { "tree.drag.over": "{group} に移動", "tree.drag.moved": "{name} を {group} に移動しました", "tree.move.removed": "{name} を {group} から外しました" };
export const zhHans = { "tree.drag.over": "移动到 {group}", "tree.drag.moved": "已将 {name} 移动到 {group}", "tree.move.removed": "已将 {name} 从 {group} 移出" };
export const zhHant = { "tree.drag.over": "移動到 {group}", "tree.drag.moved": "已將 {name} 移動到 {group}", "tree.move.removed": "已將 {name} 從 {group} 移出" };
export const es = { "tree.drag.over": "Mover a {group}", "tree.drag.moved": "{name} movido a {group}", "tree.move.removed": "{name} quitado de {group}" };
export const fr = { "tree.drag.over": "Déplacer vers {group}", "tree.drag.moved": "{name} déplacé vers {group}", "tree.move.removed": "{name} retiré de {group}" };
export const pt = { "tree.drag.over": "Mover para {group}", "tree.drag.moved": "{name} movido para {group}", "tree.move.removed": "{name} removido de {group}" };
