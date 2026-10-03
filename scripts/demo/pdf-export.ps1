<#
===================================================================
 potbot -- WF-089 PDF export / WF-090 print handoff (real engine, opt-in)

 Drives the *real* end-to-end chain against the machine's only measured
 PDF layout engine: Microsoft Word 16.0.20430 via COM (ExportAsFixedFormat).
 Daily tests never touch Word; this script is the explicit opt-in.

 WHAT IT DOES
   1. python  : build a multi-page DOCX whose footer carries PAGE/NUMPAGES fields
   2. node    : export it with the Word COM engine (apps/demo/rendering)
   3. python  : read the PDF back independently with pypdf (pages + footer text)
   4. shell   : hand the PDF to the system's default handler  -> "handed off" ONLY
                (this opens your default PDF viewer; nothing is printed)

 WHAT IT DOES **NOT** DO
   * It never claims paper was printed. State stops at "handed off".
   * It says nothing about Android. The mobile PDF/print path is unimplemented
     and unverified (no PrintManager in MainActivity).

 Exits with the vitest exit code. Evidence lands under
   .dev-evidence/word-common-features/WCF-20261002-A/D53/real/
===================================================================
#>
[CmdletBinding()]
param(
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
    Write-Host 'Usage: scripts\demo\pdf-export.cmd [-Help]'
    Write-Host 'Runs the opt-in real Word COM PDF-export + print-handoff acceptance test.'
    exit 0
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $repoRoot

$env:POTBOT_PDF_REAL_ENGINE = '1'
if (-not $env:POTBOT_PDF_REPORT_DIR) {
    $env:POTBOT_PDF_REPORT_DIR = Join-Path $env:TEMP 'potbot-pdf-export'
}

Write-Host '== WF-089/WF-090 real-engine run (Microsoft Word COM) =='
Write-Host "repo        : $repoRoot"
Write-Host "engine      : $env:POTBOT_PDF_REAL_ENGINE (opt-in flag)"
Write-Host "report dir  : $env:POTBOT_PDF_REPORT_DIR"
Write-Host ''

& node 'node_modules/vitest/vitest.mjs' run --configLoader native `
    'tests/word-acceptance/pdf/word-com-optin.test.ts'
$code = $LASTEXITCODE

Write-Host ''
Write-Host "vitest exit code = $code"
Write-Host ''
Write-Host 'Residual Word processes started by this run are killed by PID inside the engine'
Write-Host 'script (taskkill /F /PID <word_pid>, recorded in the report JSON).'
Write-Host 'This run does NOT print anything.'

exit $code
