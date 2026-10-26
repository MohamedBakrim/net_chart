<#
.SYNOPSIS
    Send the Bakrim image to a Linux server over SSH - no registry required.

.DESCRIPTION
    Builds the chart-compatible image (net_chart/Dockerfile, nginx-unprivileged
    on :8080 with /healthz), saves it to a temp tarball with `docker save`,
    copies it with scp, and loads it on the remote host with `docker load` -
    falling back to `k3s ctr images import` / `ctr -n k8s.io` for k3s-only
    servers. The tarball is deleted on both ends afterwards.

    The chart's image.pullPolicy is IfNotPresent, so once the image exists on
    the node, the pods use it directly without any registry.

.NOTES
    Never pipe `docker save` through PowerShell - the pipe re-encodes bytes and
    corrupts binary data. That is why this script uses a temp file + scp.

.EXAMPLE
    .\Send-BakrimImage.ps1 -Server root@192.168.1.50

.EXAMPLE
    .\Send-BakrimImage.ps1 -Server myserver -Image bakrim:2.6.0 -SkipBuild
#>
[CmdletBinding()]
param(
    # ssh target: user@host, or an alias defined in ~/.ssh/config
    [Parameter(Mandatory = $true)]
    [string]$Server,

    # Must match image.repository:image.tag used at install time
    [string]$Image = "bakrim:2.6.0",

    # Build context = app source (Dockerfile lives in the chart)
    [string]$Context = (Join-Path (Split-Path $PSScriptRoot -Parent) "homenet\streambert"),

    # Reuse an image that already exists locally
    [switch]$SkipBuild
)

$ErrorActionPreference = "Continue"

# 1) Make sure the image exists locally ---------------------------------------
if ($SkipBuild) {
    docker image inspect $Image *> $null
    if ($LASTEXITCODE -ne 0) { throw "SkipBuild set, but image '$Image' was not found locally." }
} else {
    docker image inspect $Image *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[build] '$Image' not found locally - building from $PSScriptRoot\Dockerfile"
        docker build -f "$PSScriptRoot\Dockerfile" -t $Image $Context
        if ($LASTEXITCODE -ne 0) { throw "docker build failed" }
    } else {
        Write-Host "[build] '$Image' already present locally (use -SkipBuild silence)" -NoNewline; Write-Host ""
    }
}

# 2) Save to a temp tarball ---------------------------------------------------
$tar = Join-Path $env:TEMP ("bakrim-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".tar")
docker save -o $tar $Image
if ($LASTEXITCODE -ne 0) { throw "docker save failed" }
$sizeMb = [math]::Round((Get-Item $tar).Length / 1MB, 1)
Write-Host "[save]  $tar ($sizeMb MB)"

# 3) Copy it over SSH ---------------------------------------------------------
Write-Host "[copy]  -> ${Server}:/tmp/bakrim-image.tar"
scp $tar "${Server}:/tmp/bakrim-image.tar"
if ($LASTEXITCODE -ne 0) { Remove-Item $tar -Force; throw "scp failed" }

# 4) Load it on the server (docker first, then k3s/containerd) ----------------
$remoteLoad = @(
    "docker load -i /tmp/bakrim-image.tar 2>/dev/null"
    "|| sudo k3s ctr images import /tmp/bakrim-image.tar 2>/dev/null"
    "|| sudo ctr -n k8s.io images import /tmp/bakrim-image.tar"
    "; rm -f /tmp/bakrim-image.tar"
) -join " "

Write-Host "[load]  docker load (fallback: k3s ctr import)"
ssh $Server $remoteLoad
if ($LASTEXITCODE -ne 0) { Remove-Item $tar -Force; throw "remote load failed" }

# 5) Verify + cleanup ---------------------------------------------------------
Write-Host "[check] image on remote host:"
ssh $Server "docker image inspect $Image --format '  ok (docker): {{json .Id}}' 2>/dev/null || sudo k3s ctr images list name==$Image 2>/dev/null | sed -n 2p"
Remove-Item $tar -Force

Write-Host ""
Write-Host "[done]  '$Image' is on '$Server'. Deploy with:" -ForegroundColor Green
Write-Host "        helm upgrade --install bakrim $PSScriptRoot -n bakrim --create-namespace"
