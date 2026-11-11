#!/usr/bin/env bash
# ============================================================
#  diagnostico-pc.sh — juntá la info de tu PC para armar Gentoo a medida
#  USO: ejecutalo en tu PC (Linux, Windows con Git Bash/WSL, o Mac)
#       ./diagnostico-pc.sh
#  Genera: diagnostico.txt  → subilo a Google Drive o pegalo en el chat
#  NO pide contraseñas, NO toca nada, solo LEE info del sistema.
# ============================================================
set -u

OUT="diagnostico.txt"
{
  echo "=================================================="
  echo " DIAGNÓSTICO DE PC — para Gentoo a medida"
  echo " Fecha: $(date -Iseconds 2>/dev/null || date)"
  echo "=================================================="
  echo

  echo "--- Sistema operativo ---"
  uname -a 2>/dev/null || echo "(no disponible)"
  cat /etc/os-release 2>/dev/null || cat /etc/lsb-release 2>/dev/null || echo "(no disponible)"
  echo

  echo "--- CPU ---"
  lscpu 2>/dev/null | grep -E "Model name|^CPU\(s\)|Architecture|Thread|Core" || \
    grep -m1 "model name" /proc/cpuinfo 2>/dev/null || echo "(no disponible)"
  echo

  echo "--- RAM ---"
  free -h 2>/dev/null || vm_stat 2>/dev/null || echo "(no disponible)"
  echo

  echo "--- Discos ---"
  lsblk -o NAME,SIZE,TYPE,MOUNTPOINT 2>/dev/null || df -h 2>/dev/null || echo "(no disponible)"
  echo

  echo "--- GPU / Video ---"
  lspci 2>/dev/null | grep -i -E "vga|3d|display" || \
    system_profiler SPDisplaysDataType 2>/dev/null | head -n 30 || echo "(no disponible)"
  echo

  echo "--- Red ---"
  ip -brief addr 2>/dev/null || ifconfig 2>/dev/null | head -n 20 || echo "(no disponible)"
  echo

  echo "--- USB / dispositivos ---"
  lsusb 2>/dev/null | head -n 20 || echo "(no disponible)"
  echo

  echo "--- Boot / firmware ---"
  [ -d /sys/firmware/efi ] && echo "UEFI (EFI)" || echo "BIOS (legacy)"
  echo

  echo "=================================================="
  echo " Fin. Subí este archivo a Google Drive o pegalo en el chat."
  echo "=================================================="
} | tee "$OUT"

echo
echo "✅ Listo: se generó '$OUT'. Ahora subilo a Drive o pegalo en el chat."
