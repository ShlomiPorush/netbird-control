<#
.SYNOPSIS
    NetBird connectivity diagnostics for Windows.

.DESCRIPTION
    Runs a full local health check of the NetBird client and its connectivity:
      1.  NetBird binary + version
      2.  NetBird Windows service state
      3.  Client status (management / signal connections, NetBird IP, peer counts)
      4.  The NetBird network adapter + assigned IP
      5.  Basic internet connectivity + public DNS resolution
      6.  Reachability of the management and signal servers (TCP 443)
      7.  STUN reachability (UDP 3478 - a real STUN binding request)
      8.  Connected vs. total peers, with the peers that are NOT connected listed
      9.  Optional: ping + MTU probe against an internal host over the tunnel (-TestHost)
      10. Windows Firewall profiles + NetBird firewall rules
      11. Recent errors in the NetBird client log
    Every check prints PASS / WARN / FAIL, and a full report (including raw
    `netbird status -d` output and a log tail) is saved to the TEMP folder -
    the exact path is printed at the end of the run.

.PARAMETER TestHost
    An internal IP or DNS name reachable ONLY through NetBird (e.g. a routing
    peer's LAN address or an internal server). Adds tunnel ping + MTU probing.

.PARAMETER ManagementUrl
    Override the management URL to test. Default: taken from `netbird status`,
    falling back to https://api.netbird.io (NetBird Cloud).

.PARAMETER NoElevate
    Skip the automatic Administrator (UAC) prompt and run with current rights.
    The firewall-rules and client-log checks are limited without elevation.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Diagnose-NetBird.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Diagnose-NetBird.ps1 -TestHost 10.10.0.5
#>
[CmdletBinding()]
param(
    [string]$TestHost = '',
    [string]$ManagementUrl = '',
    # Skip the automatic elevation prompt and run with the current (limited) rights.
    [switch]$NoElevate,
    # Internal: set by the self-elevation relaunch so the new window pauses before closing.
    [switch]$Elevated
)

$ErrorActionPreference = 'SilentlyContinue'
$script:Results = New-Object System.Collections.ArrayList

# --- Self-elevation -----------------------------------------------------------
# The firewall-rules and client-log checks need Administrator rights. Instead of
# telling the user to reopen an elevated console, relaunch ourselves via UAC. If
# the prompt is declined (or the user has no admin rights), continue un-elevated -
# those two checks simply degrade, everything else works.
$script:IsElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $script:IsElevated -and -not $NoElevate) {
    $relaunch = @('-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath), '-Elevated')
    if ($TestHost) { $relaunch += @('-TestHost', ('"{0}"' -f $TestHost)) }
    if ($ManagementUrl) { $relaunch += @('-ManagementUrl', ('"{0}"' -f $ManagementUrl)) }
    try {
        Start-Process -FilePath 'powershell.exe' -ArgumentList $relaunch -Verb RunAs -ErrorAction Stop
        Write-Host 'Elevation approved - the diagnostics continue in the new (Administrator) window.' -ForegroundColor Cyan
        exit
    } catch {
        Write-Host 'Elevation declined or unavailable - continuing without it (the firewall-rules and client-log checks will be limited).' -ForegroundColor Yellow
    }
}

# --- Helpers ----------------------------------------------------------------
function Add-Result {
    param([string]$Check, [ValidateSet('PASS', 'WARN', 'FAIL', 'INFO')][string]$Status, [string]$Detail)
    [void]$script:Results.Add([pscustomobject]@{ Check = $Check; Status = $Status; Detail = $Detail })
    $color = switch ($Status) { 'PASS' { 'Green' } 'WARN' { 'Yellow' } 'FAIL' { 'Red' } default { 'Gray' } }
    Write-Host ("  [{0}] " -f $Status) -ForegroundColor $color -NoNewline
    Write-Host ("{0}" -f $Check) -NoNewline
    if ($Detail) { Write-Host (" - {0}" -f $Detail) -ForegroundColor DarkGray } else { Write-Host '' }
}
function Section { param([string]$Title) Write-Host ""; Write-Host ("-- {0} " -f $Title).PadRight(70, [char]0x2500) -ForegroundColor Cyan }

function Test-TcpPort {
    param([string]$TargetHost, [int]$Port, [int]$TimeoutMs = 5000)
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($TargetHost, $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if ($ok -and $client.Connected) { $client.EndConnect($iar); $client.Close(); return $true }
        $client.Close(); return $false
    } catch { return $false }
}

# A minimal RFC 5389 STUN binding request - proves UDP 3478 actually works end to end.
function Test-Stun {
    param([string]$StunHost, [int]$Port = 3478, [int]$TimeoutMs = 5000)
    try {
        $udp = New-Object System.Net.Sockets.UdpClient
        $udp.Client.ReceiveTimeout = $TimeoutMs
        # Header: type 0x0001 (Binding Request), length 0, magic cookie, 12-byte transaction id
        $req = New-Object byte[] 20
        $req[0] = 0x00; $req[1] = 0x01; $req[2] = 0x00; $req[3] = 0x00
        $req[4] = 0x21; $req[5] = 0x12; $req[6] = 0xA4; $req[7] = 0x42
        $rnd = New-Object System.Random
        for ($i = 8; $i -lt 20; $i++) { $req[$i] = [byte]$rnd.Next(0, 256) }
        $udp.Connect($StunHost, $Port)
        [void]$udp.Send($req, $req.Length)
        $remote = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
        $resp = $udp.Receive([ref]$remote)
        $udp.Close()
        # Binding Success Response starts 0x0101
        return ($resp.Length -ge 20 -and $resp[0] -eq 0x01 -and $resp[1] -eq 0x01)
    } catch { return $false }
}

# --- Start ------------------------------------------------------------------
$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
# TEMP, deliberately - diagnostics runs must not pile up on the user's Desktop.
$reportPath = Join-Path $env:TEMP ("netbird-diagnostics-{0}.txt" -f $stamp)

Write-Host ""
Write-Host "NetBird Connectivity Diagnostics" -ForegroundColor White
Write-Host ("Computer: {0}   User: {1}   Time: {2}   Elevated: {3}" -f $env:COMPUTERNAME, $env:USERNAME, (Get-Date), $(if ($script:IsElevated) { 'yes' } else { 'no' })) -ForegroundColor DarkGray

# --- 1. Binary --------------------------------------------------------------
Section 'NetBird Client'
$nb = $null
$cmd = Get-Command netbird -ErrorAction SilentlyContinue
if ($cmd) { $nb = $cmd.Source }
if (-not $nb) {
    foreach ($p in @("$env:ProgramFiles\NetBird\netbird.exe", "$env:ProgramFiles(x86)\NetBird\netbird.exe", "$env:LOCALAPPDATA\Programs\netbird\netbird.exe")) {
        if (Test-Path $p) { $nb = $p; break }
    }
}
if ($nb) {
    $ver = (& $nb version 2>$null | Select-Object -First 1)
    Add-Result 'NetBird installed' 'PASS' ("{0} (version {1})" -f $nb, $ver)
} else {
    Add-Result 'NetBird installed' 'FAIL' 'netbird.exe not found - install the NetBird client'
}

# --- 2. Service -------------------------------------------------------------
$svc = Get-Service -Name 'netbird' -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq 'Running') { Add-Result 'NetBird service' 'PASS' 'Running' }
    else { Add-Result 'NetBird service' 'FAIL' ("Service state: {0} - try: net start netbird" -f $svc.Status) }
} else {
    Add-Result 'NetBird service' 'WARN' 'No "netbird" Windows service found (client may run in user mode)'
}

# --- 3. Client status -------------------------------------------------------
$statusJson = $null; $statusRaw = ''; $statusDetail = ''
if ($nb) {
    $statusRaw = (& $nb status 2>&1 | Out-String)
    $statusDetail = (& $nb status -d 2>&1 | Out-String)
    $jsonText = (& $nb status --json 2>$null | Out-String)
    if ($jsonText -and $jsonText.Trim().StartsWith('{')) { $statusJson = $jsonText | ConvertFrom-Json }
}
$mgmtHost = ''; $signalHost = ''
if ($statusJson) {
    $mgmtConnected = $false; $signalConnected = $false
    if ($statusJson.management) { $mgmtConnected = [bool]$statusJson.management.connected; if ($statusJson.management.url) { $mgmtHost = ([uri]$statusJson.management.url.Replace('rels://', 'https://').Replace(':443', '')).Host } }
    if ($statusJson.signal) { $signalConnected = [bool]$statusJson.signal.connected; if ($statusJson.signal.url) { $signalHost = ([uri]$statusJson.signal.url.Replace('rels://', 'https://').Replace(':443', '')).Host } }
    if ($mgmtConnected) { Add-Result 'Management connection' 'PASS' 'Connected' } else { Add-Result 'Management connection' 'FAIL' 'NOT connected to the management server' }
    if ($signalConnected) { Add-Result 'Signal connection' 'PASS' 'Connected' } else { Add-Result 'Signal connection' 'FAIL' 'NOT connected to the signal server' }
    if ($statusJson.netbirdIp) { Add-Result 'NetBird IP' 'PASS' $statusJson.netbirdIp }
    elseif ($statusRaw -match 'NetBird IP:\s*(\S+)') { Add-Result 'NetBird IP' 'PASS' $Matches[1] }
    else { Add-Result 'NetBird IP' 'FAIL' 'No NetBird IP assigned - client may be logged out (run: netbird up)' }
} elseif ($statusRaw) {
    if ($statusRaw -match 'Management:\s*Connected') { Add-Result 'Management connection' 'PASS' 'Connected' } else { Add-Result 'Management connection' 'FAIL' ($statusRaw -split "`n" | Where-Object { $_ -match 'Management' } | Select-Object -First 1) }
    if ($statusRaw -match 'Signal:\s*Connected') { Add-Result 'Signal connection' 'PASS' 'Connected' } else { Add-Result 'Signal connection' 'FAIL' 'Signal not connected' }
    if ($statusRaw -match 'NetBird IP:\s*(\S+)') { Add-Result 'NetBird IP' 'PASS' $Matches[1] } else { Add-Result 'NetBird IP' 'FAIL' 'No IP - run: netbird up' }
    if ($statusRaw -match 'Daemon status: NeedsLogin') { Add-Result 'Login state' 'FAIL' 'Client needs login - run: netbird up' }
} else {
    Add-Result 'Client status' 'FAIL' 'Could not read "netbird status" - is the client installed and the service running?'
}

# --- 4. Network adapter -----------------------------------------------------
Section 'Network Adapter'
$adapter = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'WireGuard|netbird' -or $_.Name -match 'netbird|wt' } | Select-Object -First 1
if ($adapter) {
    if ($adapter.Status -eq 'Up') { Add-Result 'Tunnel adapter' 'PASS' ("{0} ({1})" -f $adapter.Name, $adapter.Status) }
    else { Add-Result 'Tunnel adapter' 'FAIL' ("{0} is {1}" -f $adapter.Name, $adapter.Status) }
    $ip = Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($ip) { Add-Result 'Tunnel IP' 'PASS' ("{0}/{1}" -f $ip.IPAddress, $ip.PrefixLength) } else { Add-Result 'Tunnel IP' 'FAIL' 'No IPv4 address on the tunnel adapter' }
    $mtu = (Get-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).NlMtu
    if ($mtu) { Add-Result 'Tunnel MTU' 'INFO' ("{0}" -f $mtu) }
} else {
    Add-Result 'Tunnel adapter' 'FAIL' 'No NetBird/WireGuard adapter found'
}

# --- 5. Internet ------------------------------------------------------------
Section 'Internet'
$ping = Test-Connection -ComputerName 1.1.1.1 -Count 2 -Quiet -ErrorAction SilentlyContinue
if ($ping) { Add-Result 'Internet (ICMP 1.1.1.1)' 'PASS' '' } else { Add-Result 'Internet (ICMP 1.1.1.1)' 'WARN' 'No ping reply (ICMP may be blocked - not fatal on its own)' }
$dns = Resolve-DnsName -Name 'netbird.io' -Type A -ErrorAction SilentlyContinue
if ($dns) { Add-Result 'Public DNS resolution' 'PASS' 'netbird.io resolves' } else { Add-Result 'Public DNS resolution' 'FAIL' 'Cannot resolve netbird.io - DNS problem' }
if (Test-TcpPort -TargetHost 'www.microsoft.com' -Port 443) { Add-Result 'Outbound HTTPS (443)' 'PASS' '' } else { Add-Result 'Outbound HTTPS (443)' 'FAIL' 'TCP 443 outbound appears blocked' }

# --- 6. NetBird infrastructure ----------------------------------------------
Section 'NetBird Infrastructure'
if ($ManagementUrl) { $mgmtHost = ([uri]$ManagementUrl).Host }
if (-not $mgmtHost) { $mgmtHost = 'api.netbird.io' }
if (-not $signalHost) { $signalHost = 'signal.netbird.io' }
if (Test-TcpPort -TargetHost $mgmtHost -Port 443) { Add-Result ("Management server ({0}:443)" -f $mgmtHost) 'PASS' '' } else { Add-Result ("Management server ({0}:443)" -f $mgmtHost) 'FAIL' 'Unreachable - firewall/proxy blocking?' }
if (Test-TcpPort -TargetHost $signalHost -Port 443) { Add-Result ("Signal server ({0}:443)" -f $signalHost) 'PASS' '' } else { Add-Result ("Signal server ({0}:443)" -f $signalHost) 'FAIL' 'Unreachable - firewall/proxy blocking?' }
# Per docs.netbird.io/about-netbird/ports-and-firewalls, stun.netbird.io answers on
# UDP 80, 443, 3478 and 5555 - any ONE working port is enough for hole punching.
$stunPort = $null
foreach ($sp in 3478, 5555, 443, 80) {
    if (Test-Stun -StunHost 'stun.netbird.io' -Port $sp) { $stunPort = $sp; break }
}
if ($stunPort -eq 3478) { Add-Result 'STUN (UDP)' 'PASS' 'Binding response on udp/3478' }
elseif ($stunPort) { Add-Result 'STUN (UDP)' 'PASS' ("Binding response on udp/{0} (3478 did not answer - fine, NetBird also uses 80/443/5555)" -f $stunPort) }
else { Add-Result 'STUN (UDP)' 'WARN' 'No STUN response on udp 80/443/3478/5555 - outbound UDP looks blocked. Firewall needs OUTBOUND UDP to stun.netbird.io (80,443,3478,5555) and turn.netbird.io (80,443); without it, direct P2P fails and traffic falls back to relay over TCP' }

# --- 7. Peers ---------------------------------------------------------------
Section 'Peers'
if ($statusJson -and $statusJson.peers) {
    $total = [int]$statusJson.peers.total; $connected = [int]$statusJson.peers.connected
    # 'Idle' is NORMAL - with lazy connections a peer connects on first use, not up front.
    $idle = @($statusJson.peers.details | Where-Object { $_.status -eq 'Idle' })
    $down = @($statusJson.peers.details | Where-Object { $_.status -ne 'Connected' -and $_.status -ne 'Idle' })
    if ($total -eq 0) { Add-Result 'Peers' 'WARN' 'No peers visible - check group membership / policies for this device' }
    elseif ($down.Count -eq 0) { Add-Result 'Peers' 'PASS' ("{0}/{1} connected, {2} idle (connect on demand)" -f $connected, $total, $idle.Count) }
    else {
        Add-Result 'Peers' 'WARN' ("{0}/{1} connected, {2} idle, {3} NOT reachable" -f $connected, $total, $idle.Count, $down.Count)
        foreach ($p in ($down | Select-Object -First 8)) {
            Add-Result ("  Peer {0}" -f $p.fqdn) 'INFO' ("{0} ({1})" -f $p.status, $p.netbirdIp)
        }
        if ($down.Count -gt 8) { Add-Result '  More peers down' 'INFO' ("+{0} more" -f ($down.Count - 8)) }
    }
    $relayed = @($statusJson.peers.details | Where-Object { $_.status -eq 'Connected' -and $_.connectionType -match 'Relayed' })
    if ($relayed.Count) { Add-Result 'Relayed connections' 'INFO' ("{0} peer(s) via relay (no direct P2P) - usually a NAT/UDP issue" -f $relayed.Count) }
} elseif ($statusRaw -match 'Peers count:\s*(\d+)/(\d+)') {
    Add-Result 'Peers' 'INFO' ("{0}/{1} connected" -f $Matches[1], $Matches[2])
}

# --- 7b. Networks & exit node (client-side selection) ------------------------
# Whether an exit node is USED is a device-side toggle the management plane cannot
# see - only the local client knows. Newer clients: "netbird networks ls";
# older ones: "netbird routes ls".
Section 'Networks & Exit Node'
$netsOut = ''
$exitBlocks = @()
if ($nb) {
    $netsOut = (& $nb networks ls 2>$null | Out-String)
    if (-not $netsOut -or -not $netsOut.Trim()) { $netsOut = (& $nb routes ls 2>$null | Out-String) }
}
if ($netsOut -and $netsOut.Trim()) {
    $blocks = $netsOut -split "(\r?\n){2,}"
    $exitBlocks = @($blocks | Where-Object { $_ -match '0\.0\.0\.0/0' })
    if ($exitBlocks.Count) {
        $selected = @($exitBlocks | Where-Object { $_ -match 'Status:\s*Selected' })
        if ($selected.Count) {
            Add-Result 'Exit node' 'INFO' 'ENABLED on this device - ALL internet traffic goes through NetBird right now'
        } else {
            Add-Result 'Exit node' 'INFO' 'Offered to this device but NOT enabled - internet traffic takes the regular path'
        }
    } else {
        Add-Result 'Exit node' 'INFO' 'No exit node is offered to this device'
    }
    # Route entries offered to this client ("Selected" on a normal route just means it is
    # applied - counting those as interesting was noise).
    $routeCount = @($netsOut -split "`n" | Where-Object { $_ -match '^\s*ID:' }).Count
    if (-not $routeCount) { $routeCount = @($netsOut -split "`n" | Where-Object { $_ -match 'Status:' }).Count }
    Add-Result 'Network routes' 'INFO' ("{0} route(s) offered to this client" -f $routeCount)
} else {
    Add-Result 'Networks list' 'INFO' 'Could not read the client network list (older client or daemon not running)'
}

# --- 8. Optional internal target --------------------------------------------
if ($TestHost) {
    Section ("Internal Target: {0}" -f $TestHost)
    $resolved = $TestHost
    if ($TestHost -notmatch '^\d+\.\d+\.\d+\.\d+$') {
        $r = Resolve-DnsName -Name $TestHost -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress } | Select-Object -First 1
        if ($r) { $resolved = $r.IPAddress; Add-Result 'Internal DNS' 'PASS' ("{0} -> {1}" -f $TestHost, $resolved) }
        else { Add-Result 'Internal DNS' 'FAIL' ("Cannot resolve {0} - NetBird DNS not answering?" -f $TestHost) }
    }
    $p = Test-Connection -ComputerName $resolved -Count 3 -ErrorAction SilentlyContinue
    if ($p) {
        $avg = [int](($p | Measure-Object -Property ResponseTime -Average).Average)
        Add-Result 'Tunnel ping' 'PASS' ("avg {0} ms" -f $avg)
        # MTU probe: DF-flag pings at descending sizes; the first that passes = usable payload.
        $mtuOk = ''
        foreach ($size in 1372, 1300, 1200, 1000) {
            $out = & ping.exe -n 1 -w 3000 -f -l $size $resolved 2>$null | Out-String
            if ($out -match 'TTL=') { $mtuOk = $size; break }
        }
        if ($mtuOk -eq 1372) { Add-Result 'MTU probe' 'PASS' 'Full WireGuard payload (1372) passes' }
        elseif ($mtuOk) { Add-Result 'MTU probe' 'WARN' ("Only {0}-byte packets pass - MTU/fragmentation issue on the path" -f $mtuOk) }
        else { Add-Result 'MTU probe' 'WARN' 'Even 1000-byte DF packets fail - possible MTU black hole' }
    } else {
        Add-Result 'Tunnel ping' 'FAIL' ("{0} does not answer over the tunnel - check the peer/policy/routing peer" -f $resolved)
    }
}

# --- 9. Firewall ------------------------------------------------------------
Section 'Windows Firewall'
$profiles = Get-NetFirewallProfile -ErrorAction SilentlyContinue
if ($profiles) {
    $active = ($profiles | Where-Object { $_.Enabled } | ForEach-Object { $_.Name }) -join ', '
    Add-Result 'Firewall profiles enabled' 'INFO' ($(if ($active) { $active } else { 'none' }))
    $blockOut = $profiles | Where-Object { $_.Enabled -and $_.DefaultOutboundAction -eq 'Block' }
    if ($blockOut) { Add-Result 'Outbound default' 'WARN' ("Profile(s) {0} BLOCK outbound by default - NetBird needs an allow rule" -f (($blockOut | ForEach-Object { $_.Name }) -join ', ')) }
    else { Add-Result 'Outbound default' 'PASS' 'Outbound allowed by default' }
}

# Per docs.netbird.io/about-netbird/ports-and-firewalls ("Host-Based Firewall"), the
# client manages its own Windows Firewall rules automatically. Verify they exist and
# that nothing overrides them with a Block - a restrictive GPO stripping/blocking them
# silently breaks connectivity even when the service itself is healthy.
# IMPORTANT: on hardened systems, enumerating rules requires ELEVATION - a non-admin
# session gets an empty list (silently), which must not be mistaken for "no rules".
$allRules = @(Get-NetFirewallRule -ErrorAction SilentlyContinue)
if (-not $allRules.Count) {
    Add-Result 'NetBird firewall rules' 'INFO' 'Cannot read firewall rules from this session - re-run as Administrator to check them'
} else {
    $nbRules = @($allRules | Where-Object { $_.DisplayName -match 'netbird' })
    if (-not $nbRules.Count) {
        # Rules may carry a generic name - match by the program path instead.
        $nbFilters = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -match 'netbird' })
        if ($nbFilters.Count) { $nbRules = @($nbFilters | Get-NetFirewallRule -ErrorAction SilentlyContinue) }
    }
    if ($nbRules.Count) {
        $blockRules = @($nbRules | Where-Object { $_.Action -eq 'Block' -and "$($_.Enabled)" -eq 'True' })
        $allowRules = @($nbRules | Where-Object { $_.Action -eq 'Allow' -and "$($_.Enabled)" -eq 'True' })
        if ($blockRules.Count) {
            Add-Result 'NetBird firewall rules' 'FAIL' ("{0} enabled BLOCK rule(s) target NetBird ({1}) - remove them" -f $blockRules.Count, (($blockRules | Select-Object -First 3 | ForEach-Object { $_.DisplayName }) -join ', '))
        } elseif ($allowRules.Count) {
            Add-Result 'NetBird firewall rules' 'PASS' ("{0} enabled allow rule(s) present (NetBird manages these automatically)" -f $allowRules.Count)
        } else {
            Add-Result 'NetBird firewall rules' 'WARN' ("{0} NetBird rule(s) found but none is an enabled Allow rule - a policy may have disabled them" -f $nbRules.Count)
        }
    } else {
        Add-Result 'NetBird firewall rules' 'WARN' ("No NetBird firewall rules found (checked {0} rules) - the client normally creates them automatically; a restrictive policy (GPO) may be stripping them" -f $allRules.Count)
    }
}

# --- 10. Client log ---------------------------------------------------------
Section 'Client Log'
$logPath = ''
foreach ($cand in @(
        (Join-Path $env:ProgramData 'netbird\client.log'),
        (Join-Path $env:ProgramData 'Netbird\client.log'),
        (Join-Path $env:LOCALAPPDATA 'netbird\client.log'),
        'C:\Windows\System32\config\systemprofile\AppData\Local\netbird\client.log')) {
    if (Test-Path $cand) { $logPath = $cand; break }
}
$logTail = ''
if ($logPath) {
    $logTail = (Get-Content $logPath -Tail 300 -ErrorAction SilentlyContinue | Out-String)
    $recentErrors = @($logTail -split "`n" | Where-Object { $_ -match '\bERRO|\bERROR' } | Select-Object -Last 5)
    if ($recentErrors.Count) {
        # Log noise is for the ADMIN reading the report file, not for the user - it is
        # captured there in full, but on screen it is INFO only and NEVER a warning
        # (recurring benign errors used to make every single run yell WARN).
        $unique = @($recentErrors | ForEach-Object { ($_ -replace '^\s*\S+\s+', '').Trim() } | Select-Object -Unique)
        if ($unique.Count -eq 1) {
            $msg = $unique[0]; if ($msg.Length -gt 150) { $msg = $msg.Substring(0, 150) + '...' }
            Add-Result 'Client log' 'INFO' ("{0} line(s) of one recurring error captured into the report for your admin: {1}" -f $recentErrors.Count, $msg)
        } else {
            Add-Result 'Client log' 'INFO' ("{0} error line(s) ({1} distinct) captured into the report for your admin" -f $recentErrors.Count, $unique.Count)
        }
    } else {
        Add-Result 'Client log' 'PASS' ("No errors in the last 300 lines of {0}" -f $logPath)
    }
} else {
    Add-Result 'Client log' 'INFO' 'client.log not readable from this session - re-run as Administrator, or collect a full bundle with: netbird debug bundle'
}

# --- Summary + report file --------------------------------------------------
Section 'Summary'
$fails = @($script:Results | Where-Object { $_.Status -eq 'FAIL' })
$warns = @($script:Results | Where-Object { $_.Status -eq 'WARN' })

# Plain-language verdict (mirrors the web Troubleshoot page): ONE conclusion a
# non-technical user can act on. First matching rule wins - most fundamental first.
$failNames = @($fails | ForEach-Object { $_.Check })
$verdict = ''; $todo = ''
if ($failNames -contains 'NetBird installed') {
    $verdict = 'NetBird is not installed on this machine.'
    $todo = 'Install the NetBird client, then run this script again.'
} elseif ($failNames -contains 'NetBird service') {
    $verdict = 'The NetBird service is not running.'
    $todo = 'Start it (net start netbird) or reboot; if it will not start, reinstall the client.'
} elseif ($failNames -contains 'Login state' -or $failNames -contains 'NetBird IP') {
    $verdict = 'This device is signed out of NetBird.'
    $todo = 'Run: netbird up - and sign in when the browser opens. Everything should come back after that.'
} elseif ($failNames -contains 'Public DNS resolution' -or $failNames -contains 'Outbound HTTPS (443)') {
    $verdict = 'This network has no working internet access.'
    $todo = 'Fix the internet connection first - NetBird cannot work without it.'
} elseif (@($failNames | Where-Object { $_ -like 'Management server*' -or $_ -like 'Signal server*' }).Count) {
    $verdict = 'The network you are on is blocking NetBird''s servers.'
    $todo = 'A firewall or proxy here blocks port 443 to NetBird - try a different network or contact IT.'
} elseif ($failNames -contains 'Management connection' -or $failNames -contains 'Signal connection') {
    $verdict = 'The NetBird client cannot reach the NetBird servers.'
    $todo = 'Restart the client (net stop netbird, then net start netbird); if it persists, contact your admin.'
} elseif ($failNames -contains 'Tunnel adapter' -or $failNames -contains 'Tunnel IP') {
    $verdict = 'The NetBird network adapter is not working.'
    $todo = 'Restart the NetBird service; if the adapter stays down, reinstall the client.'
} elseif ($failNames -contains 'NetBird firewall rules') {
    $verdict = 'Windows Firewall is blocking NetBird.'
    $todo = 'Remove the blocking rule(s) listed above (IT may need to adjust the policy).'
} elseif ($failNames -contains 'Internal DNS' -or $failNames -contains 'Tunnel ping') {
    $verdict = 'NetBird itself is healthy, but the internal target does not answer.'
    $todo = 'Likely an access-rights issue or the target itself - use the Troubleshoot page in NetBird Control, or contact your admin.'
} elseif ($fails.Count) {
    $verdict = 'Something is wrong - see the failed check(s) below.'
    $todo = 'Share the report file with your admin.'
} elseif ($warns.Count -eq 1 -and $warns[0].Check -like 'STUN*') {
    $verdict = 'Everything works - but this network may slow things down.'
    $todo = 'UDP looks blocked here, so connections fall back to relay (slower, but functional).'
} elseif ($warns.Count) {
    $verdict = 'Everything works - with warnings (below).'
    $todo = 'Nothing is broken; review the warnings if something feels off.'
} else {
    $verdict = 'Everything looks good.'
    $todo = 'If a specific resource still fails, re-run with -TestHost <internal address>, or use the Troubleshoot page in NetBird Control.'
}
$vColor = if ($fails.Count) { 'Red' } elseif ($warns.Count) { 'Yellow' } else { 'Green' }
Write-Host ''
Write-Host ("  VERDICT: {0}" -f $verdict) -ForegroundColor $vColor
Write-Host ("  WHAT TO DO: {0}" -f $todo) -ForegroundColor Gray
Write-Host ''

if ($fails.Count) { Write-Host ("  {0} FAILED check(s):" -f $fails.Count) -ForegroundColor Red; $fails | ForEach-Object { Write-Host ("    * {0} - {1}" -f $_.Check, $_.Detail) -ForegroundColor Red } }
if ($warns.Count) { Write-Host ("  {0} warning(s):" -f $warns.Count) -ForegroundColor Yellow; $warns | ForEach-Object { Write-Host ("    * {0} - {1}" -f $_.Check, $_.Detail) -ForegroundColor Yellow } }

$report = @()
$report += "NetBird Connectivity Diagnostics - $(Get-Date)"
$report += "Computer: $env:COMPUTERNAME  User: $env:USERNAME"
$report += ("VERDICT: {0}" -f $verdict)
$report += ("WHAT TO DO: {0}" -f $todo)
$report += ''
$report += ($script:Results | Format-Table -AutoSize | Out-String)
$report += '----- netbird status -d -----'
$report += $statusDetail
# Only the exit-node entries go into the report - the full route list can run to
# hundreds of entries and drowns the interesting parts (run "netbird networks ls" for it).
$report += '----- netbird networks ls (exit-node entries only) -----'
$report += ($exitBlocks -join ([Environment]::NewLine + [Environment]::NewLine))
$report += '----- client.log (last 300 lines) -----'
$report += $logTail
$report -join "`r`n" | Out-File -FilePath $reportPath -Encoding utf8
Write-Host ""
Write-Host ("Full report saved to: {0}" -f $reportPath) -ForegroundColor Cyan
Write-Host "Attach this file when opening a support ticket." -ForegroundColor DarkGray

# A self-elevated run opened its own window - keep it on screen until the user is done.
if ($Elevated) {
    Write-Host ""
    Read-Host 'Done - press Enter to close this window' | Out-Null
}
