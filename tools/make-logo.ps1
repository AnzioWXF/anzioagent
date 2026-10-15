# make-logo.ps1 — build the app icon assets from the master logo PNG.
#
#   pwsh -ExecutionPolicy Bypass -File D:\99DSH\tools\make-logo.ps1
#
# Input : D:\logoV2p.png  (1024x1024, opaque white background)
# Output: <OutDir>\icon.png        512x512  window icon + electron-builder icon
#         <OutDir>\logo.png        128x128  splash screen art (loading.html)
#         <OutDir>\icon.ico        multi-size, PNG-compressed entries, used as the
#                                  desktop-shortcut icon so the new logo shows up
#                                  without re-running electron-builder
#         <OutDir>\logo64.png       64x64    in-app title bar mark
#         <B64File>                base64 of logo64.png (embedded into client.js)
#
# The master art is opaque white, so every tile is a rounded white square
# (22% corner radius) with the art bled to the edges; everything outside the
# rounded rect stays transparent. Re-run this script whenever the logo changes.
param(
  [string]$Source = 'D:\logoV2p.png',
  [string]$OutDir = 'D:\99DSH\deepseek-harness-mine\shell\assets',
  [string]$B64File = 'D:\99DSH\tools\.logo64.b64.txt',
  [double]$RadiusRatio = 0.22,
  [int[]]$IcoSizes = @(16, 24, 32, 48, 64, 128, 256)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $Source)) { throw "logo source not found: $Source" }
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

# Rounded white tile with the artwork bled to the edges (transparent outside).
function New-Tile([System.Drawing.Image]$src, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $d = [double]$size * $RadiusRatio * 2.0
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0.0, 0.0, $d, $d, 180.0, 90.0)
  $path.AddArc([double]$size - $d, 0.0, $d, $d, 270.0, 90.0)
  $path.AddArc([double]$size - $d, [double]$size - $d, $d, $d, 0.0, 90.0)
  $path.AddArc(0.0, [double]$size - $d, $d, $d, 90.0, 90.0)
  $path.CloseFigure()
  $g.SetClip($path)
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  $g.ResetClip()
  $g.Dispose()
  $path.Dispose()
  return $bmp
}

# Downscale the master tile to one size and save it as PNG (alpha preserved).
function Save-Png([System.Drawing.Image]$master, [int]$size, [string]$file) {
  $t = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($t)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($master, 0, 0, $size, $size)
  $g.Dispose()
  $t.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $t.Dispose()
}

# ICO container with PNG payloads (supported by Windows Vista+; required for 256px).
function Write-Ico([string[]]$pngFiles, [string]$out) {
  $blobs = @()
  foreach ($p in $pngFiles) { $blobs += , ([System.IO.File]::ReadAllBytes($p)) }
  $sizes = @()
  foreach ($p in $pngFiles) {
    $n = [System.IO.Path]::GetFileNameWithoutExtension($p)
    $sizes += [int]($n -replace '^ico-', '')
  }
  $fs = [System.IO.File]::Create($out)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([uint16]0)                 # reserved
  $bw.Write([uint16]1)                 # type = icon
  $bw.Write([uint16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = [int]$sizes[$i]
    $dim = if ($s -ge 256) { [byte]0 } else { [byte]$s }   # 0 means 256
    $bw.Write($dim)                    # width
    $bw.Write($dim)                    # height
    $bw.Write([byte]0)                 # palette count
    $bw.Write([byte]0)                 # reserved
    $bw.Write([uint16]1)               # color planes
    $bw.Write([uint16]32)              # bits per pixel
    $bw.Write([uint32]$blobs[$i].Length)
    $bw.Write([uint32]$offset)
    $offset += $blobs[$i].Length
  }
  foreach ($b in $blobs) { $bw.Write($b) }
  $bw.Flush(); $bw.Dispose(); $fs.Dispose()
}

$src = [System.Drawing.Image]::FromFile($Source)
try {
  $master = New-Tile $src 1024
  try {
    Save-Png $master 512 (Join-Path $OutDir 'icon.png')
    Save-Png $master 128 (Join-Path $OutDir 'logo.png')
    Save-Png $master 64  (Join-Path $OutDir 'logo64.png')

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('anzio-ico-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $tmpFiles = @()
    foreach ($s in ($IcoSizes | Sort-Object)) {
      $f = Join-Path $tmp ("ico-$s.png")
      Save-Png $master $s $f
      $tmpFiles += $f
    }
    Write-Ico $tmpFiles (Join-Path $OutDir 'icon.ico')
    Remove-Item -LiteralPath $tmp -Recurse -Force

    $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $OutDir 'logo64.png')))
    [System.IO.File]::WriteAllText($B64File, $b64, (New-Object System.Text.UTF8Encoding($false)))
  } finally { $master.Dispose() }
} finally { $src.Dispose() }

foreach ($n in 'icon.png', 'logo.png', 'logo64.png', 'icon.ico') {
  $p = Join-Path $OutDir $n
  Write-Host ("{0,-12} {1,8:N1} KB" -f $n, ((Get-Item -LiteralPath $p).Length / 1KB))
}
Write-Host ("base64 (64px) -> {0}  {1} chars" -f $B64File, (Get-Item -LiteralPath $B64File).Length)
