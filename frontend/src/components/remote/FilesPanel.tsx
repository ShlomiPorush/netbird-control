import { useRef, useState, type RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Download, FileText, Loader2, Trash2, Upload, X } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/logfmt';
import { apiText, browserFileUrl, remoteApi, sendUploadChunk, type BrowserFile } from '@/lib/remoteAccess';
import { Button } from '@/components/ui';
import { useBarPanelPosition } from './SessionTools';

const PANEL_WIDTH = 448;
const POLL_MS = 3000;
const CHUNK = 8 * 1024 * 1024;
const SMALL_CHUNK = 1024 * 1024;
const NETWORK_RETRIES = 5;
const STOP_POLLING = new Set(['NO_SESSION', 'FILES_OFF', 'BROWSER_ENDED', 'SESSION_NOT_FOUND']);

const FILE_MESSAGES: Record<string, string> = {
  FILES_LIMIT: "There isn't room for this file in the browser's storage. Delete some files and try again.",
  NAME_TAKEN: 'A file with this name is already in the browser. Delete or rename it first.',
  FILES_OFF: 'Files are turned off for the remote browser. Ask an administrator.',
  TRANSFER_OFF: 'Transfers to and from computers are turned off. Ask an administrator.',
  BAD_NAME: "This file name can't be used in the browser. Rename the file and try again.",
  BUSY: 'This file is being copied to a computer right now. Try again when that finishes.',
  PARTIAL: 'This file is still downloading in the browser. Wait until it finishes.',
  NO_SESSION: 'This browser is no longer open.',
  BROWSER_ENDED: 'This browser is no longer open.',
};

const codeOf = (err: unknown) => (err instanceof ApiError ? err.code || '' : '');
const fileError = (err: unknown, fallback: string) => FILE_MESSAGES[codeOf(err)] || apiText(err, fallback);
const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { window.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

interface RunningUpload { name: string; size: number; sent: number; uploadId: string; ctrl: AbortController }

export function FilesPanel({ sessionId, transfer, anchor, open, onClose }: {
  sessionId: string; transfer: boolean; anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void;
}) {
  const pos = useBarPanelPosition(anchor, PANEL_WIDTH, open);
  const qc = useQueryClient();
  const queryKey = ['remote-browser-files', sessionId];
  const list = useQuery({
    queryKey, queryFn: () => remoteApi.browserFiles(sessionId), enabled: open, retry: false,
    refetchInterval: (q) => (STOP_POLLING.has(codeOf(q.state.error)) ? false : POLL_MS),
  });
  const [problem, setProblem] = useState('');
  const [deleting, setDeleting] = useState('');
  const [upload, setUpload] = useState<RunningUpload | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey }); };

  const remove = async (f: BrowserFile) => {
    setDeleting(f.name);
    setProblem('');
    try { await remoteApi.deleteBrowserFile(sessionId, f.name); } catch (err) { setProblem(fileError(err, "The file couldn't be deleted. Try again.")); }
    setDeleting('');
    refresh();
  };

  const sendFile = async (file: File) => {
    const ctrl = new AbortController();
    setProblem('');
    setUpload({ name: file.name, size: file.size, sent: 0, uploadId: '', ctrl });
    try {
      const started = await remoteApi.startUpload(sessionId, { name: file.name, size: file.size });
      setUpload((u) => u && { ...u, uploadId: started.id });
      let offset = started.received || 0;
      let chunkSize = CHUNK;
      let failures = 0;
      let done = false;
      while (!done) {
        let answer;
        try {
          answer = await sendUploadChunk(sessionId, started.id, offset, file.slice(offset, offset + chunkSize), ctrl.signal);
        } catch (err) {
          if (isAbort(err) || ++failures > NETWORK_RETRIES) throw err;
          await pause(2000 * failures, ctrl.signal);
          continue;
        }
        failures = 0;
        const reply = answer.json;
        if (answer.status === 200 && reply && typeof reply.received === 'number') {
          offset = reply.received;
          done = !!reply.done;
          setUpload((u) => u && { ...u, sent: offset });
        } else if (answer.status === 409 && reply?.code === 'OFFSET' && typeof reply.received === 'number') {
          offset = reply.received;
        } else if (answer.status === 413 && reply?.code !== 'TOO_LARGE' && chunkSize > SMALL_CHUNK) {
          chunkSize = SMALL_CHUNK;
        } else if (answer.status === 429) {
          await pause((answer.retryAfter || 5) * 1000, ctrl.signal);
        } else {
          throw new ApiError(answer.status, reply?.error || `HTTP ${answer.status}`, reply?.code);
        }
      }
    } catch (err) {
      if (!isAbort(err)) setProblem(err instanceof TypeError ? 'The upload was interrupted. Check your connection and try again.' : fileError(err, "The file couldn't be uploaded. Try again."));
    } finally {
      setUpload(null);
      refresh();
    }
  };

  const cancelUpload = () => {
    if (!upload) return;
    upload.ctrl.abort();
    if (upload.uploadId) remoteApi.cancelUpload(sessionId, upload.uploadId).catch(() => { });
  };

  const data = list.data;
  const listProblem = list.error ? fileError(list.error, "The browser's files couldn't be read. Try again in a moment.") : '';
  const usedShare = data && data.limit > 0 ? Math.min(100, (data.used / data.limit) * 100) : 0;
  const uploadShare = upload && upload.size > 0 ? Math.min(100, (upload.sent / upload.size) * 100) : 0;

  return (
    <div style={pos ? { left: pos.left, top: pos.top, width: pos.width, maxHeight: `calc(100dvh - ${pos.top + 8}px)` } : { visibility: 'hidden' }}
      className={cn('fixed z-40 flex-col overflow-y-auto rounded-2xl border border-nb-gray-800 bg-nb-gray-940 p-4 shadow-2xl', open ? 'flex' : 'hidden')}>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold">Files</span>
        <button onClick={onClose} aria-label="Close The Files" className="rounded-md p-1 text-nb-gray-400 hover:bg-nb-gray-800 hover:text-white"><X size={16} /></button>
      </div>

      {data && (
        <div className="mb-3">
          <div className="mb-1 flex items-baseline justify-between gap-2 text-[0.78rem] text-nb-gray-400">
            <span>Storage</span>
            <span className="tabular-nums">{formatBytes(data.used)} of {formatBytes(data.limit)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-nb-gray-800" role="meter" aria-label="Storage used" aria-valuemin={0} aria-valuemax={data.limit} aria-valuenow={data.used}>
            <div className={cn('h-full rounded-full', usedShare >= 90 ? 'bg-red-500' : usedShare >= 75 ? 'bg-amber-400' : 'bg-netbird')} style={{ width: `${usedShare}%` }} />
          </div>
        </div>
      )}

      {!data && !listProblem && <p className="flex items-center gap-2 py-3 text-sm text-nb-gray-400"><Loader2 size={15} className="animate-spin" /> Reading the files…</p>}

      {data && !data.files.length && (
        <p className="py-3 text-sm text-nb-gray-400">
          No files yet. {transfer ? 'Files the browser downloads, and files you upload here, show up in this list.' : 'Files the browser downloads show up in this list.'}
        </p>
      )}

      {data && data.files.length > 0 && (
        <ul className="-mx-1 flex flex-col">
          {data.files.map((f) => (
            <li key={f.name} className="flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-nb-gray-900/60">
              <FileText size={15} className="shrink-0 text-nb-gray-500" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-nb-gray-100" title={f.name}>{f.partial ? f.name.replace(/.crdownload$/, '') : f.name}</div>
                <div className="text-[0.72rem] text-nb-gray-500 tabular-nums">{f.partial ? 'Downloading…' : formatBytes(f.size)}</div>
              </div>
              {!f.partial && transfer && (
                <a href={browserFileUrl(sessionId, f.name)} download={f.name} title="Download To This Computer" aria-label={`Download ${f.name}`}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-nb-gray-300 hover:bg-nb-gray-800 hover:text-white">
                  <Download size={15} />
                </a>
              )}
              {!f.partial && (
                <button type="button" onClick={() => { void remove(f); }} disabled={!!deleting} title="Delete" aria-label={`Delete ${f.name}`}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-nb-gray-400 hover:bg-red-500/15 hover:text-red-300 disabled:opacity-40">
                  {deleting === f.name ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {upload && (
        <div className="mt-3 rounded-lg border border-nb-gray-800 bg-nb-gray-900/50 p-3">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[0.8rem]">
            <span className="min-w-0 truncate text-nb-gray-200" title={upload.name}>Uploading {upload.name}</span>
            <span className="shrink-0 tabular-nums text-nb-gray-400">{Math.floor(uploadShare)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-nb-gray-800" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(uploadShare)}>
            <div className="h-full rounded-full bg-netbird transition-[width]" style={{ width: `${uploadShare}%` }} />
          </div>
        </div>
      )}

      {(problem || listProblem) && (
        <p role="alert" className="mt-3 flex items-start gap-1.5 text-[0.8rem] text-red-300"><AlertCircle size={14} className="mt-px shrink-0" />{problem || listProblem}</p>
      )}

      {transfer && (
        <div className="mt-3">
          <input ref={picker} type="file" className="hidden" tabIndex={-1}
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void sendFile(file); }} />
          {upload
            ? <Button className="w-full rounded-lg!" onClick={cancelUpload}><X size={15} /> Cancel Upload</Button>
            : <Button variant="primary" className="w-full rounded-lg!" disabled={!data} onClick={() => picker.current?.click()}><Upload size={15} /> Upload From This Computer</Button>}
        </div>
      )}
    </div>
  );
}
