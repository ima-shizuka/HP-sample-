@echo off
cd /d "%~dp0"
title 学童 給与予測 自動転記

rem --- Python の確認 ---
where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Python が見つかりません。
  echo  https://www.python.org/downloads/windows/ からインストールし、
  echo  インストーラの最初の画面で「Add python.exe to PATH」にチェックを
  echo  入れてから、パソコンを再起動して、もう一度この「開始」を押してください。
  echo.
  pause
  exit /b 1
)

rem --- 必要なライブラリ(openpyxl)の確認。無ければ自動で入れる ---
python -c "import openpyxl" >nul 2>nul
if errorlevel 1 (
  echo 初回の準備をしています。少しお待ちください...
  python -m pip install -r requirements.txt
)

python -m kyuyo wizard
echo.
pause
