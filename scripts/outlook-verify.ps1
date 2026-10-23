# DEVELOPER TOOL (needs Outlook): opens a PST in Outlook and prints what Outlook sees, then detaches it.
# Run it on a COPY: Outlook modifies files it opens.
#   powershell -File scripts/outlook-verify.ps1 -Pst C:\path\copy.pst
param([Parameter(Mandatory = $true)][string]$Pst, [int]$MaxItems = 5)

$ErrorActionPreference = 'Stop'
$pst = [IO.Path]::GetFullPath($Pst)
$o = New-Object -ComObject Outlook.Application
$ns = $o.GetNamespace('MAPI')
$ns.AddStoreEx($pst, 2)
$store = $null
foreach ($s in $ns.Stores) { if ($s.FilePath -ieq $pst) { $store = $s } }
if (-not $store) { throw "Outlook did not open $pst" }
Write-Output "STORE: $($store.DisplayName)  unicode-capable  file=$($store.FilePath)"

function Walk($folder, $depth) {
    $pad = '  ' * $depth
    Write-Output ("{0}[{1}] items={2} unread={3}" -f $pad, $folder.Name, $folder.Items.Count, $folder.UnReadItemCount)
    $n = 0
    foreach ($it in $folder.Items) {
        if ($n -ge $MaxItems) { break }
        $n++
        $atts = @()
        try { foreach ($a in $it.Attachments) { $atts += "$($a.FileName):$($a.Size)" } } catch {}
        $html = ''
        try { $html = $it.HTMLBody } catch {}
        Write-Output ("{0}  - {1} | from {2} <{3}> | to {4} | recv {5} | unread {6} | cats {7} | atts [{8}] | html {9}" -f $pad, $it.Subject, $it.SenderName, $it.SenderEmailAddress, $it.To, $it.ReceivedTime, $it.UnRead, $it.Categories, ($atts -join ', '), $html.Length)
    }
    foreach ($f in $folder.Folders) { Walk $f ($depth + 1) }
}
try {
    Walk $store.GetRootFolder() 0
} finally {
    $ns.RemoveStore($store.GetRootFolder())
    Write-Output 'DETACHED'
}
