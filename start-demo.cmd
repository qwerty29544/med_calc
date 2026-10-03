@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Установите Node.js 24.21.0. Инструкция находится в README.md.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Сначала выполните pnpm install --frozen-lockfile и pnpm db:generate.
  pause
  exit /b 1
)
node scripts/dev.mjs
pause
