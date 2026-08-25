@echo off
cd /d "%~dp0"
title �w�� ���^�\�� �����]�L

rem --- Python �̊m�F ---
where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Python ��������܂���B
  echo  https://www.python.org/downloads/windows/ ����C���X�g�[�����A
  echo  �C���X�g�[���̍ŏ��̉�ʂŁuAdd python.exe to PATH�v�Ƀ`�F�b�N��
  echo  ����Ă���A�p�\�R�����ċN�����āA������x���́u�J�n�v�������Ă��������B
  echo.
  pause
  exit /b 1
)

rem --- �K�v�ȃ��C�u����(openpyxl)�̊m�F�B������Ύ����œ���� ---
python -c "import openpyxl" >nul 2>nul
if errorlevel 1 (
  echo ����̏��������Ă��܂��B�������҂���������...
  python -m pip install -r requirements.txt
)

rem --- config.json があれば使う（from_day と area を自動で取得） ---
if exist config.json (
  python -m kyuyo --config config.json wizard
) else (
  python -m kyuyo wizard
)
echo.
pause
