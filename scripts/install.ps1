# ─────────────────────────────────────────────────
#  WGF Support Shell — Installateur Windows
# ─────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$Repo        = "WeGetFunded-com/wgf-support-tool"
$DownloadUrl = "https://github.com/$Repo/releases/latest/download/wgf-support.cjs"
$InstallDir  = "$env:USERPROFILE\.wgf-support-tool"
$BinFile     = "$InstallDir\wgf-support.cjs"
$Wrapper     = "$InstallDir\wgf-support.cmd"
$NodeMinVer  = 18

function Write-Info($msg)    { Write-Host "  [i] $msg" -ForegroundColor Blue }
function Write-Ok($msg)      { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)    { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Fail($msg)    { Write-Host "  [ERR] $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  WGF Support Shell - Installation"
Write-Host "  ---------------------------------"
Write-Host ""

# -- 1. Verifier / installer Node.js --
function Test-NodeVersion {
    try {
        $ver = (node -v) -replace 'v','' -split '\.'
        return [int]$ver[0] -ge $NodeMinVer
    } catch {
        return $false
    }
}

if (Test-NodeVersion) {
    Write-Ok "Node.js $(node -v) detecte"
} else {
    Write-Warn "Node.js >= $NodeMinVer requis mais non trouve."
    Write-Info "Installation de Node.js..."

    try {
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    } catch {
        Write-Info "winget indisponible, telechargement direct..."
        $NodeInstaller = "$env:TEMP\node-install.msi"
        Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v22.15.0/node-v22.15.0-x64.msi" -OutFile $NodeInstaller
        Start-Process msiexec.exe -ArgumentList "/i `"$NodeInstaller`" /quiet /norestart" -Wait
        Remove-Item $NodeInstaller -Force
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    }

    if (Test-NodeVersion) {
        Write-Ok "Node.js $(node -v) installe"
    } else {
        Write-Fail "Echec. Installez Node.js manuellement : https://nodejs.org"
    }
}

# -- 2. Verifier / installer kubectl --
if (Get-Command kubectl -ErrorAction SilentlyContinue) {
    Write-Ok "kubectl detecte"
} else {
    Write-Warn "kubectl non trouve. Installation..."
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    try {
        winget install Kubernetes.kubectl --accept-source-agreements --accept-package-agreements --silent
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    } catch {
        $KubectlUrl = "https://dl.k8s.io/release/v1.32.0/bin/windows/amd64/kubectl.exe"
        Invoke-WebRequest -UseBasicParsing -Uri $KubectlUrl -OutFile "$InstallDir\kubectl.exe"
    }

    if ((Get-Command kubectl -ErrorAction SilentlyContinue) -or (Test-Path "$InstallDir\kubectl.exe")) {
        Write-Ok "kubectl installe"
    } else {
        Write-Fail "Echec. Installez kubectl manuellement : https://kubernetes.io/docs/tasks/tools/"
    }
}

# -- 3. Telecharger l'outil --
Write-Info "Telechargement de WGF Support Shell..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri $DownloadUrl -OutFile $BinFile

Write-Ok "Outil telecharge"

# -- 4. Creer le wrapper .cmd --
$WrapperContent = "@echo off`r`nset `"TOOL_DIR=%~dp0`"`r`nset `"PATH=%TOOL_DIR%;%PATH%`"`r`nnode `"%TOOL_DIR%wgf-support.cjs`" %*"
Set-Content -Path $Wrapper -Value $WrapperContent -Encoding ASCII

# -- 5. Ajouter au PATH utilisateur --
$UserPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*\.wgf-support-tool*") {
    [System.Environment]::SetEnvironmentVariable("Path", "$InstallDir;$UserPath", "User")
    $env:Path = "$InstallDir;$env:Path"
    Write-Warn "PATH mis a jour."
} else {
    Write-Info "PATH deja configure"
}

Write-Host ""
Write-Host "  ---------------------------------"
Write-Ok "Installation terminee !"
Write-Host ""
Write-Info "Dossier : $InstallDir"
Write-Info "Placez le fichier .env fourni par votre admin dans ce dossier."
Write-Host ""
Write-Warn "Redemarrez votre terminal, puis lancez : wgf-support"
Write-Host ""
