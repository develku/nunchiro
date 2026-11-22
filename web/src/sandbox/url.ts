/** Where the app serves an artifact (Tauri custom scheme; Windows maps schemes to a `.localhost` host). */
export function artifactUrl(id: string): string {
  const path = encodeURIComponent(id);
  return /Windows/.test(navigator.userAgent) ? `http://nunchiro-artifact.localhost/${path}` : `nunchiro-artifact://localhost/${path}`;
}

/** V2-38: the frame load that takes a one-view "Open with" (the app's `artifact_open_with` token). */
export function withView(src: string, view: string | null): string {
  return view ? `${src}${src.includes('?') ? '&' : '?'}view=${encodeURIComponent(view)}` : src;
}
