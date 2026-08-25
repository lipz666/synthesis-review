# Launch the review app locally.
#
#   powershell -ExecutionPolicy Bypass -File E:\OSTE\synthesis-review\start.ps1
#   powershell -ExecutionPolicy Bypass -File E:\OSTE\synthesis-review\start.ps1 -Port 9000 -Lan

param(
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 8770,
    [switch]$Lan,          # bind every interface so the LAN can reach it
    [switch]$NoBrowser,
    [switch]$Reload        # uvicorn autoreload, for development
)

if ($Lan) { $BindHost = "0.0.0.0" }

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# RDKit lives in the `chemistry` conda env on this machine. Without it the app
# still runs; structures fall back to the OCSR crops.
$python = "C:\Users\lpz\miniconda3\envs\chemistry\python.exe"
if (-not (Test-Path $python)) {
    $found = Get-Command python -ErrorAction SilentlyContinue
    if ($null -eq $found) { throw "no python found; create an env with fastapi + uvicorn (+ rdkit)" }
    $python = $found.Source
    Write-Host "chemistry env not found, falling back to $python" -ForegroundColor Yellow
}

$env:REVIEW_DATA_DIR = Join-Path $here "data"
$env:REVIEW_STATIC_DIR = Join-Path $here "static"

$arguments = @("-m", "uvicorn", "app.main:app", "--host", $BindHost, "--port", "$Port", "--log-level", "warning")
if ($Reload) { $arguments += @("--reload") }

$localUrl = if ($BindHost -eq "0.0.0.0") { "http://127.0.0.1:$Port" } else { "http://$BindHost`:$Port" }

if (-not $NoBrowser) {
    Start-Job -ScriptBlock {
        param($url)
        Start-Sleep -Seconds 3
        Start-Process $url
    } -ArgumentList $localUrl | Out-Null
}

Write-Host ""
Write-Host "  合成抽取审核台" -ForegroundColor White
Write-Host "  本机   $localUrl" -ForegroundColor DarkYellow

if ($BindHost -eq "0.0.0.0") {
    $addresses = Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" }
    foreach ($address in $addresses) {
        Write-Host ("  局域网 http://{0}:{1}   ({2})" -f $address.IPAddress, $Port, $address.InterfaceAlias) -ForegroundColor DarkYellow
    }
    Write-Host ""
    Write-Host "  局域网访问需放行入站端口 $Port（管理员，一次即可）：" -ForegroundColor DarkGray
    Write-Host "    netsh advfirewall firewall add rule name=`"Synthesis Review`" dir=in action=allow protocol=TCP localport=$Port remoteip=LocalSubnet" -ForegroundColor DarkGray
    Write-Host "  注意：本服务没有身份验证，同网段任何人都能提交审核事件。" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  Ctrl+C 停止" -ForegroundColor DarkGray
Write-Host ""

Push-Location $here
try { & $python @arguments } finally { Pop-Location }
