// Clipboard format for copying a WHOLE policy (every setting) between policy editors -
// the Policies page modal, a resource's Access Control editor, and the staged policy list
// all read/write this same tagged JSON, so a policy copied anywhere pastes anywhere.

export interface PolicyClipboardData {
  name?: string;
  description?: string;
  enabled?: boolean;
  sources?: string[];
  destinations?: string[];
  protocol?: string;
  ports?: string[];
  bidirectional?: boolean;
  postureChecks?: string[];
}

const TAG = 'nbdPolicy';

export async function writePolicyClipboard(d: PolicyClipboardData): Promise<void> {
  await navigator.clipboard.writeText(JSON.stringify({ [TAG]: 1, ...d }, null, 2));
}

/** Returns the copied policy, or null when the clipboard holds anything else. */
export async function readPolicyClipboard(): Promise<PolicyClipboardData | null> {
  try {
    const p = JSON.parse(await navigator.clipboard.readText());
    return p && p[TAG] === 1 ? (p as PolicyClipboardData) : null;
  } catch {
    return null;
  }
}
