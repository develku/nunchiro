/**
 * Asks the app to widen the artifact's policy while its content still has this hash. A control call,
 * not a data path: artifact bytes never travel through `invoke()`.
 */
export async function appGrant(id: string, hash: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('artifact_grant', { id, hash });
}
