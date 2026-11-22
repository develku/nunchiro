// "Choose folder…" in New session. The app asks the Tauri dialog plugin. Returns null when the user cancels; a failing
// plugin call throws so the caller can say so (V2.5-34). Ticket 608: so does a window with no native picker (the browser
// build): a silent null there left Choose folder… doing nothing, while the caller's note says to type the path instead.
/** `from`: the folder the panel opens in (ticket 1040: Locate starts where the moved folder was). */
export async function pickFolder(from?: string): Promise<string | null> {
  if (!("__TAURI_INTERNALS__" in window)) throw new Error("no folder picker in a browser window");
  const { invoke } = await import("@tauri-apps/api/core");
  const picked = await invoke<string | null>("plugin:dialog|open", {
    options: { directory: true, multiple: false, ...(from ? { defaultPath: from } : {}) },
  });
  return typeof picked === "string" ? picked : null;
}

// Ticket 371 item 22: the composer's "Attach a file", in the app only. Empty when the user cancels; a failing plugin call throws.
export async function pickFiles(): Promise<string[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  const picked = await invoke<string[] | string | null>("plugin:dialog|open", {
    options: { multiple: true },
  });
  return picked ? [picked].flat() : [];
}
