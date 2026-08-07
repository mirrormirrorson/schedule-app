param(
  [string]$Repository = 'mirrormirrorson/schedule-app-backups',
  [string]$Destination = (Join-Path $PSScriptRoot '..\production-backups\github-mirror')
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\production-backups'))
$resolvedDestination = [System.IO.Path]::GetFullPath($Destination)
if (-not $resolvedDestination.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Destination must stay inside production-backups.'
}

$token = $env:GITHUB_BACKUP_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) { throw 'GITHUB_BACKUP_TOKEN is required for the private backup repository.' }
$headers = @{
  Authorization = "Bearer $token"
  Accept = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
}
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases?per_page=100" -Headers $headers |
  Where-Object { $_.tag_name -like 'db-backup-*' } |
  Sort-Object created_at -Descending |
  Select-Object -First 1
if (-not $release) { throw 'No db-backup release exists yet.' }

$target = Join-Path $resolvedDestination $release.tag_name
New-Item -ItemType Directory -Path $target -Force | Out-Null
$downloadHeaders = $headers.Clone()
$downloadHeaders['Accept'] = 'application/octet-stream'
foreach ($asset in $release.assets | Where-Object { $_.name -like '*.json' -or $_.name -like '*.sab' }) {
  $output = Join-Path $target $asset.name
  if (-not (Test-Path -LiteralPath $output)) {
    Invoke-WebRequest -Uri $asset.url -Headers $downloadHeaders -OutFile $output
  }
}

Write-Output ([pscustomobject]@{
  ok = $true
  tag = $release.tag_name
  localPath = $target
} | ConvertTo-Json -Compress)
