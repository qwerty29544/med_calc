param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
function Test-DockerReady {
    $ErrorActionPreference = 'Continue'
    docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}
function Test-ExistingDatabaseVolume {
    $ErrorActionPreference = 'Continue'
    docker volume inspect med-calc_postgres_data --format '{{.Name}}' 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}
try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker Desktop не установлен или отсутствует в PATH.'
    }
    if (-not (Test-DockerReady)) {
        Write-Host 'Запуск Docker Desktop...'
        $desktopPath = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
        if (-not (Test-Path -LiteralPath $desktopPath)) { throw 'Откройте Docker Desktop и повторите запуск.' }
        Start-Process -FilePath $desktopPath -WindowStyle Hidden
        $deadline = (Get-Date).AddMinutes(3)
        do {
            Start-Sleep -Seconds 3
            if (Test-DockerReady) { break }
        } while ((Get-Date) -lt $deadline)
        if (-not (Test-DockerReady)) { throw 'Docker Desktop не готов. Проверьте его состояние и повторите запуск.' }
    }
    if (-not (Test-Path -LiteralPath '.env.docker')) {
        if (Test-ExistingDatabaseVolume) { throw 'Volume базы уже существует, но .env.docker отсутствует. Восстановите прежний файл с паролем; новый пароль не подойдет к существующей базе.' }
        $bytes = New-Object byte[] 32
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $dbPassword = -join ($bytes | ForEach-Object { $_.ToString('x2') })
        "POSTGRES_PASSWORD=$dbPassword`nWEB_PORT=8080`n" | Set-Content -LiteralPath '.env.docker' -Encoding ASCII
        Write-Host 'Создан .env.docker с уникальным паролем базы.'
    }
    docker compose --env-file .env.docker up --build --detach --wait --wait-timeout 180
    if ($LASTEXITCODE -ne 0) { throw 'Ошибка запуска. Диагностика: docker compose --env-file .env.docker logs --tail 100' }
    $portLine = Get-Content -LiteralPath '.env.docker' | Where-Object { $_ -match '^WEB_PORT=\d+$' } | Select-Object -Last 1
    $webPort = if ($portLine) { ($portLine -split '=', 2)[1] } else { '8080' }
    $url = "http://localhost:$webPort"
    Write-Host "Готово: $url"
    Write-Host 'Демонстрационный вход: doctor / doctor-demo-2026'
    Write-Host 'Данные сохраняются в Docker volume med-calc_postgres_data.'
    if (-not $NoBrowser) { Start-Process $url }
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
