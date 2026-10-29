// Only one floating popup (dropdown / menu panel) may be open at a time, app-wide.
//
// Each popup already closes itself on an outside MOUSEDOWN - but a popup can be opened
// without any mousedown reaching the document (keyboard activation, programmatic focus),
// which left two portal panels stacked on top of each other (e.g. a SelectMenu opening
// over a still-open GroupMultiSelect inside a modal).
//
// Every popup registers its close() when it opens; registering closes all the others.
const closers = new Set<() => void>();

/** Call when a popup opens. Returns the cleanup to call when it closes/unmounts. */
export function registerPopup(close: () => void): () => void {
  for (const c of Array.from(closers)) if (c !== close) c();
  closers.add(close);
  return () => { closers.delete(close); };
}
