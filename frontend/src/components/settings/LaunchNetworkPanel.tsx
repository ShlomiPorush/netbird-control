import { useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, ExternalLink, MoreHorizontal, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAppConfig, useGroups, useNetworks, usePeers } from '@/lib/queries';
import { apiText, remoteApi, type LaunchNetworkResult, type LaunchRouter } from '@/lib/remoteAccess';
import { Button, Field, GroupMultiSelect, MenuItem, Modal, PillTabs, RowMenu } from '@/components/ui';

const linkCls = 'inline-flex items-center gap-1 text-[0.82rem] font-medium text-netbird hover:underline underline-offset-4';
const muted = 'text-sm text-nb-gray-500 dark:text-nb-gray-400';

export function StepRow({ n, done, label, children, actions }: { n: number; done: boolean; label: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[150px_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-t border-nb-gray-100 dark:border-nb-gray-900 px-4 py-4 sm:px-5">
      <div className="flex items-center gap-2.5 text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">
        <span className={cn('grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full text-xs',
          done ? 'bg-green-500/10 text-green-600 dark:text-green-500' : 'border border-nb-gray-300 text-nb-gray-500 dark:border-nb-gray-700 dark:text-nb-gray-400')}>
          {done ? <Check size={12} strokeWidth={3} /> : n}
        </span>
        {label}
      </div>
      <div className="min-w-0">{children}</div>
      {actions ? <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div> : <div className="hidden sm:block" />}
    </div>
  );
}

type Notice = { routers?: LaunchNetworkResult['routers']; noRouters?: boolean };

export function LaunchNetworkRow({ networkId, readonly, managedGroupIds, inUse, done, onDone }: {
  networkId: string;
  readonly: boolean;
  managedGroupIds: Set<string>;
  inUse: number;
  done: boolean;
  onDone: (r: Pick<LaunchNetworkResult, 'config'>) => void;
}) {
  const qc = useQueryClient();
  const networksQ = useNetworks();
  const peersQ = usePeers();
  const groupsQ = useGroups();
  const appQ = useAppConfig();
  const [selPeers, setSelPeers] = useState<string[]>([]);
  const [selGroups, setSelGroups] = useState<string[]>([]);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState<'' | 'create' | 'use' | 'release'>('');
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'create' | 'existing'>('create');
  const [error, setError] = useState('');
  const [rowError, setRowError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const networks = networksQ.data || [];
  const current = networkId ? networks.find((n) => n.id === networkId) : undefined;
  const missing = !!networkId && networksQ.isSuccess && !current;
  const peerOptions = useMemo(() => (peersQ.data || []).map((p) => ({ id: p.id, name: p.name || p.ip || p.id })), [peersQ.data]);
  const groupOptions = useMemo(() => (groupsQ.data || [])
    .filter((g) => g.name !== 'All' && !managedGroupIds.has(g.id))
    .map((g) => ({ id: g.id, name: g.name })), [groupsQ.data, managedGroupIds]);
  const peerName = (id: string) => peerOptions.find((p) => p.id === id)?.name || id;
  const groupName = (id: string) => groupOptions.find((g) => g.id === id)?.name || (groupsQ.data || []).find((g) => g.id === id)?.name || id;
  const routerName = (r: LaunchRouter) => (r.peer ? peerName(r.peer) : (r.peerGroups || []).map(groupName).join(', '));
  // The name the server gives a new network: "Remote Access Resources (<application name>)".
  const appName = String(appQ.data?.appName || '').replace(/\s+/g, ' ').trim() || 'NetBird Control';

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['networks'] });
    qc.invalidateQueries({ queryKey: ['network-detail'] });
  };
  const openChooser = () => { refresh(); setOpen(true); setTab('create'); setError(''); setRowError(''); setNotice(null); };
  const closeChooser = () => { setOpen(false); setError(''); };
  const create = async () => {
    setBusy('create'); setError(''); setNotice(null);
    try {
      const r = await remoteApi.setUpNetwork({ peers: selPeers, peerGroups: selGroups });
      const rt = r.routers;
      if (rt?.failed.length) setNotice({ routers: rt });
      setSelPeers([]); setSelGroups([]); setOpen(false);
      onDone(r);
    } catch (e) {
      setError(apiText(e, "The network couldn't be created. Reload the page to see what changed, then try again."));
    } finally {
      setBusy('');
      refresh();
    }
  };
  const useExisting = async () => {
    if (!chosen) return;
    setBusy('use'); setError(''); setNotice(null);
    try {
      const r = await remoteApi.setUpNetwork({ networkId: chosen });
      if (r.enabledRouters === 0) setNotice({ noRouters: true });
      setChosen(''); setOpen(false);
      onDone(r);
    } catch (e) {
      setError(apiText(e, "The network couldn't be used. Try again."));
    } finally {
      setBusy('');
      refresh();
    }
  };
  const release = async () => {
    setBusy('release'); setRowError(''); setNotice(null);
    try {
      onDone(await remoteApi.releaseNetwork());
    } catch (e) {
      setRowError(apiText(e, "The setting couldn't be saved. Try again."));
    } finally {
      setBusy('');
      refresh();
    }
  };

  const outcome = notice && (
    <div className="mx-4 mb-4 sm:mx-5 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-200">
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" />
      {notice.noRouters ? (
        <span>This network has no active routing peers. Add one in Networks.</span>
      ) : notice.routers && (
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="font-medium">The network was created, but not every routing peer was added. Check them in Networks before adding one again.</span>
          {notice.routers.added.length > 0 && <span>Added: {notice.routers.added.map(routerName).join(', ')}</span>}
          {notice.routers.failed.map((r, i) => <span key={i} className="break-words">Not Confirmed: {routerName(r)} - {r.reason}</span>)}
        </div>
      )}
    </div>
  );

  const lockReason = readonly ? 'This instance is read-only'
    : inUse > 0 ? `${inUse} server${inUse === 1 ? ' is' : 's are'} still in use` : '';
  const menuLine = (text: string) => <span className="block text-[0.72rem] text-nb-gray-500">{text}</span>;

  const choices = networks.filter((n) => n.id !== networkId);
  const pick = choices.find((n) => n.id === chosen && !n.resources);
  const safeNote = (text: string) => (
    <span className="mr-auto flex min-w-0 items-center gap-1.5 text-[0.75rem] text-nb-gray-500 dark:text-nb-gray-400">
      <ShieldCheck size={14} className="shrink-0" /> {text}
    </span>
  );

  return (
    <div>
      <StepRow n={1} done={done} label="Network" actions={current ? (
        <>
          <Link to={`/networks/${encodeURIComponent(current.id)}`} className={linkCls}>Open In Networks <ExternalLink size={13} /></Link>
          <RowMenu width={270} title="More" icon={<MoreHorizontal size={16} />}>
            {(close) => (
              <>
                <MenuItem disabled={!!lockReason || !!busy} onClick={() => { close(); openChooser(); }}>
                  <span><span className="block">Change Network</span>{lockReason && menuLine(lockReason)}</span>
                </MenuItem>
                <MenuItem disabled={!!lockReason || !!busy} onClick={() => { close(); void release(); }}>
                  <span><span className="block">Stop Using This Network</span>{menuLine(lockReason || 'Only this setting changes. Nothing in NetBird is changed.')}</span>
                </MenuItem>
              </>
            )}
          </RowMenu>
        </>
      ) : (
        <Button variant="primary" size="sm" onClick={openChooser} disabled={readonly}>Choose Network</Button>
      )}>
        {current ? (
          <>
            <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100 break-words">{current.name || current.id}</div>
            {busy === 'release' && <div className={cn(muted, 'mt-1.5 text-[0.78rem]')}>Saving…</div>}
          </>
        ) : missing ? (
          <span className="text-sm text-amber-700 dark:text-amber-400">The network launch links used ({networkId}) no longer exists in NetBird. Choose another one.</span>
        ) : (
          <span className={muted}>Where new servers are added</span>
        )}
      </StepRow>
      {rowError && <p role="alert" className="mx-4 mb-4 sm:mx-5 text-sm text-red-500 break-words">{rowError}</p>}
      {outcome}

      <Modal
        open={open}
        onClose={closeChooser}
        closeDisabled={!!busy}
        title="Choose Network"
        subtitle="New servers from launch links go here."
        size="md"
        tabs={(
          <div className="pb-3">
            <PillTabs value={tab} onChange={(k) => { setTab(k as 'create' | 'existing'); setError(''); }}
              items={[{ key: 'create', label: 'Create New' }, { key: 'existing', label: 'Use Existing' }]} />
          </div>
        )}
        footer={tab === 'create' ? (
          <>
            {safeNote('Creates one network. Nothing else changes.')}
            <Button variant="ghost" size="sm" onClick={closeChooser} disabled={!!busy}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={create} disabled={readonly || !!busy || (!selPeers.length && !selGroups.length)}>
              {busy === 'create' ? 'Creating…' : 'Create Network'}
            </Button>
          </>
        ) : (
          <>
            {safeNote('Only the setting changes. Nothing in NetBird is changed.')}
            <Button variant="ghost" size="sm" onClick={closeChooser} disabled={!!busy}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={useExisting} disabled={readonly || !!busy || !pick}>
              {busy === 'use' ? 'Saving…' : pick ? `Use ${pick.name || pick.id}` : 'Use Network'}
            </Button>
          </>
        )}
      >
        <div className="flex flex-col gap-4">
          {tab === 'create' ? (
            <>
              <Field label="Name">
                <div className="rounded-md border border-dashed border-nb-gray-300 dark:border-nb-gray-700 px-3 py-2 text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100 break-words">
                  Remote Access Resources ({appName})
                </div>
              </Field>
              <Field label="Routing Peers">
                <GroupMultiSelect groups={peerOptions} value={selPeers} onChange={setSelPeers} placeholder="Select peers…" searchPlaceholder="Search peers..." />
              </Field>
              <Field label="Peer Groups" hint="Traffic to the servers leaves through these peers; the servers see their public address.">
                <GroupMultiSelect groups={groupOptions} value={selGroups} onChange={setSelGroups} placeholder="Select peer groups…" />
              </Field>
            </>
          ) : networksQ.isLoading ? (
            <span className={muted}>Loading networks…</span>
          ) : !choices.length ? (
            <span className={muted}>No other networks found.</span>
          ) : (
            <div role="radiogroup" aria-label="Networks" className="max-h-[50vh] overflow-y-auto rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 divide-y divide-nb-gray-100 dark:divide-nb-gray-900">
              {choices.map((n) => {
                const count = n.resources ?? 0;
                const blocked = count > 0;
                const sel = chosen === n.id && !blocked;
                const peers = typeof n.routingPeers === 'number' ? ` · ${n.routingPeers} routing peer${n.routingPeers === 1 ? '' : 's'}` : '';
                const line = blocked ? `${count} resource${count === 1 ? '' : 's'}` : `No resources${peers}`;
                return (
                  <div key={n.id} className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-2.5', sel && 'bg-netbird/10')}>
                    <label className={cn('flex min-w-0 items-center gap-3', blocked ? 'cursor-not-allowed' : 'cursor-pointer')}>
                      <input type="radio" name="launch-network" className="shrink-0 accent-netbird" checked={sel}
                        disabled={blocked || readonly || !!busy} onChange={() => { setChosen(n.id); setError(''); }} />
                      <span className="min-w-0">
                        <span className={cn('block truncate text-sm font-medium', blocked ? 'text-nb-gray-500' : 'text-nb-gray-800 dark:text-nb-gray-100')}>{n.name || n.id}</span>
                        <span className="block break-words text-[0.75rem] text-nb-gray-500">{line}</span>
                      </span>
                    </label>
                    {blocked ? <Link to={`/networks/${encodeURIComponent(n.id)}`} className={linkCls}>Clear In Networks</Link> : <span />}
                  </div>
                );
              })}
            </div>
          )}
          {error && <p role="alert" className="text-sm text-red-500 break-words">{error}</p>}
        </div>
      </Modal>
    </div>
  );
}
