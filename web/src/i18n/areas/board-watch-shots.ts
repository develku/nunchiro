// V2.5-82 (ticket 303): the watch card's subagent toggle names what its number counts. One / other forms, as `board.watch.cards.*`;
// the languages without a plural form carry the same text in both. Every language has every key.
declare module '../index' {
  interface AreaKeys {
    "board.watch.subagents.one": true;
    "board.watch.subagents.other": true;
  }
}

export const en = {
  "board.watch.subagents.one": "{n} subagent",
  "board.watch.subagents.other": "{n} subagents",
};

export const ko = {
  "board.watch.subagents.one": "하위 에이전트 {n}개",
  "board.watch.subagents.other": "하위 에이전트 {n}개",
};

export const ja = {
  "board.watch.subagents.one": "サブエージェント {n} 件",
  "board.watch.subagents.other": "サブエージェント {n} 件",
};

export const zhHans = {
  "board.watch.subagents.one": "{n} 个子代理",
  "board.watch.subagents.other": "{n} 个子代理",
};

export const zhHant = {
  "board.watch.subagents.one": "{n} 個子代理",
  "board.watch.subagents.other": "{n} 個子代理",
};

export const es = {
  "board.watch.subagents.one": "{n} subagente",
  "board.watch.subagents.other": "{n} subagentes",
};

export const fr = {
  "board.watch.subagents.one": "{n} sous-agent",
  "board.watch.subagents.other": "{n} sous-agents",
};

export const pt = {
  "board.watch.subagents.one": "{n} subagente",
  "board.watch.subagents.other": "{n} subagentes",
};
