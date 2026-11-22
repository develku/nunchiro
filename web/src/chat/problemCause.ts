import type { Key } from '../i18n';
import type { Problem } from '../types';

type T = (key: Key, args?: Record<string, string | number>) => string;

/** Tickets 603 and 604: the core writes each cause in English; this reads it in the window's language by the case, with the
 * agent, ACP or machine name from the session and the exit code and reset time from the problem. Anything it has no name or
 * key for keeps the core's sentence. A missing Claude or Codex also says its program is not on PATH (a failed start). */
export function causeText(t: T, p: Problem, who: { name: string | null; program: string | null; machine?: string }): string {
  const { name, program, machine: alias } = who;
  switch (p.case) {
    case 'not_installed':
      return name ? (program ? t('problem.notInstalled', { name, program }) : t('problem.cause.missing', { name })) : p.cause;
    case 'logged_out':
      return name ? t('problem.cause.signedOut', { name }) : p.cause;
    case 'usage_limit':
      return name ? (p.reset ? t('problem.cause.limitReset', { name, at: p.reset }) : t('problem.cause.limit', { name })) : p.cause;
    case 'hook_trust':
      return name ? t('problem.cause.hookTrust', { name }) : p.cause;
    case 'unexpected': {
      const code = /\(exit code (-?\d+)\)/.exec(p.cause)?.[1];
      return code ? t('problem.cause.unexpectedCode', { code }) : t('problem.cause.unexpected');
    }
    case 'machine_unreachable':
      return alias ? t('problem.cause.machineDown', { alias }) : p.cause;
    case 'version_mismatch':
      return alias ? t('problem.cause.machineVersion', { alias }) : p.cause;
    case 'acp_no_answer':
      return name ? t('problem.cause.acpNoAnswer', { name }) : p.cause;
    case 'acp_refused':
      return t('problem.cause.acpRefused');
    case 'set_aside':
      return t('problem.cause.setAside');
    default:
      return p.cause; // core_unreachable is already the window's own; folder_permission and holder_restart never reach the card
  }
}
