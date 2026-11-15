@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo  ModCatalog - push everything to live
echo  1. tests  2. commit  3. push (Pages)  4. wrangler  5. wait
echo ============================================================

echo.
echo [1/5] Tests
node --check site\upload-flow.js
node --check site\upload-lib.js
node --check site\upload-editor.js
node --check site\catalog-lib.js
node --check site\zip-lib.js
node --check site\trailer.js
node --check site\modal.js
node --check worker\src\index.js
if errorlevel 1 goto :fail
pushd worker
node --test "test/*.test.js"
if errorlevel 1 (
    popd
    goto :fail
)
popd
python -m unittest discover -s tests
if errorlevel 1 goto :fail
echo Tests passed.

echo.
echo [2/5] Commit
git add -u
git reset -q -- site/site-preview.log
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "Deploy to live: site + worker updates"
    if errorlevel 1 goto :fail
) else (
    echo No changes to commit.
)

echo.
echo [3/5] Rebase + push (a site/** push triggers the Pages deploy)
set "STASHED="
git diff --quiet -- site/site-preview.log || (git stash push -q -- site/site-preview.log && set "STASHED=1")
git fetch origin
git rebase origin/main
if errorlevel 1 goto :fail
git push origin main
if errorlevel 1 goto :fail
if defined STASHED git stash pop -q

echo.
echo [4/5] Deploy the Cloudflare Worker
pushd worker
npx wrangler deploy
if errorlevel 1 (
    popd
    goto :fail
)
popd

echo.
echo [5/5] Wait for the GitHub Pages deploy
>cred.txt (echo protocol=https& echo host=github.com)
git-credential-manager get <cred.txt > _gh.cred 2>nul
del cred.txt 2>nul
set "GH_TOKEN="
for /f "usebackq delims=" %%t in ('findstr /b "password=" _gh.cred') do set "GH_TOKEN=%%t"
del _gh.cred 2>nul
if not defined GH_TOKEN (
    echo No GitHub token found; check the Pages deploy manually:
    echo   https://github.com/jordgubbarnab55-cloud/ModCatalog/actions
    goto :done
)
set "RUNID="
for /f "delims=" %%r in ('gh run list --workflow deploy-site.yml --limit 1 --json databaseId --jq ".[0].databaseId"') do set "RUNID=%%r"
if not defined RUNID goto :done
echo Workflow run %RUNID%:
gh run watch %RUNID% --exit-status
if errorlevel 1 goto :fail

:done
echo.
echo Done.
echo   Site:   https://jordgubbarnab55-cloud.github.io/ModCatalog/
echo   Worker: https://modcatalog.modcatalog-worker.workers.dev
pause
exit /b 0

:fail
echo.
echo *** FAILED - see the error above ***
pause
exit /b 1
