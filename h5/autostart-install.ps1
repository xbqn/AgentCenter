#Requires -Version 5.1
<#
.SYNOPSIS
    Register / unregister AgentCenter H5 autostart for the current user.

.DESCRIPTION
    Default mode creates a shortcut in the user's Startup folder that runs
    start-h5.cmd hidden at logon. No administrator rights required.

    -Task      use Task Scheduler instead (adds ~30s logon delay).
    -Uninstall remove shortcut and scheduled task.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File autostart-install.ps1
    powershell -ExecutionPolicy Bypass -File autostart-install.ps1 -Task
    powershell -ExecutionPolicy Bypass -File autostart-install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Task,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $here 'start-h5.cmd'
$startup = [Environment]::GetFolderPath('Startup')
$shortcut = Join-Path $startup 'AgentCenter H5.lnk'
$taskName = 'AgentCenterH5'

function Remove-All {
    if (Test-Path -LiteralPath $shortcut) {
        Remove-Item -LiteralPath $shortcut -Force
        Write-Host "[OK] Startup shortcut removed: $shortcut"
    } else {
        Write-Host "[--] No startup shortcut found."
    }

    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "[OK] Scheduled task removed: $taskName"
    } else {
        Write-Host "[--] No scheduled task found."
    }
}

if ($Uninstall) {
    Remove-All
    exit 0
}

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Launcher not found: $launcher"
}

if ($Task) {
    $action  = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $here
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $trigger.Delay = 'PT30S'
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
        -Description 'Start AgentCenter H5 local service (127.0.0.1:7788) at logon' -Force | Out-Null
    Write-Host "[OK] Scheduled task registered: $taskName (runs 30s after logon)"
    Write-Host "     Remove with: autostart-install.ps1 -Uninstall"
    exit 0
}

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($shortcut)
$lnk.TargetPath       = $launcher
$lnk.WorkingDirectory = $here
$lnk.WindowStyle      = 7          # minimized
$lnk.Description      = 'AgentCenter H5 local service'
$lnk.Save()

Write-Host "[OK] Startup shortcut installed:"
Write-Host "     $shortcut"
Write-Host "     Target: $launcher"
Write-Host ""
Write-Host "Next logon will start the service at http://127.0.0.1:7788/ automatically."
Write-Host "Remove with: powershell -ExecutionPolicy Bypass -File autostart-install.ps1 -Uninstall"
