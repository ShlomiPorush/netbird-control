import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sun, Moon, PanelLeftClose, PanelLeftOpen, LogOut, User2, Menu, Search, ChevronsUpDown, Check, Building2, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { avatarColor } from '@/lib/str';
import { useTheme } from '@/contexts/ThemeContext';
import { useViewer } from '@/contexts/ViewerContext';
import { useAppConfig, useVersion, useMspStatus, useMspSwitcher, useMspTenants } from '@/lib/queries';
import { getTenantMode, switchAccount } from '@/lib/api';

/** Full-width top bar: brand + sidebar toggle on the left, theme + account on the right.
 * While managing a tenant the bar itself turns orange (tinted background + a solid tenant
 * chip with Exit) instead of a separate banner - no vertical space is lost. */
export function TopBar({ collapsed, onToggleCollapse, onOpenMobile }: { collapsed: boolean; onToggleCollapse: () => void; onOpenMobile: () => void }) {
  const { effective, toggle } = useTheme();
  const { viewer } = useViewer();
  const appName = useAppConfig().data?.appName || 'NetBird Control';
  const name = viewer.name || viewer.email || 'User';
  const initial = (name.trim()[0] || 'U').toUpperCase();
  const tenant = getTenantMode();
  const targets = useSwitchTargets(!!tenant);
  // The tab may hold the id of a tenant that was since removed or deactivated (the backend
  // refuses it with 403). Once both lists have loaded without it, fall back to the main account -
  // once per page: if the switch is cancelled (storage blocked), the list refreshes must not keep
  // retrying it; Exit Tenant still works by hand.
  const tenantId = tenant?.id;
  const fellBack = useRef(false);
  useEffect(() => {
    if (fellBack.current) return;
    if (tenantId && targets.ready && !targets.known.has(tenantId)) {
      fellBack.current = true;
      switchAccount(null);
    }
  }, [tenantId, targets]);

  return (
    <header className={cn(
      'sticky top-0 z-30 flex items-center h-14 px-4 border-b',
      tenant
        ? 'border-netbird/60 bg-orange-100 dark:bg-[#33190a]'
        : 'border-nb-gray-200 dark:border-nb-gray-900 bg-nb-gray-50 dark:bg-nb-gray-950',
    )}>
      <div className="flex items-center gap-2.5 min-w-0">
        {/* Mobile: open the navigation drawer */}
        <button
          onClick={onOpenMobile}
          title="Open menu"
          className="md:hidden flex items-center justify-center h-9 w-9 rounded-md text-nb-gray-600 hover:bg-nb-gray-200 dark:hover:bg-nb-gray-900 dark:text-nb-gray-300 transition-colors shrink-0"
        >
          <Menu size={20} />
        </button>
        {/* Brand → home */}
        <Link to="/" title="Home" className="flex items-center gap-2.5 min-w-0 rounded-md hover:opacity-80 transition-opacity">
          <img src="/favicon.svg" alt="" className="h-8 w-8 shrink-0" />
          <span className="min-w-0 font-semibold text-nb-gray-900 dark:text-nb-gray-50 truncate">{appName}</span>
        </Link>
        {/* Desktop: collapse/expand the sticky sidebar */}
        <button
          onClick={onToggleCollapse}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="hidden md:flex ml-1 items-center justify-center h-8 w-8 rounded-md text-nb-gray-500 hover:bg-nb-gray-200 dark:hover:bg-nb-gray-900 dark:text-nb-gray-400 transition-colors shrink-0"
        >
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
        {tenant && <TenantChip name={targets.nameOf(tenant.id)} />}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {/* Open the ⌘K command palette by click (GlobalSearch listens for app:search). */}
        <button
          onClick={() => window.dispatchEvent(new Event('app:search'))}
          title="Search (Ctrl/⌘ K)"
          className={cn(
            'flex items-center rounded-md text-nb-gray-500 transition-colors',
            'h-9 w-9 justify-center hover:bg-nb-gray-200 dark:hover:bg-nb-gray-900 dark:text-nb-gray-400',
            'sm:w-52 sm:justify-start sm:gap-2 sm:px-2.5 sm:border sm:border-nb-gray-200 sm:dark:border-nb-gray-800 sm:bg-nb-gray-100/60 sm:dark:bg-nb-gray-900/60 sm:hover:bg-nb-gray-200 sm:hover:text-nb-gray-700 sm:dark:hover:text-nb-gray-200',
          )}
        >
          <Search size={16} className="shrink-0" />
          <span className="hidden sm:inline text-sm">Search…</span>
          <span className="hidden md:inline-flex sm:ml-auto items-center h-[19px] rounded-sm border border-nb-gray-300 dark:border-nb-gray-700 px-1.5 text-[0.68rem] font-medium leading-none text-nb-gray-400 dark:text-nb-gray-500">⌘K</span>
        </button>
        <TenantSwitcher />
        <button
          onClick={toggle}
          title="Toggle theme"
          className="flex items-center justify-center h-9 w-9 rounded-md text-nb-gray-500 hover:bg-nb-gray-200 dark:hover:bg-nb-gray-900 dark:text-nb-gray-400 transition-colors"
        >
          {effective === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        {viewer.authEnabled && <AccountMenu name={name} email={viewer.email} initial={initial} userId={viewer.user_id} />}
      </div>
    </header>
  );
}

/* Solid orange "Managing Tenant" chip inside the top bar - the unmistakable signal that every
 * action targets a CUSTOMER's account. Exit clears the mode + cache and returns to main's home. */
function TenantChip({ name }: { name: string }) {
  return (
    <span className="flex items-center gap-1.5 ml-2 min-w-0 rounded-md bg-netbird text-white pl-2.5 pr-1 py-1 text-[0.8rem] font-medium">
      <Building2 size={13} className="shrink-0" />
      <span className="truncate max-w-[130px] sm:max-w-[260px]"><span className="hidden sm:inline">Managing Tenant: </span>{name}</span>
      <button type="button" onClick={() => switchAccount(null)} title="Exit Tenant"
        className="ml-0.5 flex items-center justify-center h-6 w-6 rounded-sm hover:bg-white/15 transition-colors shrink-0">
        <X size={13} />
      </button>
    </span>
  );
}

/* Every account the switcher can switch into: each non-invited tenant with its switch id
 * resolved from the switcher list (its item id is what NetBird's account switch expects,
 * falling back to the tenant id), plus any switcher-only account. Also resolves the managed
 * tenant's display name, which is not stored with the tenant id. */
function useSwitchTargets(enabled: boolean) {
  const switcher = useMspSwitcher(enabled);
  const tenants = useMspTenants(enabled);
  return useMemo(() => {
    const switcherItems = switcher.data || [];
    const tenantRows = (tenants.data || []).filter((t) => String(t.status).toLowerCase() !== 'invited');
    const rows = tenantRows.map((t) => {
      const s = switcherItems.find((x) => x.id === t.id || x.accountId === t.id || (x.domain && x.domain === t.domain));
      return { id: s ? s.id : t.id, name: t.name || t.domain, domain: t.domain };
    });
    for (const s of switcherItems) {
      if (!rows.some((r) => r.id === s.id)) rows.push({ id: s.id, name: s.name || s.domain, domain: s.domain });
    }
    // The ids the backend accepts as X-Tenant-Account - the same set its tenant middleware checks.
    const known = new Set<string>();
    for (const s of switcherItems) { known.add(s.id); if (s.accountId) known.add(s.accountId); }
    for (const t of tenantRows) known.add(t.id);
    const loading = switcher.isLoading || tenants.isLoading;
    const nameOf = (id: string) => {
      const s = switcherItems.find((x) => x.accountId === id);
      const t = tenantRows.find((x) => x.id === id);
      return rows.find((r) => r.id === id)?.name || (s && (s.name || s.domain)) || (t && (t.name || t.domain))
        || (loading ? 'Loading…' : id);
    };
    return { rows, known, nameOf, ready: switcher.isSuccess && tenants.isSuccess };
  }, [switcher.data, tenants.data, switcher.isLoading, tenants.isLoading, switcher.isSuccess, tenants.isSuccess]);
}

/* ─── Tenant switcher (official-dashboard style) ───
 * Visible only for admins of an activated MSP account: the current context (MSP account
 * with an "MSP" badge, or the tenant being managed) + a searchable dropdown of tenants.
 * Switching sets/clears tenant mode, wipes the query cache and lands on a safe page. */
function TenantSwitcher() {
  const { restricted, can } = useViewer();
  // Admins and Tenant Support holders may see/use the switcher (support holders switch INTO
  // a tenant, where the server elevates them to admin). Plain restricted users never do.
  const mspEligible = !restricted || can('tenants.support');
  const msp = useMspStatus(mspEligible).data;
  const inTenant = getTenantMode();
  // Hard-hide ALL MSP UI unless this is an activated MSP account. `msp` is undefined while
  // loading, so `=== true` keeps the switcher hidden (no flash) on plain accounts. Tenant
  // mode only ever exists on an MSP account, so it can't leak the switcher elsewhere.
  const show = mspEligible && (msp?.available === true || !!inTenant);
  // ALL linked tenants are listed (incl. pending-verification - NetBird allows managing them
  // before the domain is verified); the SWITCHER list only supplies the correct switch id.
  const targets = useSwitchTargets(show);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setSearch('');
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const q = search.toLowerCase().trim();
  const manageable = useMemo(
    () => targets.rows.filter((t) => !q || t.name.toLowerCase().includes(q) || t.domain.toLowerCase().includes(q)),
    [targets.rows, q],
  );

  if (!show) return null;

  // Hard-reload into the account's home (see switchAccount) - a soft switch was unstable.
  const switchTo = (t: { id: string } | null) => {
    setOpen(false);
    switchAccount(t);
  };

  const current = inTenant
    ? { title: targets.nameOf(inTenant.id), sub: 'Tenant', msp: false }
    : { title: msp?.name || msp?.domain || 'MSP Account', sub: msp?.domain || '', msp: true };
  const initialOf = (s: string) => (s.trim()[0] || '?').toUpperCase();

  return (
    <div className="relative" ref={ref}>
      {/* Trigger mirrors the official MSP switcher: square rounded avatar (first letter, colored on
        * a subtle dark/neutral tile) + two stacked lines (bold name over gray domain) + chevron. */}
      <button onClick={() => setOpen((o) => !o)} title="Switch account"
        className={cn('flex items-center gap-2 h-10 rounded-md border pl-1.5 pr-2 text-left transition-colors',
          'border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100/60 dark:bg-nb-gray-900/60 hover:bg-nb-gray-200 dark:hover:bg-nb-gray-900',
          open && 'ring-2 ring-netbird/40')}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-200/80 dark:bg-nb-gray-900 text-[0.85rem] font-semibold uppercase"
          style={{ color: avatarColor(current.title) }}>
          {initialOf(current.title)}
        </span>
        <span className="hidden sm:flex flex-col min-w-0 max-w-[150px] leading-tight">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[0.8rem] font-semibold text-nb-gray-800 dark:text-nb-gray-100">{current.title}</span>
            {current.msp && <span className="shrink-0 rounded-sm bg-netbird px-1 py-px text-[0.56rem] font-bold leading-tight text-white">MSP</span>}
          </span>
          {current.sub && <span className="truncate text-[0.68rem] text-nb-gray-500">{current.sub}</span>}
        </span>
        <ChevronsUpDown size={15} className="shrink-0 text-nb-gray-400" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-72 rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl">
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-nb-gray-200 dark:border-nb-gray-800">
            <Search size={14} className="shrink-0 text-nb-gray-400" />
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or domain..."
              className="w-full bg-transparent text-sm text-nb-gray-800 dark:text-nb-gray-200 placeholder:text-nb-gray-400 outline-hidden" />
          </div>
          <div className="nb-scroll max-h-[300px] overflow-y-auto p-1.5 flex flex-col gap-0.5">
            {/* The MSP (parent) account - always first, like the official switcher. */}
            <button type="button" onClick={() => switchTo(null)}
              className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-left hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900 transition-colors">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-200/80 dark:bg-nb-gray-900 text-[0.82rem] font-semibold uppercase"
                style={{ color: avatarColor(msp?.name || msp?.domain || 'MSP') }}>
                {initialOf(msp?.name || msp?.domain || 'M')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm text-nb-gray-800 dark:text-nb-gray-100">{msp?.name || msp?.domain || 'MSP Account'}</span>
                  <span className="shrink-0 rounded-sm bg-netbird px-1 py-px text-[0.56rem] font-bold leading-tight text-white">MSP</span>
                </span>
                {msp?.domain && <span className="block truncate text-[0.7rem] text-nb-gray-500">{msp.domain}</span>}
              </span>
              {!inTenant && <Check size={15} className="shrink-0 text-netbird" />}
            </button>
            {manageable.map((t) => (
              <button key={t.id} type="button" onClick={() => switchTo({ id: t.id })}
                className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-left hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900 transition-colors">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-200/80 dark:bg-nb-gray-900 text-[0.82rem] font-semibold uppercase"
                  style={{ color: avatarColor(t.name || t.domain) }}>
                  {initialOf(t.name || t.domain)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-nb-gray-800 dark:text-nb-gray-100">{t.name || t.domain}</span>
                  <span className="block truncate text-[0.7rem] text-nb-gray-500">{t.domain}</span>
                </span>
                {inTenant?.id === t.id && <Check size={15} className="shrink-0 text-netbird" />}
              </button>
            ))}
            {!manageable.length && (
              <div className="px-3 py-4 text-center text-xs text-nb-gray-500">{q ? 'No matching tenants.' : 'No active tenants yet.'}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AccountMenu({ name, email, initial, userId }: {
  name: string; email?: string; initial: string; userId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const version = useVersion().data;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const itemCls = 'flex items-center gap-2.5 w-full px-3 py-2 rounded-md text-sm text-nb-gray-700 dark:text-nb-gray-200 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900 transition-colors';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={name}
        className={cn('flex items-center justify-center h-9 w-9 rounded-full text-sm font-semibold transition-colors',
          'bg-nb-gray-200 dark:bg-nb-gray-800 text-nb-gray-700 dark:text-nb-gray-100',
          open && 'ring-2 ring-netbird/50')}
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-60 rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-1.5">
          <div className="px-3 py-2">
            <div className="text-sm font-medium text-nb-gray-900 dark:text-nb-gray-100 truncate">{name}</div>
            {email && <div className="text-[0.72rem] text-nb-gray-500 truncate">{email}</div>}
          </div>
          <div className="h-px bg-nb-gray-100 dark:bg-nb-gray-800 my-1" />
          {userId && (
            <Link to={`/users/${encodeURIComponent(userId)}`} onClick={() => setOpen(false)} className={itemCls}>
              <User2 size={15} className="text-nb-gray-400" /> Your profile
            </Link>
          )}
          <a href="/logout" className={itemCls}>
            <LogOut size={15} className="text-nb-gray-400" /> Log out
          </a>
          {version && <div className="px-3 pt-2 pb-1 text-[0.68rem] text-nb-gray-400">v{version}</div>}
        </div>
      )}
    </div>
  );
}
