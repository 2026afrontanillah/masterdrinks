@echo off
REM ============================================================
REM  MasterDrinks POS  -  arrancar el servidor
REM  Haz doble clic. No hace falta escribir nada.
REM ============================================================
title MasterDrinks POS

REM  Nos ponemos SIEMPRE en la carpeta de este archivo, sin importar
REM  desde donde se lance. Este era el fallo: al abrir la terminal
REM  empieza en C:\Users\adri5 y npm no encontraba el proyecto.
cd /d "%~dp0"

echo.
echo  Carpeta del proyecto: %cd%
echo.

if not exist "package.json" (
  echo  ============================================
  echo   ERROR: aqui no esta el proyecto.
  echo   Este archivo tiene que quedarse en la misma
  echo   carpeta que server.js y package.json.
  echo  ============================================
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo  Primera vez: instalando dependencias, espera un momento...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  ============================================
    echo   No se pudieron instalar las dependencias.
    echo   Revisa que haya internet y vuelve a intentar.
    echo  ============================================
    echo.
    pause
    exit /b 1
  )
  echo.
)

node server.js

REM  Si el servidor termina (por error o con Ctrl+C) la ventana se queda
REM  abierta para poder leer el mensaje, en vez de cerrarse de golpe.
echo.
echo  ============================================
echo   El servidor se detuvo.
echo  ============================================
echo.
pause
