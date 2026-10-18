# storage-audit read-only collector (Windows PowerShell 5.1+)
# Writes JSON to %TEMP%. stdout is the output path. Does not delete or write the target tree.
param(
    [string]$Target = '',
    [ValidateSet('quick', 'project', 'machine')]
    [string]$Mode = 'project',
    [string]$KeepRoot = '',
    [int]$MaxArchives = 80,
    [int]$MaxCaches = 200,
    [int]$MaxProjects = 80,
    [int]$TimeoutSec = 900
)

$ErrorActionPreference = 'Continue'
$script:Warnings = New-Object System.Collections.Generic.List[string]
$script:Fso = $null
try {
    $script:Fso = New-Object -ComObject Scripting.FileSystemObject
} catch {
    $script:Warnings.Add('fso-unavailable')
}

function Warn([string]$Message) {
    $script:Warnings.Add($Message)
}

function Note([string]$Message) {
    [Console]::Error.WriteLine("storage-audit: $Message")
}

$script:Deadline = (Get-Date).AddSeconds($TimeoutSec)
$script:TimedOut = $false

function Test-TimedOut {
    if ($script:TimedOut) { return $true }
    if ((Get-Date) -gt $script:Deadline) {
        $script:TimedOut = $true
        $script:partial = $true
        Warn 'timeout'
        Note "timeout after ${TimeoutSec}s; remaining sizes left null"
        return $true
    }
    return $false
}

function Decode-UnityString([string]$Value) {
    if ([string]::IsNullOrEmpty($Value)) { return $Value }
    return [regex]::Replace($Value, '\\u([0-9A-Fa-f]{4})', {
        param($m)
        [char][Convert]::ToInt32($m.Groups[1].Value, 16)
    })
}

function Test-Reparse($Item) {
    if ($null -eq $Item) { return $false }
    try {
        return [bool]($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    } catch {
        return $false
    }
}

# OneDrive 等云占位：读内容会触发下载，审计只报元数据
function Test-CloudPlaceholder($Item) {
    if ($null -eq $Item) { return $false }
    try {
        return [bool]($Item.Attributes -band 0x400000)  # FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
    } catch {
        return $false
    }
}

function Test-ShallowReparse([string]$Path, [int]$Depth = 2) {
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@($Path, 0))
    while ($queue.Count -gt 0) {
        $pair = $queue.Dequeue()
        $dir = $pair[0]
        $d = $pair[1]
        if ($d -ge $Depth) { continue }
        foreach ($c in @(Get-ChildItem -LiteralPath $dir -Directory -Force -ErrorAction SilentlyContinue)) {
            if (Test-Reparse $c) { return $true }
            if (($d + 1) -lt $Depth) { $queue.Enqueue(@($c.FullName, ($d + 1))) }
        }
    }
    return $false
}

function Measure-DirBytesNoJunction([string]$Path) {
    $sum = [int64]0
    $stack = New-Object System.Collections.Stack
    $stack.Push($Path)
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        foreach ($f in @(Get-ChildItem -LiteralPath $dir -File -Force -ErrorAction SilentlyContinue)) {
            if (-not (Test-Reparse $f)) { $sum += [int64]$f.Length }
        }
        foreach ($d in @(Get-ChildItem -LiteralPath $dir -Directory -Force -ErrorAction SilentlyContinue)) {
            if (-not (Test-Reparse $d)) { $stack.Push($d.FullName) }
        }
    }
    return $sum
}

function Measure-PathBytes([string]$Path) {
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if (Test-Reparse $item) {
            Warn "junction-skipped:$Path"
            return $null
        }
        if (-not $item.PSIsContainer) { return [int64]$item.Length }
        if (Test-ShallowReparse $item.FullName 2) {
            Warn "junction-walk:$Path"
            return (Measure-DirBytesNoJunction $item.FullName)
        }
        if ($null -ne $script:Fso) {
            return [int64]$script:Fso.GetFolder($item.FullName).Size
        }
        return (Measure-DirBytesNoJunction $item.FullName)
    } catch {
        Warn "size-failed:$Path"
        return $null
    }
}

function Read-LineMatch([string]$File, [string]$Pattern, [int]$MaxLines = 80) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $null }
    try {
        $m = Get-Content -LiteralPath $File -TotalCount $MaxLines -ErrorAction SilentlyContinue |
            Select-String -Pattern $Pattern |
            Select-Object -First 1
        if ($null -eq $m) { return $null }
        if ($m.Matches.Count -gt 0 -and $m.Matches[0].Groups.Count -gt 1) {
            return $m.Matches[0].Groups[1].Value.Trim()
        }
    } catch {
        Warn "read-failed:$File"
    }
    return $null
}

function Read-ZipEntryHead($Entry, [int]$MaxBytes = 1048576) {
    $stream = $null
    try {
        $stream = $Entry.Open()
        $buf = New-Object byte[] $MaxBytes
        $read = $stream.Read($buf, 0, $MaxBytes)
        return [System.Text.Encoding]::UTF8.GetString($buf, 0, $read)
    } catch {
        return $null
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

function Find-SevenZip {
    $cmd = Get-Command 7z -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @(
            "${env:ProgramFiles}\7-Zip\7z.exe",
            "${env:ProgramFiles(x86)}\7-Zip\7z.exe"
        )) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

$StrictCacheNames = @(
    'Library', 'Temp', 'obj', 'Logs', 'MemoryCaptures', 'Recordings',
    'Intermediate', 'DerivedDataCache',
    '.godot', '.import',
    'node_modules', '.next', '.nuxt', '.turbo', '.parcel-cache', '.cache', 'coverage',
    'bin', '.vs', 'TestResults',
    'target', '.gradle',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
    'cmake-build-debug', 'cmake-build-release', 'DerivedData'
)

function Test-HasFilePattern([string]$Dir, [string]$Filter) {
    $hit = Get-ChildItem -LiteralPath $Dir -File -Filter $Filter -ErrorAction SilentlyContinue | Select-Object -First 1
    return [bool]$hit
}

function Get-CacheEco([string]$Parent, [string]$Name) {
    $unity = Test-Path -LiteralPath (Join-Path $Parent 'ProjectSettings')
    $dotnet = (Test-HasFilePattern $Parent '*.sln') -or (Test-HasFilePattern $Parent '*.csproj')
    $node = Test-Path -LiteralPath (Join-Path $Parent 'package.json')
    $rust = Test-Path -LiteralPath (Join-Path $Parent 'Cargo.toml')
    $java = (Test-Path -LiteralPath (Join-Path $Parent 'pom.xml')) -or
        (Test-Path -LiteralPath (Join-Path $Parent 'build.gradle')) -or
        (Test-Path -LiteralPath (Join-Path $Parent 'build.gradle.kts')) -or
        (Test-Path -LiteralPath (Join-Path $Parent 'settings.gradle'))
    $unreal = Test-HasFilePattern $Parent '*.uproject'
    $godot = Test-Path -LiteralPath (Join-Path $Parent 'project.godot')
    switch ($Name) {
        'Library' { if ($unity) { return 'unity' } }
        'Temp' { if ($unity) { return 'unity' } }
        'Logs' { if ($unity) { return 'unity' } }
        'MemoryCaptures' { if ($unity) { return 'unity' } }
        'Recordings' { if ($unity) { return 'unity' } }
        'obj' { if ($unity) { return 'unity' }; if ($dotnet) { return 'dotnet' } }
        'bin' { if ($unity -or $dotnet) { return 'dotnet' } }
        '.vs' { if ($unity -or $dotnet) { return 'dotnet' } }
        'TestResults' { if ($dotnet) { return 'dotnet' } }
        'node_modules' { if ($node) { return 'node' } }
        '.next' { if ($node) { return 'node' } }
        '.nuxt' { if ($node) { return 'node' } }
        '.turbo' { if ($node) { return 'node' } }
        '.parcel-cache' { if ($node) { return 'node' } }
        '.cache' { if ($node) { return 'node' } }
        'coverage' { if ($node) { return 'node' } }
        'target' { if ($rust) { return 'rust' }; if ($java) { return 'java' } }
        '.gradle' { if ($java) { return 'java' } }
        'Intermediate' { if ($unreal) { return 'unreal' } }
        'DerivedDataCache' { if ($unreal) { return 'unreal' } }
        '.godot' { if ($godot) { return 'godot' } }
        '.import' { if ($godot) { return 'godot' } }
        'DerivedData' {
            $xc = Get-ChildItem -LiteralPath $Parent -Force -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like '*.xcodeproj' -or $_.Name -like '*.xcworkspace' } |
                Select-Object -First 1
            if ($xc) { return 'xcode' }
        }
        '__pycache__' { return 'python' }
        '.pytest_cache' { return 'python' }
        '.mypy_cache' { return 'python' }
        '.ruff_cache' { return 'python' }
        'cmake-build-debug' { return 'cmake' }
        'cmake-build-release' { return 'cmake' }
    }
    return $null
}

function Get-CachePaths([string]$Root) {
    $found = New-Object System.Collections.Generic.List[object]
    $seen = @{}
    function Consider([string]$Path, [string]$Name) {
        if (-not (Test-Path -LiteralPath $Path)) { return }
        $parent = Split-Path -Parent $Path
        $eco = Get-CacheEco $parent $Name
        if (-not $eco) { return }
        $key = $Path.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { return }
        $seen[$key] = $true
        [void]$found.Add(@{ path = $Path; pattern = $Name; eco = $eco })
    }
    function Consider-CacheDirTag([string]$Dir) {
        # ncdu 惯例：目录内含 CACHEDIR.TAG 即自声明为缓存
        if (Test-Path -LiteralPath (Join-Path $Dir 'CACHEDIR.TAG') -PathType Leaf) {
            $key = $Dir.ToLowerInvariant()
            if ($seen.ContainsKey($key)) { return }
            $seen[$key] = $true
            [void]$found.Add(@{ path = $Dir; pattern = 'CACHEDIR.TAG'; eco = 'cachedirtag' })
        }
    }
    foreach ($n in $StrictCacheNames) { Consider (Join-Path $Root $n) $n }
    Get-ChildItem -LiteralPath $Root -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
        if (Test-Reparse $_) { return }
        if (Test-SkipDescend $_.Name) { return }  # 已按名 Consider，不再深入
        Consider-CacheDirTag $_.FullName
        foreach ($n in $StrictCacheNames) { Consider (Join-Path $_.FullName $n) $n }
        Get-ChildItem -LiteralPath $_.FullName -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
            if (Test-Reparse $_) { return }
            if (Test-SkipDescend $_.Name) { return }
            Consider-CacheDirTag $_.FullName
            foreach ($n in $StrictCacheNames) { Consider (Join-Path $_.FullName $n) $n }
        }
    }
    return $found
}

$SkipDescendNames = @('.git') + $StrictCacheNames

function Test-SkipDescend([string]$Leaf) {
    return $SkipDescendNames -contains $Leaf
}

function Get-ArchivePaths([string]$Root) {
    $found = New-Object System.Collections.Generic.List[string]
    $filters = '*.zip', '*.7z', '*.rar'
    function Collect-Here([string]$Dir) {
        foreach ($f in $filters) {
            Get-ChildItem -LiteralPath $Dir -File -Filter $f -Force -ErrorAction SilentlyContinue |
                ForEach-Object { $found.Add($_.FullName) }
        }
    }
    Collect-Here $Root
    Get-ChildItem -LiteralPath $Root -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
        if ((Test-Reparse $_) -or (Test-SkipDescend $_.Name)) { return }
        Collect-Here $_.FullName
        Get-ChildItem -LiteralPath $_.FullName -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
            if ((Test-Reparse $_) -or (Test-SkipDescend $_.Name)) { return }
            Collect-Here $_.FullName
        }
    }
    $uniq = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    foreach ($p in $found) {
        $k = $p.ToLowerInvariant()
        if ($seen.ContainsKey($k)) { continue }
        $seen[$k] = $true
        [void]$uniq.Add($p)
    }
    return $uniq
}

function Get-ZipInfo([string]$Path) {
    $info = @{
        path               = $Path
        format             = ([System.IO.Path]::GetExtension($Path).TrimStart('.').ToLower())
        bytes              = $null
        entryCount         = $null
        uncompressedBytes  = $null
        topEntries         = @()
        identityHints      = @()
        listingPreview     = $null
    }
    try { $info.bytes = [int64](Get-Item -LiteralPath $Path).Length } catch { }
    try {
        $item = Get-Item -LiteralPath $Path -Force
        if (Test-CloudPlaceholder $item) {
            $info.cloud = $true
            Warn "cloud-placeholder:$Path"
            return $info  # 云占位不读内容，避免触发下载
        }
    } catch { }
    if ($info.format -ne 'zip') { return $info }
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
        $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
        try {
            $info.entryCount = $zip.Entries.Count
            $sum = [int64]0
            $tops = New-Object System.Collections.Generic.HashSet[string]
            $hints = New-Object System.Collections.Generic.List[string]
            foreach ($e in $zip.Entries) {
                $sum += $e.Length
                $fn = $e.FullName -replace '\\', '/'
                $first = ($fn -split '/')[0]
                if ($first) { [void]$tops.Add($first) }
                if ($fn -match '(^|/)\.idea/\.idea\.([^/]+)') {
                    $hints.Add(('idea:' + $Matches[2]))
                }
                $tag = $null
                if ($fn -match 'ProjectSettings/ProjectVersion\.txt$') { $tag = 'editorVersion' }
                elseif ($fn -match 'ProjectSettings/ProjectSettings\.asset$') { $tag = 'productName' }
                elseif ($fn -match '(^|/)package\.json$') { $tag = 'package' }
                if ($tag) {
                    $text = Read-ZipEntryHead $e
                    if ($tag -eq 'editorVersion' -and $text -match 'm_EditorVersion:\s*(\S+)') {
                        $hints.Add(('editorVersion:' + $Matches[1]))
                    } elseif ($tag -eq 'productName' -and $text -match 'productName:\s*(.+)') {
                        $hints.Add(('productName:' + (Decode-UnityString $Matches[1].Trim())))
                    } elseif ($tag -eq 'package' -and $text -match '"name"\s*:\s*"([^"]+)"') {
                        $hints.Add(('package:' + $Matches[1]))
                    }
                }
            }
            $info.uncompressedBytes = $sum
            $info.topEntries = @($tops)
            $info.identityHints = @($hints | Select-Object -Unique)
        } finally {
            $zip.Dispose()
        }
    } catch {
        Warn "zip-list-failed:$Path"
    }
    return $info
}

function Add-SevenZipInfo($Info, [string]$SevenZip) {
    if (-not $SevenZip) { return }
    if ($Info.cloud) { return }
    if ($Info.format -ne '7z' -and $Info.format -ne 'rar') { return }
    try {
        $raw = & $SevenZip @('l', '-slt', $Info.path) 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $raw) { throw "7z-exit-$LASTEXITCODE" }
        $count = 0
        $sum = [int64]0
        $tops = New-Object System.Collections.Generic.HashSet[string]
        $hints = New-Object System.Collections.Generic.List[string]
        $preview = New-Object System.Collections.Generic.List[string]
        $cur = $null
        foreach ($line in $raw) {
            if ($line -match '^Path = (.+)$') {
                $cur = $Matches[1] -replace '\\', '/'
                if ($preview.Count -lt 20) { $preview.Add($cur) }
                if ($cur -match '(^|/)\.idea/\.idea\.([^/]+)') {
                    $hints.Add(('idea:' + $Matches[2]))
                }
            } elseif ($cur -and $line -match '^Size = (\d+)$') {
                $count++
                $sum += [int64]$Matches[1]
                $first = ($cur -split '/')[0]
                if ($first) { [void]$tops.Add($first) }
            }
        }
        $Info.entryCount = $count
        $Info.uncompressedBytes = $sum
        $Info.topEntries = @($tops)
        $Info.identityHints = @($hints | Select-Object -Unique)
        $Info.listingPreview = ($preview -join "`n")
    } catch {
        Warn "7z-list-failed:$($Info.path)"
    }
}

function Get-ProjectInfo([string]$Dir) {
    $info = @{
        path           = $Dir
        eco            = $null
        productName    = $null
        editorVersion  = $null
        ideaName       = $null
        packageName    = $null
        packageVersion = $null
        gitRemote      = $null
        hasGit         = $false
        uproject       = $null
        godotName      = $null
    }
    $ps = Join-Path $Dir 'ProjectSettings\ProjectSettings.asset'
    $pv = Join-Path $Dir 'ProjectSettings\ProjectVersion.txt'
    if ((Test-Path -LiteralPath $ps) -or (Test-Path -LiteralPath $pv)) {
        $info.eco = 'unity'
        $raw = Read-LineMatch $ps 'productName:\s*(.+)$' 120
        $info.productName = Decode-UnityString $raw
        $info.editorVersion = Read-LineMatch $pv 'm_EditorVersion:\s*(\S+)' 20
    }
    $pkg = Join-Path $Dir 'package.json'
    if (Test-Path -LiteralPath $pkg -PathType Leaf) {
        if (-not $info.eco) { $info.eco = 'node' }
        $info.packageName = Read-LineMatch $pkg '"name"\s*:\s*"([^"]+)"' 40
        $info.packageVersion = Read-LineMatch $pkg '"version"\s*:\s*"([^"]+)"' 40
    }
    $cargo = Join-Path $Dir 'Cargo.toml'
    if (Test-Path -LiteralPath $cargo) {
        if (-not $info.eco) { $info.eco = 'rust' }
        $info.packageName = Read-LineMatch $cargo '^name\s*=\s*"([^"]+)"' 30
    }
    $py = Join-Path $Dir 'pyproject.toml'
    if (Test-Path -LiteralPath $py) {
        if (-not $info.eco) { $info.eco = 'python' }
        $info.packageName = Read-LineMatch $py '^name\s*=\s*"([^"]+)"' 40
    }
    $uproject = Get-ChildItem -LiteralPath $Dir -File -Filter '*.uproject' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($uproject) {
        if (-not $info.eco) { $info.eco = 'unreal' }
        $info.uproject = $uproject.Name
    }
    $godot = Join-Path $Dir 'project.godot'
    if (Test-Path -LiteralPath $godot) {
        if (-not $info.eco) { $info.eco = 'godot' }
        $info.godotName = Read-LineMatch $godot 'config/name\s*=\s*"([^"]+)"' 80
    }
    $sln = Get-ChildItem -LiteralPath $Dir -File -Filter '*.sln' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($sln -and -not $info.eco) { $info.eco = 'dotnet' }
    $idea = Join-Path $Dir '.idea'
    if (Test-Path -LiteralPath $idea -PathType Container) {
        $ideaDir = Get-ChildItem -LiteralPath $idea -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like '.idea.*' } | Select-Object -First 1
        if ($ideaDir) { $info.ideaName = $ideaDir.Name }
    }
    $gitPath = Join-Path $Dir '.git'
    if (Test-Path -LiteralPath $gitPath) {
        $info.hasGit = $true
        $cfg = Join-Path $Dir '.git\config'
        if (Test-Path -LiteralPath $cfg -PathType Leaf) {
            $info.gitRemote = Read-LineMatch $cfg '^\s*url\s*=\s*(.+)$' 80
        }
    }
    $useful = $info.eco -or $info.ideaName -or $info.hasGit -or $info.packageName
    if (-not $useful) { return $null }
    return $info
}

function Get-GitRoots([string]$Root) {
    $found = New-Object System.Collections.Generic.List[string]
    function Probe([string]$Dir) {
        if (Test-Path -LiteralPath (Join-Path $Dir '.git')) { $found.Add($Dir) }
    }
    Probe $Root
    Get-ChildItem -LiteralPath $Root -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
        if ((Test-Reparse $_) -or (Test-SkipDescend $_.Name)) { return }
        Probe $_.FullName
        Get-ChildItem -LiteralPath $_.FullName -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
            if ((Test-Reparse $_) -or (Test-SkipDescend $_.Name)) { return }
            Probe $_.FullName
            Get-ChildItem -LiteralPath $_.FullName -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
                if ((Test-Reparse $_) -or (Test-SkipDescend $_.Name)) { return }
                Probe $_.FullName
            }
        }
    }
    return $found
}

function Get-Noise([string]$Root) {
    $noise = New-Object System.Collections.Generic.List[object]
    # ASCII source: also match CJK 备份 / 新建文件夹 / 副本 via \uXXXX
    $namePat = 'backup|^old$|_old|Copy$|\u5907\u4EFD|\u65B0\u5EFA\u6587\u4EF6\u5939|\u526F\u672C'
    function Inspect([string]$Dir, [string]$Name) {
        $leaf = Split-Path $Dir -Leaf
        $nested = Join-Path $Dir $leaf
        if (Test-Path -LiteralPath $nested -PathType Container) {
            $noise.Add(@{ path = $nested; reason = 'nested-same' })
        }
        try {
            $children = @(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue)
            if ($children.Count -eq 0 -and ($StrictCacheNames -notcontains $leaf)) {
                $noise.Add(@{ path = $Dir; reason = 'empty' })
            }
        } catch { }
        if ($Name -match $namePat) {
            $noise.Add(@{ path = $Dir; reason = 'backup-name' })
        }
    }
    Inspect $Root (Split-Path $Root -Leaf)
    Get-ChildItem -LiteralPath $Root -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
        if ((Test-Reparse $_) -or (Test-SkipDescend $_.Name)) { return }
        Inspect $_.FullName $_.Name
        Get-ChildItem -LiteralPath $_.FullName -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
            if ((Test-Reparse $_) -or (Test-SkipDescend $_.Name)) { return }
            Inspect $_.FullName $_.Name
        }
    }
    return , @($noise.ToArray())
}

function Get-DiskInfo([string]$PathForRoot) {
    $result = @{ root = $null; freeBytes = $null; usedBytes = $null }
    try {
        $full = $PathForRoot
        if (Test-Path -LiteralPath $PathForRoot) {
            $full = (Get-Item -LiteralPath $PathForRoot).FullName
        }
        $root = [System.IO.Path]::GetPathRoot($full)
        $letter = $root.Substring(0, 1)
        $d = Get-PSDrive -Name $letter -ErrorAction Stop
        $result.root = $d.Root
        $result.freeBytes = [int64]$d.Free
        $result.usedBytes = [int64]$d.Used
    } catch {
        Warn 'disk-info-failed'
    }
    return $result
}

function New-Hotspot([string]$Name, [string]$Path, [string]$Tier, [string]$Kind) {
    return @{
        name  = $Name
        path  = $Path
        tier  = $Tier
        kind  = $Kind
        bytes = $null
    }
}

function Get-MachineHotspots {
    $list = New-Object System.Collections.Generic.List[object]
    $green = @(
        @{ n = 'npm-cache'; p = "$env:LOCALAPPDATA\npm-cache"; k = 'pkg-cache' },
        @{ n = 'yarn-cache'; p = "$env:LOCALAPPDATA\Yarn\Cache"; k = 'pkg-cache' },
        @{ n = 'pnpm-store'; p = "$env:LOCALAPPDATA\pnpm\store"; k = 'pkg-cache' },
        @{ n = 'pnpm-store-alt'; p = "$env:LOCALAPPDATA\pnpm-store"; k = 'pkg-cache' },
        @{ n = 'nuget'; p = "$env:USERPROFILE\.nuget\packages"; k = 'pkg-cache' },
        @{ n = 'nuget-v3'; p = "$env:LOCALAPPDATA\NuGet\v3-cache"; k = 'pkg-cache' },
        @{ n = 'bun-cache'; p = "$env:LOCALAPPDATA\bun"; k = 'pkg-cache' },
        @{ n = 'yarn-berry'; p = "$env:LOCALAPPDATA\Yarn\Berry\Cache"; k = 'pkg-cache' },
        @{ n = 'pip-cache'; p = "$env:LOCALAPPDATA\pip\Cache"; k = 'pkg-cache' },
        @{ n = 'pip-cache-alt'; p = "$env:LOCALAPPDATA\pip\cache"; k = 'pkg-cache' },
        @{ n = 'cargo-registry'; p = "$env:USERPROFILE\.cargo\registry"; k = 'pkg-cache' },
        @{ n = 'cargo-git'; p = "$env:USERPROFILE\.cargo\git"; k = 'pkg-cache' },
        @{ n = 'go-mod'; p = "$env:USERPROFILE\go\pkg\mod"; k = 'pkg-cache' },
        @{ n = 'gradle-caches'; p = "$env:USERPROFILE\.gradle\caches"; k = 'pkg-cache' },
        @{ n = 'maven-m2'; p = "$env:USERPROFILE\.m2\repository"; k = 'pkg-cache' },
        @{ n = 'unity-upm'; p = "$env:LOCALAPPDATA\Unity\cache"; k = 'pkg-cache' },
        @{ n = 'temp'; p = $env:TEMP; k = 'temp' },
        @{ n = 'localapp-temp'; p = "$env:LOCALAPPDATA\Temp"; k = 'temp' },
        @{ n = 'cursor-cache'; p = "$env:APPDATA\Cursor\Cache"; k = 'editor-cache' },
        @{ n = 'cursor-cacheddata'; p = "$env:APPDATA\Cursor\CachedData"; k = 'editor-cache' },
        @{ n = 'claude-cache'; p = "$env:APPDATA\Claude\Cache"; k = 'editor-cache' },
        @{ n = 'vscode-cache'; p = "$env:APPDATA\Code\Cache"; k = 'editor-cache' }
    )
    $yellow = @(
        @{ n = 'ollama'; p = "$env:USERPROFILE\.ollama"; k = 'model' },
        @{ n = 'huggingface'; p = "$env:USERPROFILE\.cache\huggingface"; k = 'model' },
        @{ n = 'torch'; p = "$env:USERPROFILE\.cache\torch"; k = 'model' },
        @{ n = 'lm-studio'; p = "$env:USERPROFILE\.cache\lm-studio"; k = 'model' },
        @{ n = 'rustup'; p = "$env:USERPROFILE\.rustup"; k = 'toolchain' },
        @{ n = 'continue'; p = "$env:USERPROFILE\.continue"; k = 'agent-data' },
        @{ n = 'claude-cli'; p = "$env:USERPROFILE\.claude"; k = 'agent-data' },
        @{ n = 'cursor-user'; p = "$env:APPDATA\Cursor\User"; k = 'editor-user' },
        @{ n = 'npm-global'; p = "$env:APPDATA\npm"; k = 'pkg-global' }
    )
    foreach ($h in $green) {
        if (Test-Path -LiteralPath $h.p) { $list.Add((New-Hotspot $h.n $h.p 'green' $h.k)) }
    }
    foreach ($h in $yellow) {
        if (Test-Path -LiteralPath $h.p) { $list.Add((New-Hotspot $h.n $h.p 'yellow' $h.k)) }
    }
    $vhdx = New-Object System.Collections.Generic.List[string]
    foreach ($p in @(
            "$env:LOCALAPPDATA\Docker\wsl\disk\docker_data.vhdx",
            "$env:LOCALAPPDATA\Docker\wsl\data\ext4.vhdx",
            "$env:LOCALAPPDATA\Docker\wsl\main\ext4.vhdx"
        )) {
        if (Test-Path -LiteralPath $p) { $vhdx.Add($p) }
    }
    $pkgRoot = Join-Path $env:LOCALAPPDATA 'Packages'
    if (Test-Path -LiteralPath $pkgRoot) {
        Get-ChildItem -LiteralPath $pkgRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $p = Join-Path $_.FullName 'LocalState\ext4.vhdx'
            if (Test-Path -LiteralPath $p) { $vhdx.Add($p) }
        }
    }
    $wslRoot = Join-Path $env:LOCALAPPDATA 'wsl'
    if (Test-Path -LiteralPath $wslRoot) {
        Get-ChildItem -LiteralPath $wslRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $p = Join-Path $_.FullName 'ext4.vhdx'
            if (Test-Path -LiteralPath $p) { $vhdx.Add($p) }
        }
    }
    $i = 0
    foreach ($p in ($vhdx | Select-Object -Unique)) {
        $i++
        $list.Add((New-Hotspot "vhdx-$i" $p 'vhdx' 'virtual-disk'))
    }
    $old = Join-Path $env:SystemDrive 'Windows.old'
    if (Test-Path -LiteralPath $old) {
        $list.Add((New-Hotspot 'windows-old' $old 'red' 'system'))
    }
    $seen = @{}
    $deduped = New-Object System.Collections.Generic.List[object]
    foreach ($h in $list) {
        $key = $h.path
        try {
            $key = (Get-Item -LiteralPath $h.path).FullName.ToLowerInvariant()
        } catch {
            $key = $h.path.ToLowerInvariant()
        }
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        [void]$deduped.Add($h)
    }
    return , @($deduped.ToArray())
}

function Get-TopLevel([string]$Root) {
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($child in @(Get-ChildItem -LiteralPath $Root -Force -ErrorAction SilentlyContinue)) {
        $kind = 'file'
        if ($child.PSIsContainer) { $kind = 'dir' }
        $ext = ''
        if ($child.Extension) { $ext = [string]$child.Extension.ToLower() }
        if ($ext -eq '.zip' -or $ext -eq '.7z' -or $ext -eq '.rar') { $kind = 'archive' }
        $bytes = $null
        if (Test-Reparse $child) {
            Warn "junction-skipped:$($child.FullName)"
        } elseif (Test-TimedOut) {
            # 超时后保留条目，体积留空（报告标估算）
        } else {
            Note "size $($child.Name)"
            $bytes = Measure-PathBytes $child.FullName
        }
        $mtime = $null
        try { $mtime = $child.LastWriteTimeUtc.ToString('o') } catch { }
        $entry = @{
            path  = $child.FullName
            name  = $child.Name
            bytes = $bytes
            mtime = $mtime
            kind  = $kind
        }
        if (Test-CloudPlaceholder $child) { $entry.cloud = $true }
        [void]$items.Add($entry)
    }
    return , @($items.ToArray())
}

# 与目录树正交的最大文件（WizTree File View 模式）：深度 ≤2、>100MB、跳过缓存目录；只读元数据，云占位只打标不读内容
function Get-LargeFiles([string]$Root, [int64]$MinBytes = 104857600, [int]$Max = 50) {
    $found = New-Object System.Collections.Generic.List[object]
    function Collect-Files([string]$Dir) {
        foreach ($f in @(Get-ChildItem -LiteralPath $Dir -File -Force -ErrorAction SilentlyContinue)) {
            if ((Test-Reparse $f) -or ($f.Length -lt $MinBytes)) { continue }
            $e = @{ path = $f.FullName; name = $f.Name; bytes = [int64]$f.Length }
            try { $e.mtime = $f.LastWriteTimeUtc.ToString('o') } catch { }
            if (Test-CloudPlaceholder $f) { $e.cloud = $true }
            [void]$found.Add($e)
        }
    }
    Collect-Files $Root
    Get-ChildItem -LiteralPath $Root -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
        if ((Test-Reparse $_) -or (Test-SkipDescend $_.Name)) { return }
        Collect-Files $_.FullName
        Get-ChildItem -LiteralPath $_.FullName -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
            if ((Test-Reparse $_) -or (Test-SkipDescend $_.Name)) { return }
            Collect-Files $_.FullName
        }
    }
    return , @($found | Sort-Object bytes -Descending | Select-Object -First $Max)
}

# --- main ---
$sevenZip = Find-SevenZip
$partial = $false
$targetResolved = $null
$topLevel = @()
$caches = @()
$archives = @()
$projects = @()
$gitRoots = @()
$noise = @()
$hotspots = @()
$largeFiles = @()

if ($Mode -ne 'machine' -and [string]::IsNullOrWhiteSpace($Target)) {
    $err = @{ schema = 'storage-audit-collect/1'; error = 'target required for quick/project' }
    $err | ConvertTo-Json -Compress
    exit 2
}

$targetIsDir = $false
$targetItem = $null
if (-not [string]::IsNullOrWhiteSpace($Target)) {
    if (-not (Test-Path -LiteralPath $Target)) {
        $err = @{ schema = 'storage-audit-collect/1'; error = "target not found: $Target" }
        $err | ConvertTo-Json -Compress
        exit 2
    }
    $targetItem = Get-Item -LiteralPath $Target -Force
    $targetResolved = $targetItem.FullName
    $targetIsDir = [bool]$targetItem.PSIsContainer
}

$diskProbe = $targetResolved
if (-not $diskProbe) { $diskProbe = $env:SystemDrive + '\' }
$disk = Get-DiskInfo $diskProbe

if ($Mode -eq 'machine') {
    $hotspots = Get-MachineHotspots
    foreach ($h in $hotspots) {
        if (Test-TimedOut) { break }
        Note "size $($h.name)"
        $h.bytes = Measure-PathBytes $h.path
        if ($null -eq $h.bytes) { $partial = $true }
    }
}

if ($targetResolved -and $Mode -ne 'machine') {
    if ($targetIsDir) {
        $topLevel = Get-TopLevel $targetResolved
        $largeFiles = Get-LargeFiles $targetResolved
        $cacheHits = Get-CachePaths $targetResolved
        $ci = 0
        foreach ($cp in $cacheHits) {
            if ($ci -ge $MaxCaches) { $partial = $true; Warn 'caches-truncated'; break }
            if (Test-TimedOut) { break }
            Note "cache $($cp.pattern)"
            $cb = Measure-PathBytes $cp.path
            if ($null -eq $cb) { $partial = $true }
            $caches += @{ path = $cp.path; pattern = $cp.pattern; eco = $cp.eco; bytes = $cb }
            $ci++
        }
    } else {
        $ext = $targetItem.Extension.ToLower()
        $kind = 'file'
        if ($ext -eq '.zip' -or $ext -eq '.7z' -or $ext -eq '.rar') { $kind = 'archive' }
        $topLevel = @(, @{
                path  = $targetResolved
                name  = $targetItem.Name
                bytes = [int64]$targetItem.Length
                mtime = $targetItem.LastWriteTimeUtc.ToString('o')
                kind  = $kind
            })
    }
}

if ($targetResolved -and $Mode -eq 'project') {
    if ($targetIsDir) {
        $archPaths = Get-ArchivePaths $targetResolved
        $ai = 0
        foreach ($ap in $archPaths) {
            if ($ai -ge $MaxArchives) { $partial = $true; Warn 'archives-truncated'; break }
            if (Test-TimedOut) { break }
            Note "archive $(Split-Path $ap -Leaf)"
            $info = Get-ZipInfo $ap
            Add-SevenZipInfo $info $sevenZip
            $archives += $info
            $ai++
        }
        $projCandidates = New-Object System.Collections.Generic.List[string]
        $projCandidates.Add($targetResolved)
        Get-ChildItem -LiteralPath $targetResolved -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
            if ((Test-Reparse $_) -or (Test-SkipDescend $_.Name)) { return }
            $projCandidates.Add($_.FullName)
            Get-ChildItem -LiteralPath $_.FullName -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
                if ((Test-Reparse $_) -or (Test-SkipDescend $_.Name)) { return }
                $projCandidates.Add($_.FullName)
            }
        }
        $pi = 0
        foreach ($pd in ($projCandidates | Select-Object -Unique)) {
            if ($pi -ge $MaxProjects) { $partial = $true; Warn 'projects-truncated'; break }
            if (Test-TimedOut) { break }
            $p = Get-ProjectInfo $pd
            if ($p) { $projects += $p; $pi++ }
        }
        $gitRoots = Get-GitRoots $targetResolved
        $noise = Get-Noise $targetResolved
    } elseif ($targetItem -and ($targetItem.Extension.ToLower() -eq '.zip' -or $targetItem.Extension.ToLower() -eq '.7z' -or $targetItem.Extension.ToLower() -eq '.rar')) {
        $info = Get-ZipInfo $targetResolved
        Add-SevenZipInfo $info $sevenZip
        $archives += $info
    }
}

if ($targetResolved -and $Mode -eq 'machine' -and $targetIsDir) {
    $topLevel = Get-TopLevel $targetResolved
}

$keepRootResolved = $null
if (-not [string]::IsNullOrWhiteSpace($KeepRoot)) {
    if (Test-Path -LiteralPath $KeepRoot) {
        $keepRootResolved = (Get-Item -LiteralPath $KeepRoot).FullName
    } else {
        Warn "keep-root-missing:$KeepRoot"
    }
}

# 正本约束写入数据模型：命中 keep-root 的条目永不可作为被删方
if ($keepRootResolved) {
    $kr = $keepRootResolved.TrimEnd('\')
    foreach ($list in @($topLevel, $caches, $archives, $projects, $largeFiles)) {
        foreach ($e in $list) {
            $p = $e.path
            if ($p -and ($p.Equals($kr, [StringComparison]::OrdinalIgnoreCase) -or
                    $p.StartsWith($kr + '\', [StringComparison]::OrdinalIgnoreCase))) {
                $e.underKeepRoot = $true
            }
        }
    }
}

$result = [ordered]@{
    schema      = 'storage-audit-collect/1'
    mode        = $Mode
    target      = $targetResolved
    keepRoot    = $keepRootResolved
    os          = 'windows'
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    disk        = $disk
    tools       = @{
        sevenZip = [bool]$sevenZip
        tar      = [bool](Get-Command tar -ErrorAction SilentlyContinue)
        git      = [bool](Get-Command git -ErrorAction SilentlyContinue)
    }
    topLevel         = @($topLevel)
    caches           = @($caches)
    archives         = @($archives)
    projects         = @($projects)
    gitRoots         = @($gitRoots)
    structureNoise   = @($noise)
    machineHotspots  = @($hotspots)
    largeFiles       = @($largeFiles)
    warnings         = @($script:Warnings)
    partial          = $partial
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outFile = Join-Path $env:TEMP "storage-audit-collect-$stamp.json"
$json = $result | ConvertTo-Json -Depth 8 -Compress:$false
[System.IO.File]::WriteAllText($outFile, $json, [System.Text.UTF8Encoding]::new($false))
[Console]::Error.WriteLine("storage-audit: wrote $outFile")
Write-Output $outFile
