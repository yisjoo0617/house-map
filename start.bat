@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist .venv\Scripts\python.exe goto install

rem 업데이트로 requirements.txt가 바뀌었으면 패키지를 다시 설치한다 (.venv를 지울 필요 없음)
if not exist .venv\requirements.installed goto reinstall
fc /b requirements.txt .venv\requirements.installed >nul 2>nul
if errorlevel 1 goto reinstall
goto run

:install
echo ================================================
echo  House-Map 첫 실행: 필요한 프로그램을 설치합니다.
echo  인터넷 연결이 필요하고 몇 분 정도 걸립니다.
echo ================================================
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY goto nopython

%PY% -m venv .venv
if errorlevel 1 goto nopython
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto fail
copy /y requirements.txt .venv\requirements.installed >nul
goto run

:reinstall
echo ================================================
echo  House-Map 업데이트: 바뀐 프로그램을 설치합니다.
echo  인터넷 연결이 필요하고 잠시 걸립니다.
echo ================================================
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto updatefail
copy /y requirements.txt .venv\requirements.installed >nul

:run
.venv\Scripts\python.exe run.py
if errorlevel 1 pause
goto :eof

:nopython
echo.
echo Python을 찾을 수 없습니다.
echo https://www.python.org/downloads/ 에서 Python 3.12 이상을 설치하세요.
echo 설치 첫 화면에서 "Add python.exe to PATH"를 꼭 체크한 뒤 이 파일을 다시 실행하세요.
if exist .venv rmdir /s /q .venv
pause
goto :eof

:fail
echo.
echo 설치 중 오류가 발생했습니다. 위 메시지를 캡처해서 보내주세요.
if exist .venv rmdir /s /q .venv
pause
goto :eof

:updatefail
echo.
echo 업데이트 설치 중 오류가 발생했습니다. 인터넷 연결을 확인한 뒤 다시 실행하세요.
echo 계속 실패하면 .venv 폴더를 지우고 다시 실행하면 처음부터 설치합니다. (프로젝트는 data 폴더에 있어 그대로 남습니다)
pause
