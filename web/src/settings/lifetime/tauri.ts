// The three app commands of ticket 09. Outside the Tauri shell (tests, a plain browser) there is no app.
export const inApp = () => '__TAURI_INTERNALS__' in window;

export async function app(command: 'close_window' | 'quit_all' | 'set_start_at_login', args?: Record<string, unknown>) {
  if (!inApp()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke(command, args);
}
