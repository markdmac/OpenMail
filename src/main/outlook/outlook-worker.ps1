# OpenMail Outlook bridge.
# Long-running worker: reads one JSON request per line on stdin, writes one JSON reply per line on stdout.
# Request:  {"id":1,"cmd":"importMsg","args":{...}}
# Reply:    {"id":1,"ok":true,"result":...}  or  {"id":1,"ok":false,"error":"..."}

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$script:outlook = $null
$script:ns = $null
$script:store = $null
$script:root = $null
$script:folderCache = @{}

$PR_HASATTACH = 'http://schemas.microsoft.com/mapi/proptag/0x0E1B000B'
$PR_FLAG_STATUS = 'http://schemas.microsoft.com/mapi/proptag/0x10900003'
$PR_SENDER_EMAIL = 'http://schemas.microsoft.com/mapi/proptag/0x0C1F001F'
$PR_ATTACH_CONTENT_ID = 'http://schemas.microsoft.com/mapi/proptag/0x3712001F'
$PR_ATTACHMENT_HIDDEN = 'http://schemas.microsoft.com/mapi/proptag/0x7FFE000B'

function Write-Reply($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 30
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Release($o) {
    if ($o -ne $null) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($o) } catch {} }
}

function Iso($d) {
    if ($d -eq $null) { return $null }
    try {
        $dt = [DateTime]$d
        if ($dt.Year -ge 4000) { return $null } # Outlook's "none" date (4501-01-01)
        return $dt.ToUniversalTime().ToString('o')
    } catch { return $null }
}

function Require-Store {
    if ($script:store -eq $null) { throw 'PST is not open. Call init first.' }
}

function Cmd-Init($a) {
    $pst = [IO.Path]::GetFullPath($a.pstPath)
    $dir = [IO.Path]::GetDirectoryName($pst)
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    # Outlook automation hangs on the first-run wizard when no mail profile exists, so check first.
    $profiles = @(Get-ChildItem 'HKCU:\Software\Microsoft\Office\*\Outlook\Profiles' -ErrorAction SilentlyContinue | ForEach-Object { Get-ChildItem $_.PSPath -ErrorAction SilentlyContinue })
    $wizard = Get-Process OUTLOOK -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'Welcome to Microsoft Outlook*' -or $_.MainWindowTitle -like '*Account Setup*' -or $_.MainWindowTitle -like 'Choose Profile*' }
    if ($profiles.Count -eq 0 -or $wizard) {
        throw 'Outlook has not been set up on this PC yet. Open Outlook and finish its setup wizard (you do not need to add an email account: choose to use Outlook without one), then try again.'
    }

    $script:outlook = New-Object -ComObject Outlook.Application
    $script:ns = $script:outlook.GetNamespace('MAPI')

    $found = $null
    foreach ($s in $script:ns.Stores) {
        try { if ($s.FilePath -and ([IO.Path]::GetFullPath($s.FilePath) -ieq $pst)) { $found = $s; break } } catch {}
    }
    if ($found -eq $null) {
        $script:ns.AddStoreEx($pst, 3) # olStoreUnicode
        foreach ($s in $script:ns.Stores) {
            try { if ($s.FilePath -and ([IO.Path]::GetFullPath($s.FilePath) -ieq $pst)) { $found = $s; break } } catch {}
        }
    }
    if ($found -eq $null) { throw "Outlook could not open or create PST at $pst" }

    $script:store = $found
    $script:root = $found.GetRootFolder()
    $script:folderCache = @{}
    if ($a.displayName -and $script:root.Name -ne $a.displayName) {
        try { $script:root.Name = $a.displayName } catch {}
    }
    return @{ storeId = $found.StoreID; displayName = $script:root.Name; filePath = $found.FilePath; outlookVersion = $script:outlook.Version }
}

function Split-FolderPath($path) {
    return @(($path -split '/') | Where-Object { $_ -ne '' })
}

function Get-Folder($path, [bool]$create) {
    Require-Store
    if ([string]::IsNullOrEmpty($path)) { return $script:root }
    $key = $path.ToLowerInvariant()
    if ($script:folderCache.ContainsKey($key)) {
        $cached = $script:folderCache[$key]
        try { [void]$cached.Name; return $cached } catch { $script:folderCache.Remove($key) }
    }
    $folder = $script:root
    foreach ($part in (Split-FolderPath $path)) {
        $next = $null
        foreach ($f in $folder.Folders) { if ($f.Name -ieq $part) { $next = $f; break } }
        if ($next -eq $null) {
            if (-not $create) { throw "Folder not found: $path" }
            $next = $folder.Folders.Add($part)
        }
        $folder = $next
    }
    $script:folderCache[$key] = $folder
    return $folder
}

function Folder-Tree($folder, $prefix) {
    $list = @()
    foreach ($f in $folder.Folders) {
        if ($f.DefaultItemType -ne 0) { continue } # mail folders only
        $path = if ($prefix) { "$prefix/$($f.Name)" } else { $f.Name }
        $list += @{
            name = $f.Name
            path = $path
            entryId = $f.EntryID
            unread = $f.UnReadItemCount
            count = $f.Items.Count
            children = @(Folder-Tree $f $path)
        }
    }
    return $list
}

function Cmd-ListFolders($a) {
    Require-Store
    return @{ name = $script:root.Name; children = @(Folder-Tree $script:root '') }
}

function Cmd-EnsureFolder($a) {
    $f = Get-Folder $a.path $true
    return @{ entryId = $f.EntryID }
}

function Cmd-RenameFolder($a) {
    $f = Get-Folder $a.path $false
    $f.Name = $a.newName
    $script:folderCache = @{}
    return $true
}

function Cmd-DeleteFolder($a) {
    $f = Get-Folder $a.path $false
    $f.Delete()
    $script:folderCache = @{}
    return $true
}

function Cmd-ImportMsg($a) {
    $folder = Get-Folder $a.folderPath $true
    $item = $script:ns.OpenSharedItem($a.msgPath)
    try {
        $moved = $item.Move($folder)
        $changed = $false
        if ($a.PSObject.Properties['unread'] -ne $null -and $moved.UnRead -ne [bool]$a.unread) { $moved.UnRead = [bool]$a.unread; $changed = $true }
        if ($a.categories) { $moved.Categories = ($a.categories -join ', '); $changed = $true }
        if ($changed) { $moved.Save() }
        $id = $moved.EntryID
        Release $moved
        return @{ entryId = $id }
    } finally {
        Release $item
    }
}

function Cmd-ListItems($a) {
    $folder = Get-Folder $a.folderPath $false
    $filter = ''
    if ($a.search) {
        $q = ($a.search -replace "'", "''")
        $filter = "@SQL=(""urn:schemas:httpmail:subject"" LIKE '%$q%' OR ""urn:schemas:httpmail:fromname"" LIKE '%$q%' OR ""urn:schemas:httpmail:fromemail"" LIKE '%$q%' OR ""urn:schemas:httpmail:textdescription"" LIKE '%$q%')"
    } elseif ($a.unreadOnly) {
        $filter = '[UnRead] = True'
    }
    $table = $folder.GetTable($filter)
    $table.Columns.RemoveAll()
    foreach ($c in @('EntryID', 'Subject', 'SenderName', 'ReceivedTime', 'UnRead', 'Size', 'Categories', $PR_HASATTACH, $PR_FLAG_STATUS, $PR_SENDER_EMAIL)) { [void]$table.Columns.Add($c) }
    $table.Sort('[ReceivedTime]', $true)
    $total = $table.GetRowCount()
    $offset = [int]$a.offset
    $limit = if ($a.limit) { [int]$a.limit } else { 200 }
    if ($offset -gt 0) { for ($i = 0; $i -lt $offset -and -not $table.EndOfTable; $i++) { [void]$table.GetNextRow() } }
    $items = @()
    while (-not $table.EndOfTable -and $items.Count -lt $limit) {
        $v = $table.GetNextRow().GetValues()
        $items += @{
            entryId = $v[0]; subject = $v[1]; from = $v[2]; date = (Iso $v[3]); unread = [bool]$v[4]
            size = $v[5]; categories = $v[6]; hasAttachments = [bool]$v[7]; flagged = ($v[8] -eq 2); fromAddress = $v[9]
        }
    }
    Release $table
    return @{ total = $total; offset = $offset; items = $items }
}

function Get-Item($entryId) {
    Require-Store
    return $script:ns.GetItemFromID($entryId, $script:store.StoreID)
}

function Cmd-GetItem($a) {
    $item = Get-Item $a.entryId
    $atts = @()
    $inline = @{}
    $tmp = Join-Path $env:TEMP ("openmail-" + [Guid]::NewGuid().ToString('N'))
    for ($i = 1; $i -le $item.Attachments.Count; $i++) {
        $att = $item.Attachments.Item($i)
        $cid = $null; $hidden = $false
        try { $cid = $att.PropertyAccessor.GetProperty($PR_ATTACH_CONTENT_ID) } catch {}
        try { $hidden = [bool]$att.PropertyAccessor.GetProperty($PR_ATTACHMENT_HIDDEN) } catch {}
        if ($cid -and $item.HTMLBody -match [Regex]::Escape("cid:$cid") -and $att.Size -lt 5MB) {
            New-Item -ItemType Directory -Force -Path $tmp | Out-Null
            $p = Join-Path $tmp ("$i-" + ($att.FileName -replace '[\\/:*?"<>|]', '_'))
            try {
                $att.SaveAsFile($p)
                $bytes = [IO.File]::ReadAllBytes($p)
                $ext = [IO.Path]::GetExtension($p).TrimStart('.').ToLowerInvariant()
                $mime = switch ($ext) { 'png' { 'image/png' } 'gif' { 'image/gif' } 'svg' { 'image/svg+xml' } 'webp' { 'image/webp' } default { 'image/jpeg' } }
                $inline[$cid] = "data:$mime;base64," + [Convert]::ToBase64String($bytes)
            } catch {}
        }
        if (-not $hidden) { $atts += @{ index = $i; name = $att.FileName; size = $att.Size } }
        Release $att
    }
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    $result = @{
        entryId = $item.EntryID
        subject = $item.Subject
        from = $item.SenderName
        fromAddress = $item.SenderEmailAddress
        to = $item.To
        cc = $item.CC
        bcc = $item.BCC
        date = (Iso $item.ReceivedTime)
        sent = (Iso $item.SentOn)
        html = $item.HTMLBody
        text = $item.Body
        unread = $item.UnRead
        categories = $item.Categories
        flagged = ($item.FlagStatus -eq 2)
        importance = $item.Importance
        messageId = $null
        headers = $null
        attachments = $atts
        inlineImages = $inline
        folderPath = $item.Parent.FolderPath
    }
    try { $result.headers = $item.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x007D001F') } catch {}
    try { $result.messageId = $item.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x1035001F') } catch {}
    Release $item
    return $result
}

function Cmd-SetRead($a) {
    foreach ($id in $a.entryIds) { $it = Get-Item $id; $it.UnRead = [bool]$a.unread; $it.Save(); Release $it }
    return $true
}

function Cmd-SetFlag($a) {
    foreach ($id in $a.entryIds) {
        $it = Get-Item $id
        if ($a.flagged) { $it.MarkAsTask(4) } else { $it.ClearTaskFlag() }
        $it.Save(); Release $it
    }
    return $true
}

function Cmd-SetCategories($a) {
    foreach ($id in $a.entryIds) { $it = Get-Item $id; $it.Categories = ($a.categories -join ', '); $it.Save(); Release $it }
    return $true
}

function Cmd-MoveItems($a) {
    $folder = Get-Folder $a.folderPath $true
    $ids = @()
    foreach ($id in $a.entryIds) { $it = Get-Item $id; $m = $it.Move($folder); $ids += $m.EntryID; Release $m; Release $it }
    return @{ entryIds = $ids }
}

function Cmd-DeleteItems($a) {
    # Same semantics as Outlook: first delete moves to the PST's Deleted Items; deleting there removes permanently.
    foreach ($id in $a.entryIds) { $it = Get-Item $id; $it.Delete(); Release $it }
    return $true
}

function Cmd-SaveAttachment($a) {
    $it = Get-Item $a.entryId
    $att = $it.Attachments.Item([int]$a.index)
    $att.SaveAsFile($a.path)
    Release $att; Release $it
    return @{ path = $a.path }
}

function Cmd-OpenInOutlook($a) {
    $it = Get-Item $a.entryId
    $it.Display()
    Release $it
    return $true
}

function Cmd-ClosePst($a) {
    # Detaches the PST from the Outlook profile; the file itself is left on disk.
    if ($script:store -ne $null) { $script:ns.RemoveStore($script:root) }
    $script:store = $null; $script:root = $null; $script:folderCache = @{}
    return $true
}

$handlers = @{
    ping = { param($a) 'pong' }
    init = { param($a) Cmd-Init $a }
    closePst = { param($a) Cmd-ClosePst $a }
    listFolders = { param($a) Cmd-ListFolders $a }
    ensureFolder = { param($a) Cmd-EnsureFolder $a }
    renameFolder = { param($a) Cmd-RenameFolder $a }
    deleteFolder = { param($a) Cmd-DeleteFolder $a }
    importMsg = { param($a) Cmd-ImportMsg $a }
    listItems = { param($a) Cmd-ListItems $a }
    getItem = { param($a) Cmd-GetItem $a }
    setRead = { param($a) Cmd-SetRead $a }
    setFlag = { param($a) Cmd-SetFlag $a }
    setCategories = { param($a) Cmd-SetCategories $a }
    moveItems = { param($a) Cmd-MoveItems $a }
    deleteItems = { param($a) Cmd-DeleteItems $a }
    saveAttachment = { param($a) Cmd-SaveAttachment $a }
    openInOutlook = { param($a) Cmd-OpenInOutlook $a }
}

Write-Reply @{ id = 0; ok = $true; result = 'ready' }

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($line -eq $null) { break }
    if ($line.Trim() -eq '') { continue }
    $req = $null
    try {
        $req = $line | ConvertFrom-Json
        $h = $handlers[$req.cmd]
        if ($h -eq $null) { throw "Unknown command: $($req.cmd)" }
        $args0 = if ($req.args) { $req.args } else { New-Object PSObject }
        $result = & $h $args0
        Write-Reply @{ id = $req.id; ok = $true; result = $result }
    } catch {
        $rid = if ($req) { $req.id } else { -1 }
        Write-Reply @{ id = $rid; ok = $false; error = $_.Exception.Message }
    }
}
