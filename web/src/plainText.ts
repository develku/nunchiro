// N19 (look 1117 v3): a field whose text goes to an agent or a shell keeps what was typed. macOS WebKit applies the system's
// substitutions (smart quotes and dashes, auto-capital, correction) unless the field opts out; these four props do that.
export const PLAIN = { autoComplete: 'off', autoCorrect: 'off', autoCapitalize: 'off', spellCheck: false } as const;
