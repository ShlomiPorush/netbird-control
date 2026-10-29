// Log formatting helpers - ported from the vanilla app.js for faithful parity.
import type { LogEvent } from './types';

const PORT_MAP: Record<number, string> = {
  20: 'FTP-Data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP',
  53: 'DNS', 67: 'DHCP', 68: 'DHCP', 69: 'TFTP', 80: 'HTTP',
  88: 'Kerberos', 110: 'POP3', 111: 'RPC', 119: 'NNTP', 123: 'NTP',
  135: 'MS-RPC', 137: 'NetBIOS', 138: 'NetBIOS', 139: 'NetBIOS',
  143: 'IMAP', 161: 'SNMP', 162: 'SNMP-Trap', 179: 'BGP',
  194: 'IRC', 389: 'LDAP', 443: 'HTTPS', 445: 'SMB',
  464: 'Kerberos', 465: 'SMTPS', 500: 'IKE', 514: 'Syslog',
  515: 'LPD', 520: 'RIP', 523: 'IBM-DB2', 530: 'RPC',
  543: 'Klogin', 544: 'Kshell', 546: 'DHCPv6', 547: 'DHCPv6',
  554: 'RTSP', 587: 'SMTP-Sub', 591: 'FileMaker', 593: 'MS-RPC',
  631: 'IPP', 636: 'LDAPS', 639: 'MSDP', 646: 'LDP',
  691: 'MS-Exchange', 860: 'iSCSI', 873: 'Rsync', 902: 'VMware',
  989: 'FTPS-Data', 990: 'FTPS', 993: 'IMAPS', 995: 'POP3S',
  1080: 'SOCKS', 1194: 'OpenVPN', 1433: 'MSSQL', 1434: 'MSSQL-Mon',
  1521: 'Oracle', 1723: 'PPTP', 1812: 'RADIUS', 1813: 'RADIUS-Acct',
  1883: 'MQTT', 1900: 'SSDP', 2049: 'NFS', 2082: 'cPanel',
  2083: 'cPanel-SSL', 2086: 'WHM', 2087: 'WHM-SSL',
  2181: 'ZooKeeper', 2222: 'SSH-Alt', 2375: 'Docker',
  2376: 'Docker-SSL', 2483: 'Oracle-SSL', 2484: 'Oracle-SSL',
  3000: 'Grafana', 3268: 'LDAP-GC', 3269: 'LDAPS-GC',
  3306: 'MySQL', 3389: 'RDP', 3478: 'STUN', 3479: 'STUN',
  4443: 'Pharos', 4500: 'IPSec', 4789: 'VXLAN',
  5000: 'UPnP', 5001: 'Synology', 5004: 'RTP', 5005: 'RTP',
  5060: 'SIP', 5061: 'SIP-TLS', 5222: 'XMPP', 5223: 'XMPP-SSL',
  5432: 'PostgreSQL', 5500: 'VNC', 5601: 'Kibana',
  5672: 'AMQP', 5900: 'VNC', 5901: 'VNC', 5938: 'TeamViewer',
  5984: 'CouchDB', 5985: 'WinRM', 5986: 'WinRM-SSL',
  6379: 'Redis', 6443: 'K8s-API', 6514: 'Syslog-TLS',
  6660: 'IRC', 6661: 'IRC', 6662: 'IRC', 6663: 'IRC',
  6664: 'IRC', 6665: 'IRC', 6666: 'IRC', 6667: 'IRC',
  6668: 'IRC', 6669: 'IRC', 6881: 'BitTorrent',
  7001: 'WebLogic', 7002: 'WebLogic-SSL', 7071: 'Zimbra',
  7474: 'Neo4j', 8000: 'HTTP-Alt', 8006: 'Proxmox',
  8008: 'HTTP-Alt', 8080: 'HTTP-Proxy', 8081: 'HTTP-Alt',
  8082: 'HTTP-Alt', 8083: 'HTTP-Alt', 8088: 'HTTP-Alt',
  8123: 'HomeAssistant', 8200: 'Vault', 8291: 'MikroTik',
  8443: 'HTTPS-Alt', 8444: 'HTTPS-Alt', 8500: 'Consul',
  8834: 'Nessus', 8888: 'HTTP-Alt', 8883: 'MQTT-SSL',
  9000: 'Portainer', 9001: 'Portainer-Agent', 9090: 'Prometheus',
  9091: 'Transmission', 9092: 'Kafka', 9100: 'Print',
  9200: 'Elasticsearch', 9300: 'Elasticsearch', 9418: 'Git',
  9443: 'HTTPS-Alt', 9999: 'Iperf',
  10000: 'Webmin', 10250: 'Kubelet', 10443: 'HTTPS-Alt',
  11211: 'Memcached', 11371: 'PGP-HKP',
  15672: 'RabbitMQ-Mgmt', 16992: 'Intel-AMT', 16993: 'Intel-AMT-SSL',
  17500: 'Dropbox', 19132: 'Minecraft-BE', 25565: 'Minecraft',
  25575: 'Minecraft-RCON', 27015: 'Steam', 27017: 'MongoDB',
  27018: 'MongoDB', 28015: 'RethinkDB',
  30000: 'K8s-NodePort', 32400: 'Plex', 32768: 'RPC',
  33434: 'Traceroute', 43594: 'RuneScape',
  47984: 'Moonlight', 47989: 'Moonlight', 47990: 'Moonlight',
  51413: 'Transmission', 51820: 'WireGuard', 51821: 'WireGuard',
  54321: 'PostgreSQL-Alt', 55555: 'Metasploit',
};

const PROTOCOL_MAP: Record<number, string> = {
  1: 'ICMP', 6: 'TCP', 17: 'UDP', 47: 'GRE', 50: 'ESP', 58: 'ICMPv6',
};

const ICMP_TYPE_NAMES: Record<number, string> = {
  0: 'Echo Reply', 3: 'Destination Unreachable', 5: 'Redirect',
  8: 'Echo Request', 9: 'Router Advertisement', 10: 'Router Solicitation',
  11: 'Time Exceeded',
};

const ICMP_CODE_NAMES: Record<number, Record<number, string>> = {
  3: { 0: 'Net Unreachable', 1: 'Host Unreachable', 2: 'Protocol Unreachable', 3: 'Port Unreachable', 4: 'Fragmentation Needed', 5: 'Source Route Failed', 6: 'Network Unknown', 7: 'Host Unknown', 9: 'Network Prohibited', 10: 'Host Prohibited', 13: 'Communication Prohibited' },
  5: { 0: 'Redirect for Network', 1: 'Redirect for Host', 2: 'Redirect for TOS & Network', 3: 'Redirect for TOS & Host' },
  11: { 0: 'TTL Exceeded', 1: 'Fragment Reassembly Exceeded' },
};

export function getServiceName(addr?: string): string {
  if (!addr || addr === '-') return '';
  const m = addr.match(/:(\d+)$/);
  if (!m) return '';
  return PORT_MAP[parseInt(m[1], 10)] || '';
}

function getIcmpLabel(t?: number, c?: number): string {
  if (t === undefined) return '';
  const codeMap = ICMP_CODE_NAMES[t];
  if (codeMap && c !== undefined && codeMap[c]) return codeMap[c];
  return ICMP_TYPE_NAMES[t] || (t ? `Type ${t}${c ? ` Code ${c}` : ''}` : '');
}

export type ProtoClass = 'tcp' | 'udp' | 'icmp' | 'unknown';

export function getProtocol(num: unknown, ev: LogEvent): { label: string; cls: ProtoClass; icmpLabel: string } {
  const n = Number(num);
  const label = PROTOCOL_MAP[n] || `Proto ${num}`;
  const lower = label.toLowerCase();
  let cls: ProtoClass = 'unknown';
  if (lower === 'tcp') cls = 'tcp';
  else if (lower === 'udp') cls = 'udp';
  else if (lower === 'icmp' || lower === 'icmpv6') cls = 'icmp';
  const icmpLabel = (n === 1 || n === 58) && (ev.icmp_type !== undefined || ev.icmp_code !== undefined)
    ? getIcmpLabel(ev.icmp_type as number, ev.icmp_code as number)
    : '';
  return { label, cls, icmpLabel };
}

export function formatBytes(bytes: unknown): string {
  const b = parseInt(String(bytes), 10) || 0;
  if (b === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  const val = b / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

// ─── Configurable display formatting for all rendered log times ───
// Set once from the app config (Settings → General) so every timestamp in the app
// shares the same timezone, date format and clock. The defaults below match the
// app's original behaviour (US medium date, 12-hour clock, browser-local zone).
export interface TimeFormatCfg { timeZone?: string; dateFormat?: string; hour12?: boolean }

// Date-format presets → a (locale, options) pair that yields the desired shape.
// Keys are also the stored setting values; see DATE_FORMAT_SAMPLES for labels.
const DATE_OPTS: Record<string, { locale: string; opts: Intl.DateTimeFormatOptions }> = {
  med:     { locale: 'en-US', opts: { year: 'numeric', month: 'short', day: 'numeric' } }, // Jun 28, 2026
  dmy_med: { locale: 'en-GB', opts: { year: 'numeric', month: 'short', day: 'numeric' } }, // 28 Jun 2026
  iso:     { locale: 'en-CA', opts: { year: 'numeric', month: '2-digit', day: '2-digit' } }, // 2026-06-28
  dmy:     { locale: 'en-GB', opts: { year: 'numeric', month: '2-digit', day: '2-digit' } }, // 28/06/2026
  mdy:     { locale: 'en-US', opts: { year: 'numeric', month: '2-digit', day: '2-digit' } }, // 06/28/2026
};

export const DATE_FORMATS = ['med', 'dmy_med', 'iso', 'dmy', 'mdy'] as const;

function normalizeTz(tz?: string): string | undefined {
  const t = (tz || '').trim();
  if (!t) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: t }); return t; }
  catch { return undefined; }
}

function fmtDateTime(d: Date, cfg: TimeFormatCfg): string {
  const tz = normalizeTz(cfg.timeZone);
  const tzOpt = tz ? { timeZone: tz } : {};
  const df = DATE_OPTS[cfg.dateFormat || 'med'] || DATE_OPTS.med;
  const hour12 = cfg.hour12 !== false;
  const date = d.toLocaleDateString(df.locale, { ...df.opts, ...tzOpt });
  const time = d.toLocaleTimeString('en-US', {
    hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', second: '2-digit', hour12, ...tzOpt,
  });
  return `${date}, ${time}`;
}

// Format with explicit config (used for the live Settings preview before saving).
export function formatTimeWith(ts: string | number | Date, cfg: TimeFormatCfg): string {
  try { return fmtDateTime(new Date(ts), cfg); } catch { return String(ts); }
}

let _fmt: TimeFormatCfg = { dateFormat: 'med', hour12: true };

export function setTimeFormat(cfg: TimeFormatCfg): void {
  _fmt = { timeZone: cfg.timeZone, dateFormat: cfg.dateFormat || 'med', hour12: cfg.hour12 !== false };
}

export function formatTimestamp(ts?: string): string {
  if (!ts) return '';
  try { return fmtDateTime(new Date(ts), _fmt); } catch { return ts; }
}

export function formatMaybeDate(ts?: string): string {
  if (!ts) return '-';
  const d = new Date(ts);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '-';
  return formatTimestamp(ts);
}

export function formatUserId(uid?: string): string {
  if (!uid) return 'Unknown';
  return uid.length > 30 ? uid.slice(0, 30) + '…' : uid;
}

// Quick-select range key → { from, to } ISO timestamps. Custom = "from,to" (YYYY-MM-DD).
export function getDateRange(range: string): { from?: string; to?: string } {
  const now = new Date();
  if (range && range.includes(',')) {
    const [fromStr, toStr] = range.split(',');
    const result: { from?: string; to?: string } = {};
    if (fromStr) result.from = new Date(fromStr + 'T00:00:00').toISOString();
    if (toStr) result.to = new Date(toStr + 'T23:59:59').toISOString();
    return result;
  }
  let from: Date | null = null;
  switch (range) {
    case 'today': from = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break;
    case '24h': from = new Date(now.getTime() - 24 * 36e5); break;
    case '7d': from = new Date(now.getTime() - 7 * 24 * 36e5); break;
    case '30d': from = new Date(now.getTime() - 30 * 24 * 36e5); break;
    case '90d': from = new Date(now.getTime() - 90 * 24 * 36e5); break;
    default: return {};
  }
  return { from: from.toISOString(), to: now.toISOString() };
}
