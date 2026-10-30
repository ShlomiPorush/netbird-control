import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  X, ExternalLink, Download, KeyRound, Loader2, PlusCircle, ChevronDown,
  TerminalSquare, PackageOpen, Beer, ShoppingBag, Monitor,
} from 'lucide-react';
import { FaLinux, FaWindows, FaApple, FaDocker, FaAndroid, FaAppStoreIos } from 'react-icons/fa6';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { Modal, Button, CopyButton, SelectMenu } from '@/components/ui';
import { useCreateSetupKey } from '@/lib/mutations';
import type { SetupKeyResult } from '@/lib/types';

// Two audiences, exactly like the official Install NetBird modal:
//   'user-device' - laptops/phones: log in with the email account, mobile tabs, no Docker.
//   'server'      - unattended machines: setup key instead of a login, Docker tab, no mobile.
export type AddPeerMode = 'user-device' | 'server';

type OsKey = 'linux' | 'windows' | 'macos' | 'ios' | 'android' | 'docker';

// Placeholder shown in the commands until the operator generates a real key, so the
// `--setup-key` token stays visible and the command reads as "this is where the value goes".
const KEY_PLACEHOLDER = 'SETUP_KEY';

const DOCS_SETUP_KEYS = 'https://docs.netbird.io/how-to/register-machines-using-setup-keys';
const DOCS_DOCKER = 'https://docs.netbird.io/how-to/installation/docker';
const DOCKER_INSTALL_GUIDE = 'https://docs.docker.com/engine/install/';
const LINUX_INSTALL_SH = 'curl -fsSL https://pkgs.netbird.io/install.sh | sh';
const MACOS_INSTALLER = 'https://pkgs.netbird.io/macos/universal';
const APP_STORE = 'https://apps.apple.com/app/netbird-p2p-vpn/id6469329339';
const PLAY_STORE = 'https://play.google.com/store/apps/details?id=io.netbird.client';
const WINDOWS_INSTALLERS = [
  { value: 'https://pkgs.netbird.io/windows/x64', label: '64-Bit' },
  { value: 'https://pkgs.netbird.io/windows/arm64', label: 'ARM64' },
  { value: 'https://pkgs.netbird.io/windows/msi/x64', label: '64-Bit (MSI)' },
  { value: 'https://pkgs.netbird.io/windows/msi/arm64', label: 'ARM64 (MSI)' },
];

// This deployment is NetBird Cloud, so `netbird up` needs no --management-url and the
// mobile / installer tabs have no "change server" step.
const NETBIRD_UP = 'netbird up';

// ─── Small building blocks (local: the official modal's Steps / Code / links) ───

/** One numbered step with the connecting line, like the official Steps component. */
function Step({ n, last, children }: { n: number; last?: boolean; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center shrink-0">
        <span className="flex h-6 w-6 items-center justify-center rounded-full border text-[0.7rem] font-medium border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-600 dark:text-nb-gray-300">
          {n}
        </span>
        {!last && <span className="mt-1 w-px flex-1 bg-nb-gray-200 dark:bg-nb-gray-800" />}
      </div>
      <div className={cn('min-w-0 flex-1 text-sm text-nb-gray-700 dark:text-nb-gray-300', last ? 'pb-0' : 'pb-5')}>
        {children}
      </div>
    </div>
  );
}

/** Terminal block. `copy` is ALWAYS the clean single-line/plain form - the visual line
 *  continuations and comments are a readability aid and must never reach the clipboard. */
function Code({ lines, copy }: { lines: ReactNode[]; copy: string }) {
  return (
    <div className="relative mt-2 rounded-md border px-3.5 py-2.5 pr-10 border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-930/60">
      <div className="nb-scroll overflow-x-auto font-mono text-[0.78rem] leading-6 text-nb-gray-700 dark:text-nb-gray-200">
        {lines.map((l, i) => <div key={i} className="whitespace-pre">{l}</div>)}
      </div>
      <CopyButton value={copy} className="absolute right-2.5 top-3" size={14} />
    </div>
  );
}

function DocLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-netbird hover:underline underline-offset-4 transition-all">
      {children}<ExternalLink size={12} />
    </a>
  );
}

const linkBtnBase = 'inline-flex items-center justify-center gap-2 h-[34px] px-3 rounded-md border text-xs font-medium whitespace-nowrap shadow-xs transition-colors';
const linkBtnPrimary = `${linkBtnBase} border-transparent bg-netbird text-white hover:bg-netbird-500`;
const linkBtnSecondary = `${linkBtnBase} bg-white text-nb-gray-900 border-nb-gray-200 hover:bg-nb-gray-100 dark:bg-nb-gray-920 dark:text-nb-gray-300 dark:border-nb-gray-700/40 dark:hover:text-white dark:hover:bg-nb-gray-910`;

/** Collapsible alternative-install section (the official Accordion). */
function More({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <details className="group mt-5 border-t border-nb-gray-100 dark:border-nb-gray-900 pt-4">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 text-sm font-medium text-nb-gray-700 dark:text-nb-gray-200 hover:text-netbird">
        {icon}{label}
        <ChevronDown size={14} className="ml-auto text-nb-gray-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="pt-4">{children}</div>
    </details>
  );
}

function TabTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="mb-4 flex items-center gap-3 text-base font-medium text-nb-gray-800 dark:text-nb-gray-100">
      {icon}{children}
    </p>
  );
}

/** `netbird up`, with the setup key spliced in when the server flow supplies one.
 *  `continuation` is the shell's visual line-break character - "\" everywhere, "^" on
 *  Windows Command Prompt; the copied command stays a single line regardless. */
function NetbirdUp({ setupKey, continuation = '\\' }: { setupKey?: string; continuation?: string }) {
  if (!setupKey) return <Code lines={[NETBIRD_UP]} copy={NETBIRD_UP} />;
  return (
    <Code
      copy={`${NETBIRD_UP} --setup-key ${setupKey}`}
      lines={[
        `${NETBIRD_UP} ${continuation}`,
        <>{'  --setup-key '}<span className="text-netbird">{setupKey}</span></>,
      ]}
    />
  );
}

// ─── Setup-key generator (server flow) ───
// Rendered as its own numbered step inside EVERY server tab; the key itself lives in the
// modal so all tabs show the same one. The plaintext key is shown once and never stored.
function SetupKeyStep({ generated, onGenerated }: {
  generated: SetupKeyResult | null; onGenerated: (k: SetupKeyResult) => void;
}) {
  const create = useCreateSetupKey();
  const [error, setError] = useState('');

  const generate = async () => {
    setError('');
    try { onGenerated(await create.mutateAsync({})); }
    catch (e) { setError((e as Error).message || 'Failed to create the setup key.'); }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>Generate a setup key</span>
        <DocLink href={DOCS_SETUP_KEYS}>Learn more</DocLink>
      </div>
      <p className="mt-1 text-[0.8rem] text-nb-gray-500">
        A setup key is a one-time, pre-authentication token that enrolls an unattended machine -
        the peer registers without an interactive login.
      </p>
      {!generated ? (
        <div className="mt-2.5">
          <Button variant="primary" size="sm" onClick={generate} disabled={create.isPending}>
            {create.isPending ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
            {create.isPending ? 'Generating…' : 'Generate Key'}
          </Button>
        </div>
      ) : (
        <div className="mt-2.5 flex items-center justify-between gap-3 rounded-lg border px-4 py-3 border-nb-gray-200 dark:border-nb-gray-900 bg-nb-gray-50 dark:bg-nb-gray-930/40">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm text-nb-gray-800 dark:text-nb-gray-100">
              <KeyRound size={12} /> Setup Key
            </div>
            <div className="mt-0.5 truncate font-mono text-[0.8rem] text-nb-gray-600 dark:text-nb-gray-300">{generated.key}</div>
            <div className="text-[0.72rem] text-nb-gray-500">This setup key can be used only once and expires in 24 hours.</div>
          </div>
          <CopyButton value={generated.key} className="shrink-0" size={15} title="Copy Setup Key" />
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
    </>
  );
}

// ─── Per-OS tabs ───

function LinuxTab({ setupKey, keyStep }: { setupKey?: string; keyStep?: ReactNode }) {
  const runStep = keyStep ? 3 : 2;
  return (
    <>
      <TabTitle icon={<TerminalSquare size={16} />}>Install with Command-line</TabTitle>
      <Step n={1}><Code lines={[LINUX_INSTALL_SH]} copy={LINUX_INSTALL_SH} /></Step>
      {keyStep && <Step n={2}>{keyStep}</Step>}
      <Step n={runStep} last>
        <p>Run NetBird{!setupKey && ' and log in the browser'}</p>
        <NetbirdUp setupKey={setupKey} />
      </Step>

      <More icon={<FaLinux size={16} />} label="Install manually on Ubuntu">
        <Step n={1}>
          <p>Add our repository</p>
          <Code
            copy={[
              'sudo apt-get update',
              'sudo apt install ca-certificates curl gnupg -y',
              'curl -sSL https://pkgs.netbird.io/debian/public.key | sudo gpg --dearmor --output /usr/share/keyrings/netbird-archive-keyring.gpg',
              "echo 'deb [signed-by=/usr/share/keyrings/netbird-archive-keyring.gpg] https://pkgs.netbird.io/debian stable main' | sudo tee /etc/apt/sources.list.d/netbird.list",
            ].join('\n')}
            lines={[
              'sudo apt-get update',
              'sudo apt install ca-certificates curl gnupg -y',
              'curl -sSL https://pkgs.netbird.io/debian/public.key | sudo gpg --dearmor --output /usr/share/keyrings/netbird-archive-keyring.gpg',
              "echo 'deb [signed-by=/usr/share/keyrings/netbird-archive-keyring.gpg] https://pkgs.netbird.io/debian stable main' | sudo tee /etc/apt/sources.list.d/netbird.list",
            ]}
          />
        </Step>
        <Step n={2}>
          <p>Install NetBird</p>
          <Code
            copy={['sudo apt-get update', 'sudo apt-get install netbird', 'sudo apt-get install netbird-ui'].join('\n')}
            lines={[
              'sudo apt-get update',
              <span className="text-nb-gray-400"># for CLI only</span>,
              'sudo apt-get install netbird',
              <span className="text-nb-gray-400"># for GUI package</span>,
              'sudo apt-get install netbird-ui',
            ]}
          />
        </Step>
        <Step n={3} last>
          <p>Run NetBird{!setupKey && ' and log in the browser'}</p>
          <NetbirdUp setupKey={setupKey} />
        </Step>
      </More>
    </>
  );
}

function WindowsTab({ setupKey, keyStep }: { setupKey?: string; keyStep?: ReactNode }) {
  const [url, setUrl] = useState(WINDOWS_INSTALLERS[0].value);
  const runStep = keyStep ? 3 : 2;
  return (
    <>
      <TabTitle icon={<PackageOpen size={16} />}>Install on Windows</TabTitle>
      <Step n={1}>
        <p>Download and run Windows Installer</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <div className="w-[170px]"><SelectMenu options={WINDOWS_INSTALLERS} value={url} onChange={setUrl} placeholder="Select architecture" /></div>
          <a href={url} target="_blank" rel="noopener noreferrer" className={linkBtnPrimary}>
            <Download size={14} /> Download NetBird
          </a>
        </div>
      </Step>
      {keyStep && <Step n={2}>{keyStep}</Step>}
      {setupKey ? (
        <Step n={runStep} last>
          <p>Open Command-line and run NetBird</p>
          <NetbirdUp setupKey={setupKey} continuation="^" />
        </Step>
      ) : (
        <>
          <Step n={runStep}><p>Click on &quot;Connect&quot; from the NetBird icon in your system tray</p></Step>
          <Step n={runStep + 1} last><p>Sign up using your email address</p></Step>
        </>
      )}
    </>
  );
}

function MacOsTab({ setupKey, keyStep }: { setupKey?: string; keyStep?: ReactNode }) {
  const runStep = keyStep ? 3 : 2;
  return (
    <>
      <TabTitle icon={<PackageOpen size={16} />}>Install on macOS</TabTitle>
      <Step n={1}>
        <p>Download and run macOS Installer</p>
        <div className="mt-2">
          <a href={MACOS_INSTALLER} target="_blank" rel="noopener noreferrer" className={linkBtnPrimary}>
            <Download size={14} /> Download NetBird
          </a>
        </div>
      </Step>
      {keyStep && <Step n={2}>{keyStep}</Step>}
      {setupKey ? (
        <Step n={runStep} last>
          <p>Open Terminal and run NetBird</p>
          <NetbirdUp setupKey={setupKey} />
        </Step>
      ) : (
        <>
          <Step n={runStep}><p>Click on &quot;Connect&quot; from the NetBird icon in your system tray</p></Step>
          <Step n={runStep + 1} last><p>Sign up using your email address</p></Step>
        </>
      )}

      <More icon={<TerminalSquare size={16} />} label="Install manually with Terminal">
        <Step n={1}><Code lines={[LINUX_INSTALL_SH]} copy={LINUX_INSTALL_SH} /></Step>
        <Step n={2} last>
          <p>Run NetBird{!setupKey && ' and log in the browser'}</p>
          <NetbirdUp setupKey={setupKey} />
        </Step>
      </More>

      <More icon={<Beer size={16} />} label="Install manually with HomeBrew">
        <Step n={1}>
          <p>Download and install HomeBrew</p>
          <div className="mt-2">
            <a href="https://brew.sh/" target="_blank" rel="noopener noreferrer" className={linkBtnSecondary}>
              <ExternalLink size={14} /> HomeBrew Installation Guide
            </a>
          </div>
        </Step>
        <Step n={2}>
          <p>Install NetBird</p>
          <Code
            copy={['brew install netbirdio/tap/netbird', 'brew install --cask netbirdio/tap/netbird-ui'].join('\n')}
            lines={[
              <span className="text-nb-gray-400"># for CLI only</span>,
              'brew install netbirdio/tap/netbird',
              <span className="text-nb-gray-400"># for GUI package</span>,
              'brew install --cask netbirdio/tap/netbird-ui',
            ]}
          />
        </Step>
        <Step n={3}>
          <p>Start NetBird daemon</p>
          <Code
            copy={['sudo netbird service install', 'sudo netbird service start'].join('\n')}
            lines={['sudo netbird service install', 'sudo netbird service start']}
          />
        </Step>
        <Step n={4} last>
          <p>Run NetBird{!setupKey && ' and log in the browser'}</p>
          <NetbirdUp setupKey={setupKey} />
        </Step>
      </More>
    </>
  );
}

function DockerTab({ setupKey, keyStep }: { setupKey: string; keyStep?: ReactNode }) {
  const offset = keyStep ? 1 : 0;
  const runCmd = [
    'docker run --rm -d',
    '--cap-add=NET_ADMIN',
    `-e NB_SETUP_KEY=${setupKey}`,
    '-v netbird-client:/var/lib/netbird',
    'netbirdio/netbird:latest',
  ].join(' ');
  return (
    <>
      <TabTitle icon={<FaDocker size={16} />}>Install on Ubuntu</TabTitle>
      <Step n={1}>
        <p>Install Docker</p>
        <div className="mt-2">
          <a href={DOCKER_INSTALL_GUIDE} target="_blank" rel="noopener noreferrer" className={linkBtnSecondary}>
            <ExternalLink size={14} /> Official Docker Installation Guide
          </a>
        </div>
      </Step>
      {keyStep && <Step n={2}>{keyStep}</Step>}
      <Step n={2 + offset}>
        <p>Run NetBird container</p>
        <Code
          copy={runCmd}
          lines={[
            'docker run --rm -d \\',
            '  --cap-add=NET_ADMIN \\',
            <>{'  -e NB_SETUP_KEY='}<span className="text-netbird">{setupKey}</span>{' \\'}</>,
            '  -v netbird-client:/var/lib/netbird \\',
            '  netbirdio/netbird:latest',
          ]}
        />
      </Step>
      <Step n={3 + offset} last>
        <p>Read our documentation</p>
        <div className="mt-1"><DocLink href={DOCS_DOCKER}>Running NetBird in Docker</DocLink></div>
      </Step>
    </>
  );
}

function IosTab() {
  return (
    <>
      <TabTitle icon={<ShoppingBag size={16} />}>Install on iOS</TabTitle>
      <Step n={1}>
        <p>Download and install the application on the App Store:</p>
        <div className="mt-2">
          <a href={APP_STORE} target="_blank" rel="noopener noreferrer" className={linkBtnSecondary}>
            <FaAppStoreIos size={15} /> Download on the App Store
          </a>
        </div>
      </Step>
      <Step n={2}><p>Click on the &quot;Connect&quot; button in the middle of the screen</p></Step>
      <Step n={3} last><p>Sign up using your email address</p></Step>
    </>
  );
}

function AndroidTab() {
  return (
    <>
      <TabTitle icon={<ShoppingBag size={16} />}>Install on Android</TabTitle>
      <Step n={1}>
        <p>Download and install the application from Google Play Store:</p>
        <div className="mt-2">
          <a href={PLAY_STORE} target="_blank" rel="noopener noreferrer" className={linkBtnSecondary}>
            <FaAndroid size={15} /> Get It On Google Play
          </a>
        </div>
      </Step>
      <Step n={2}><p>Click on the &quot;Connect&quot; button in the middle of the screen</p></Step>
      <Step n={3} last><p>Sign up using your email address</p></Step>
    </>
  );
}

// ─── The modal ───

/** Best-effort visitor OS for the default tab; Android must be tested before Linux
 *  (its user-agent contains "Linux"), and anything unknown falls back to Linux. */
function detectOs(): OsKey {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
  return 'linux';
}

const TAB_META: Record<OsKey, { label: string; icon: ReactNode }> = {
  linux: { label: 'Linux', icon: <FaLinux size={15} /> },
  windows: { label: 'Windows', icon: <FaWindows size={15} /> },
  macos: { label: 'macOS', icon: <FaApple size={15} /> },
  ios: { label: 'iOS', icon: <FaAppStoreIos size={15} /> },
  android: { label: 'Android', icon: <FaAndroid size={15} /> },
  docker: { label: 'Docker', icon: <FaDocker size={15} /> },
};

export function AddPeerModal({ mode, onClose }: { mode: AddPeerMode; onClose: () => void }) {
  const isServer = mode === 'server';
  const tabs: OsKey[] = isServer
    ? ['linux', 'windows', 'macos', 'docker']
    : ['linux', 'windows', 'macos', 'ios', 'android'];
  // Servers are enrolled from a shell, so they always start on Linux; user devices open on
  // the OS the visitor is browsing from.
  const [os, setOs] = useState<OsKey>(() => (isServer ? 'linux' : detectOs()));
  // One key for the whole modal - switching tabs must not generate a second one.
  const [generated, setGenerated] = useState<SetupKeyResult | null>(null);

  const setupKey = isServer ? (generated?.key || KEY_PLACEHOLDER) : undefined;
  const keyStep = isServer ? <SetupKeyStep generated={generated} onGenerated={setGenerated} /> : undefined;

  return (
    <Modal open onClose={onClose} widthClass="max-w-[740px]">
      <div className="relative">
        <button onClick={onClose} title="Close" aria-label="Close dialog"
          className="absolute -right-2 -top-2 p-1 text-nb-gray-400 hover:text-red-500 transition-colors">
          <X size={20} />
        </button>

        <div className="px-6 pb-5 pt-2 text-center">
          <h2 className="text-2xl font-semibold text-nb-gray-900 dark:text-nb-gray-50">
            {isServer ? 'Install NetBird with Setup Key' : 'Install NetBird'}
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-nb-gray-500 dark:text-nb-gray-400">
            {isServer
              ? 'To get started, install and run NetBird with the setup key as a parameter.'
              : 'To get started, install NetBird and log in with your email account.'}
          </p>
        </div>

        {/* Underline tabs, centered like the official modal. */}
        <div className="-mx-6 px-6">
          <div className="flex items-end justify-center gap-1 overflow-x-auto border-b border-nb-gray-200 dark:border-nb-gray-900">
            {tabs.map((k) => (
              <button key={k} onClick={() => setOs(k)}
                className={cn(
                  'relative inline-flex items-center gap-2 whitespace-nowrap px-3 pt-1.5 pb-3 text-sm transition-colors',
                  k === os ? 'text-netbird' : 'text-nb-gray-600 hover:text-nb-gray-900 dark:text-nb-gray-400 dark:hover:text-nb-gray-200',
                )}>
                {TAB_META[k].icon}{TAB_META[k].label}
                <span className={cn('absolute inset-x-0 bottom-0 h-[1.5px] transition-all', k === os ? 'bg-netbird' : 'bg-transparent')} />
              </button>
            ))}
          </div>
        </div>

        <div className="pt-5">
          {os === 'linux' && <LinuxTab setupKey={setupKey} keyStep={keyStep} />}
          {os === 'windows' && <WindowsTab setupKey={setupKey} keyStep={keyStep} />}
          {os === 'macos' && <MacOsTab setupKey={setupKey} keyStep={keyStep} />}
          {os === 'docker' && <DockerTab setupKey={setupKey || KEY_PLACEHOLDER} keyStep={keyStep} />}
          {os === 'ios' && <IosTab />}
          {os === 'android' && <AndroidTab />}
        </div>

      </div>
    </Modal>
  );
}

// ─── "Add Peer" split button (page header + empty state) ───

/** Primary Add Peer button with the User Device / Server picker. Owns the modal, so both
 *  call sites (the Peers header and the empty state) behave identically. */
export function AddPeerButton({ className }: { className?: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AddPeerMode | null>(null);
  const btnRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  const width = 210;
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), top: r.bottom + 6 });
    };
    measure();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('resize', measure);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const items: { mode: AddPeerMode; label: string; hint: string; icon: ReactNode }[] = [
    { mode: 'user-device', label: 'User Device', hint: 'Laptop or phone, added with a login', icon: <Monitor size={14} /> },
    { mode: 'server', label: 'Server', hint: 'Unattended machine, added with a setup key', icon: <TerminalSquare size={14} /> },
  ];

  return (
    <>
      <div ref={btnRef} className={cn('shrink-0', className)}>
        <Button variant="primary" onClick={() => setOpen((o) => !o)}>
          <PlusCircle size={15} /> Add Peer <ChevronDown size={14} className="opacity-70" />
        </Button>
      </div>
      {open && createPortal(
        <div ref={panelRef} style={{ position: 'fixed', left: pos.left, top: pos.top, width, zIndex: 1200 }}
          className="rounded-md border p-1.5 shadow-xl border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950">
          {items.map((it) => (
            <button key={it.mode} type="button" onClick={() => { setMode(it.mode); setOpen(false); }}
              className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900">
              <span className="mt-0.5 shrink-0 text-nb-gray-400">{it.icon}</span>
              <span className="min-w-0">
                <span className="block text-sm text-nb-gray-800 dark:text-nb-gray-100">{it.label}</span>
                <span className="block text-[0.72rem] text-nb-gray-500">{it.hint}</span>
              </span>
            </button>
          ))}
        </div>,
        document.body,
      )}
      {mode && <AddPeerModal mode={mode} onClose={() => {
        setMode(null);
        // The machine may have enrolled while the modal was open - force-refresh the peers
        // mirror (works in tenant context too) so it shows up without waiting for the TTL.
        api.post('/api/refresh').catch(() => { }).then(() => qc.invalidateQueries({ queryKey: ['peers'] }));
      }} />}
    </>
  );
}

/** Official "no peers yet" screen, shown instead of the table when the account is empty. */
export function PeersEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100 dark:bg-nb-gray-930/60 text-nb-gray-400">
        <Monitor size={24} />
      </div>
      <h2 className="mt-1 text-xl font-semibold text-nb-gray-900 dark:text-nb-gray-50">Get Started with NetBird</h2>
      <p className="max-w-md text-sm text-nb-gray-500 dark:text-nb-gray-400">
        It looks like you don&apos;t have any connected machines. Get started by adding one to your network.
      </p>
      <div className="mt-2"><AddPeerButton /></div>
    </div>
  );
}
