@echo off
rem kindgiw: runs the Kindgi CLI this pack pins ("cli" in kindgi.config.json),
rem as mvnw runs the Maven it pins. Written by `kindgi init`; `kindgi upgrade`
rem moves the pin. From npm (npx) with Node, else from PyPI (uvx).
setlocal
set "KINDGIW_DIR=%~dp0"
set "KINDGIW_VERSION="
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Content -Raw -LiteralPath '%KINDGIW_DIR%kindgi.config.json' | ConvertFrom-Json).cli"`) do set "KINDGIW_VERSION=%%v"
if "%KINDGIW_VERSION%"=="" (
  echo kindgiw: no "cli" version in %KINDGIW_DIR%kindgi.config.json ^(kindgi upgrade writes it^). 1>&2
  exit /b 1
)
rem `call`: npx is a batch file, and a batch file run without it never returns.
where node >nul 2>nul && where npx >nul 2>nul && (
  call npx --yes "@kindgi/cli@%KINDGIW_VERSION%" %*
  exit /b
)
set "KINDGIW_PEP440=%KINDGIW_VERSION:-alpha.=a%"
set "KINDGIW_PEP440=%KINDGIW_PEP440:-beta.=b%"
set "KINDGIW_PEP440=%KINDGIW_PEP440:-rc.=rc%"
where uvx >nul 2>nul && (
  call uvx --from "kindgi-cli==%KINDGIW_PEP440%" kindgi %*
  exit /b
)
echo kindgiw: the Kindgi CLI %KINDGIW_VERSION% runs with Node 22.12 or later ^(https://nodejs.org^), 1>&2
echo   or with uv ^(https://docs.astral.sh/uv/getting-started/installation/^), which needs no Node. 1>&2
echo   Install either one, then run kindgiw again. 1>&2
exit /b 1
