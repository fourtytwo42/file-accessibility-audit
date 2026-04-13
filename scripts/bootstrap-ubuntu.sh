#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_ENV_TEMPLATE="$ROOT_DIR/apps/api/.env.example.local"
API_ENV_FILE="$ROOT_DIR/apps/api/.env"
WEB_ENV_TEMPLATE="$ROOT_DIR/apps/web/.env.example.local"
WEB_ENV_FILE="$ROOT_DIR/apps/web/.env"
VERIFY_SCRIPT="$ROOT_DIR/scripts/verify-env.sh"

LOCAL_TOOLS_DIR="$ROOT_DIR/.local-tools"
PYTHON_VENV_DIR="$LOCAL_TOOLS_DIR/python"
VERAPDF_ROOT="$LOCAL_TOOLS_DIR/verapdf"
VERAPDF_INSTALL_DIR="$VERAPDF_ROOT/current"
LEGACY_FONT_DIR="$LOCAL_TOOLS_DIR/fonts/legacy"

PYTHON_BIN_DEFAULT="$PYTHON_VENV_DIR/bin/python"
VERAPDF_DOWNLOAD_URL="${VERAPDF_DOWNLOAD_URL:-https://software.verapdf.org/rel/1.28/verapdf-pdfbox-1.28.2-installer.zip}"
IBM_PLEX_ARCHIVE_URL="${IBM_PLEX_ARCHIVE_URL:-https://github.com/IBM/plex/archive/refs/heads/master.zip}"
SOURCE_SANS_ARCHIVE_URL="${SOURCE_SANS_ARCHIVE_URL:-https://github.com/adobe-fonts/source-sans/releases/download/3.052R/OTF-source-sans-3.052R.zip}"
LIBRE_BASKERVILLE_ARCHIVE_URL="${LIBRE_BASKERVILLE_ARCHIVE_URL:-https://github.com/impallari/Libre-Baskerville/archive/refs/heads/master.zip}"
LIBERTINUS_ARCHIVE_URL="${LIBERTINUS_ARCHIVE_URL:-https://github.com/alerque/libertinus/releases/download/v7.050/Libertinus-7.050.tar.zst}"

VERIFY_ONLY=0
RUN_SMOKE_API=0
SKIP_PLAYWRIGHT=0

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-ubuntu.sh [--verify-only] [--smoke-api] [--skip-playwright]

Bootstraps a fresh Ubuntu 24.04 VM for the remediation-capable app.

Options:
  --verify-only     Skip installation and run the environment verification only.
  --smoke-api       Run the verification smoke test that starts the API temporarily.
  --skip-playwright Skip Chromium browser installation.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify-only)
      VERIFY_ONLY=1
      ;;
    --smoke-api)
      RUN_SMOKE_API=1
      ;;
    --skip-playwright)
      SKIP_PLAYWRIGHT=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

log() {
  printf '[bootstrap] %s\n' "$1"
}

fail() {
  printf '[bootstrap] ERROR: %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command not found: $1"
  fi
}

apt_install() {
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
}

ensure_ubuntu_2404() {
  [[ -r /etc/os-release ]] || fail "/etc/os-release is missing."
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || fail "This bootstrap supports Ubuntu only."
  if [[ "${VERSION_ID:-}" != "24.04" && "${ALLOW_UNSUPPORTED_UBUNTU:-0}" != "1" ]]; then
    fail "Expected Ubuntu 24.04. Set ALLOW_UNSUPPORTED_UBUNTU=1 to override."
  fi
}

ensure_sudo() {
  if ! command -v sudo >/dev/null 2>&1; then
    fail "sudo is required to install system dependencies."
  fi
  if ! sudo -v; then
    fail "sudo access is required to continue."
  fi
}

copy_if_missing() {
  local template_file="$1"
  local destination_file="$2"
  if [[ ! -f "$destination_file" ]]; then
    cp "$template_file" "$destination_file"
  fi
}

upsert_env_value() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  local escaped_value
  escaped_value="$(printf '%s' "$value" | sed 's/[\/&]/\\&/g')"
  if grep -q "^${key}=" "$env_file"; then
    sed -i "s/^${key}=.*/${key}=${escaped_value}/" "$env_file"
  else
    printf '\n%s=%s\n' "$key" "$value" >>"$env_file"
  fi
}

download_to() {
  local url="$1"
  local output_file="$2"
  log "Downloading $url"
  curl -fL --retry 3 --retry-delay 2 -o "$output_file" "$url"
}

extract_zip() {
  local archive_file="$1"
  local destination_dir="$2"
  rm -rf "$destination_dir"
  mkdir -p "$destination_dir"
  unzip -oq "$archive_file" -d "$destination_dir"
}

extract_tar_zst() {
  local archive_file="$1"
  local destination_dir="$2"
  rm -rf "$destination_dir"
  mkdir -p "$destination_dir"
  tar --zstd -xf "$archive_file" -C "$destination_dir"
}

find_one() {
  local root_dir="$1"
  local filename="$2"
  find "$root_dir" -type f -name "$filename" | head -n 1
}

find_one_ci() {
  local root_dir="$1"
  local filename="$2"
  find "$root_dir" -type f -iname "$filename" | head -n 1
}

copy_font_file() {
  local source_file="$1"
  local target_name="$2"
  [[ -f "$source_file" ]] || fail "Required font file not found: $source_file"
  install -m 0644 "$source_file" "$LEGACY_FONT_DIR/$target_name"
}

copy_downloaded_font() {
  local search_root="$1"
  local filename="$2"
  local found
  found="$(find_one "$search_root" "$filename")"
  [[ -n "$found" ]] || fail "Could not locate $filename in $search_root"
  copy_font_file "$found" "$filename"
}

copy_downloaded_font_alias() {
  local search_root="$1"
  local target_name="$2"
  shift 2
  local source_name found=''
  for source_name in "$@"; do
    found="$(find_one_ci "$search_root" "$source_name")"
    if [[ -n "$found" ]]; then
      copy_font_file "$found" "$target_name"
      return 0
    fi
  done
  fail "Could not locate any of [$*] in $search_root"
}

copy_system_font_alias() {
  local search_root="$1"
  local target_name="$2"
  shift 2
  local source_name found=''
  for source_name in "$@"; do
    found="$(find_one_ci "$search_root" "$source_name")"
    if [[ -n "$found" ]]; then
      copy_font_file "$found" "$target_name"
      return 0
    fi
  done
  fail "Could not locate any of [$*] in $search_root"
}

install_system_packages() {
  log "Installing apt packages"
  sudo apt-get update
  apt_install software-properties-common ca-certificates curl gnupg unzip zip zstd fontconfig build-essential \
    python3 python3-pip python3-venv python3-dev libqpdf-dev qpdf openjdk-17-jre-headless \
    cabextract xfonts-utils fonts-crosextra-carlito \
    libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2t64 \
    libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0t64 libnspr4 libnss3 \
    libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxkbcommon0 libxrandr2 xvfb

  sudo add-apt-repository -y multiverse >/dev/null
  sudo apt-get update
  echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | sudo debconf-set-selections
  echo "ttf-mscorefonts-installer msttcorefonts/present-mscorefonts-eula note" | sudo debconf-set-selections
  apt_install ttf-mscorefonts-installer
}

install_node_and_pnpm() {
  if command -v node >/dev/null 2>&1; then
    local current_version current_major
    current_version="$(node -v)"
    current_major="${current_version#v}"
    current_major="${current_major%%.*}"
    if [[ "$current_major" =~ ^[0-9]+$ ]] && (( current_major >= 22 )); then
      log "Node.js already satisfies the version requirement: $current_version"
    else
      log "Installing Node.js 22.x"
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      apt_install nodejs
    fi
  else
    log "Installing Node.js 22.x"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    apt_install nodejs
  fi

  if command -v corepack >/dev/null 2>&1; then
    corepack enable
    corepack prepare pnpm@latest --activate
  else
    npm install -g pnpm
  fi
}

setup_python_runtime() {
  log "Creating Python virtual environment"
  mkdir -p "$LOCAL_TOOLS_DIR"
  python3 -m venv "$PYTHON_VENV_DIR"
  "$PYTHON_BIN_DEFAULT" -m pip install --upgrade pip
  "$PYTHON_BIN_DEFAULT" -m pip install -r "$ROOT_DIR/apps/api/scripts/requirements.txt"
}

install_repo_dependencies() {
  log "Installing pnpm workspace dependencies"
  (
    cd "$ROOT_DIR"
    pnpm install
  )
}

install_playwright() {
  if (( SKIP_PLAYWRIGHT == 1 )); then
    log "Skipping Playwright installation"
    return
  fi

  log "Installing Playwright Chromium"
  (
    cd "$ROOT_DIR"
    pnpm --filter api exec playwright install chromium
  )
}

install_verapdf() {
  log "Installing veraPDF into $VERAPDF_INSTALL_DIR"
  rm -rf "$VERAPDF_ROOT"
  mkdir -p "$VERAPDF_ROOT"

  local tmp_dir installer_zip installer_extract auto_install_xml
  tmp_dir="$(mktemp -d)"
  installer_zip="$tmp_dir/verapdf-installer.zip"
  installer_extract="$tmp_dir/extracted"
  auto_install_xml="$tmp_dir/auto-install.xml"

  download_to "$VERAPDF_DOWNLOAD_URL" "$installer_zip"
  extract_zip "$installer_zip" "$installer_extract"

  cat >"$auto_install_xml" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<AutomatedInstallation langpack="eng">
  <com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="HTMLHelloPanel"/>
  <com.izforge.izpack.panels.target.TargetPanel id="TargetPanel">
    <installpath>${VERAPDF_INSTALL_DIR}</installpath>
  </com.izforge.izpack.panels.target.TargetPanel>
  <com.izforge.izpack.panels.packs.PacksPanel id="PacksPanel">
    <pack index="0" name="GUI" selected="true"/>
    <pack index="1" name="Mac OSX Application Bundle" selected="false"/>
    <pack index="2" name="Mac and *nix Scripts" selected="true"/>
    <pack index="3" name="Validation model" selected="true"/>
    <pack index="4" name="Documentation" selected="true"/>
    <pack index="5" name="Sample Plugins" selected="false"/>
  </com.izforge.izpack.panels.packs.PacksPanel>
  <com.izforge.izpack.panels.install.InstallPanel id="InstallPanel"/>
  <com.izforge.izpack.panels.finish.FinishPanel id="FinishPanel"/>
</AutomatedInstallation>
EOF

  (
    cd "$installer_extract"/verapdf-pdfbox-* || exit 1
    chmod +x verapdf-install
    ./verapdf-install "$auto_install_xml"
  )

  [[ -x "$VERAPDF_INSTALL_DIR/bin/verapdf" ]] || fail "veraPDF installation completed without a usable bin/verapdf."
}

install_legacy_fonts() {
  log "Preparing local legacy font bundle at $LEGACY_FONT_DIR"
  rm -rf "$LEGACY_FONT_DIR"
  mkdir -p "$LEGACY_FONT_DIR"

  local ms_fonts_root carlito_root
  ms_fonts_root="$(find /usr/share/fonts -type d -path '*msttcorefonts' | head -n 1 || true)"
  [[ -n "$ms_fonts_root" ]] || fail "Microsoft core fonts were not installed."

  copy_system_font_alias "$ms_fonts_root" "arial.ttf" "arial.ttf" "Arial.ttf"
  copy_system_font_alias "$ms_fonts_root" "arialbd.ttf" "arialbd.ttf" "Arial_Bold.ttf"
  copy_system_font_alias "$ms_fonts_root" "ariali.ttf" "ariali.ttf" "Arial_Italic.ttf"
  copy_system_font_alias "$ms_fonts_root" "arialbi.ttf" "arialbi.ttf" "Arial_Bold_Italic.ttf"
  copy_system_font_alias "$ms_fonts_root" "verdana.ttf" "verdana.ttf" "Verdana.ttf"
  copy_system_font_alias "$ms_fonts_root" "verdanab.ttf" "verdanab.ttf" "Verdana_Bold.ttf"
  copy_system_font_alias "$ms_fonts_root" "times.ttf" "times.ttf" "Times_New_Roman.ttf"
  copy_system_font_alias "$ms_fonts_root" "timesbd.ttf" "timesbd.ttf" "Times_New_Roman_Bold.ttf"
  copy_system_font_alias "$ms_fonts_root" "timesi.ttf" "timesi.ttf" "Times_New_Roman_Italic.ttf"
  copy_system_font_alias "$ms_fonts_root" "timesbi.ttf" "timesbi.ttf" "Times_New_Roman_Bold_Italic.ttf"

  carlito_root="$(find /usr/share/fonts -type d -iname '*carlito*' | head -n 1 || true)"
  [[ -n "$carlito_root" ]] || fail "Carlito fonts were not installed."
  copy_font_file "$(find_one_ci "$carlito_root" 'Carlito-Regular.ttf')" "calibri.ttf"
  copy_font_file "$(find_one_ci "$carlito_root" 'Carlito-Bold.ttf')" "calibrib.ttf"

  local tmp_dir ibm_zip source_zip libre_zip libertinus_archive
  tmp_dir="$(mktemp -d)"
  ibm_zip="$tmp_dir/ibm-plex.zip"
  source_zip="$tmp_dir/source-sans.zip"
  libre_zip="$tmp_dir/libre-baskerville.zip"
  libertinus_archive="$tmp_dir/libertinus.tar.zst"

  download_to "$IBM_PLEX_ARCHIVE_URL" "$ibm_zip"
  download_to "$SOURCE_SANS_ARCHIVE_URL" "$source_zip"
  download_to "$LIBRE_BASKERVILLE_ARCHIVE_URL" "$libre_zip"
  download_to "$LIBERTINUS_ARCHIVE_URL" "$libertinus_archive"

  extract_zip "$ibm_zip" "$tmp_dir/ibm"
  extract_zip "$source_zip" "$tmp_dir/source"
  extract_zip "$libre_zip" "$tmp_dir/libre"
  extract_tar_zst "$libertinus_archive" "$tmp_dir/libertinus"

  copy_downloaded_font_alias "$tmp_dir/ibm" "IBMPlexSans-Regular.otf" "IBMPlexSans-Regular.otf" "IBMPlexSans-Regular.ttf"
  copy_downloaded_font_alias "$tmp_dir/ibm" "IBMPlexSans-Bold.otf" "IBMPlexSans-Bold.otf" "IBMPlexSans-Bold.ttf"
  copy_downloaded_font_alias "$tmp_dir/ibm" "IBMPlexSans-Italic.otf" "IBMPlexSans-Italic.otf" "IBMPlexSans-Italic.ttf"
  copy_downloaded_font_alias "$tmp_dir/ibm" "IBMPlexSans-Light.otf" "IBMPlexSans-Light.otf" "IBMPlexSans-Light.ttf"

  copy_downloaded_font "$tmp_dir/source" "SourceSans3-Regular.otf"
  copy_downloaded_font "$tmp_dir/source" "SourceSans3-It.otf"
  copy_downloaded_font "$tmp_dir/source" "SourceSans3-Bold.otf"
  copy_downloaded_font "$tmp_dir/source" "SourceSans3-Black.otf"
  copy_downloaded_font "$tmp_dir/source" "SourceSans3-Light.otf"

  copy_downloaded_font "$tmp_dir/libre" "LibreBaskerville-Regular.ttf"
  copy_downloaded_font "$tmp_dir/libre" "LibreBaskerville-Italic.ttf"
  copy_downloaded_font "$tmp_dir/libre" "LibreBaskerville-Bold.ttf"

  copy_downloaded_font "$tmp_dir/libertinus" "LibertinusSans-Regular.otf"
  copy_downloaded_font "$tmp_dir/libertinus" "LibertinusSans-Bold.otf"
  copy_downloaded_font "$tmp_dir/libertinus" "LibertinusSans-Italic.otf"
  copy_downloaded_font "$tmp_dir/libertinus" "LibertinusSerif-Regular.otf"
  copy_downloaded_font "$tmp_dir/libertinus" "LibertinusSerif-Italic.otf"
  copy_downloaded_font "$tmp_dir/libertinus" "LibertinusSerif-Bold.otf"
  copy_downloaded_font "$tmp_dir/libertinus" "LibertinusSerif-BoldItalic.otf"
}

write_env_files() {
  log "Writing environment files"
  copy_if_missing "$API_ENV_TEMPLATE" "$API_ENV_FILE"
  copy_if_missing "$WEB_ENV_TEMPLATE" "$WEB_ENV_FILE"

  local java_bin
  java_bin="$(readlink -f "$(command -v java)")"
  upsert_env_value "$API_ENV_FILE" "PYTHON_PATH" "$PYTHON_BIN_DEFAULT"
  upsert_env_value "$API_ENV_FILE" "PDF_FONT_DIRS" "$LEGACY_FONT_DIR"
  upsert_env_value "$API_ENV_FILE" "LEGACY_FONT_DIRS" "$LEGACY_FONT_DIR"
  upsert_env_value "$API_ENV_FILE" "VERAPDF_PATH" "$VERAPDF_INSTALL_DIR/bin/verapdf"
  upsert_env_value "$API_ENV_FILE" "JAVACMD" "$java_bin"
}

run_verification() {
  local args=()
  (( RUN_SMOKE_API == 1 )) && args+=("--smoke-api")
  "$VERIFY_SCRIPT" "${args[@]}"
}

main() {
  ensure_ubuntu_2404
  ensure_sudo
  require_cmd curl
  require_cmd unzip
  require_cmd tar

  if (( VERIFY_ONLY == 1 )); then
    run_verification
    return
  fi

  install_system_packages
  install_node_and_pnpm
  setup_python_runtime
  install_repo_dependencies
  install_playwright
  install_verapdf
  install_legacy_fonts
  write_env_files
  run_verification
  log "Bootstrap complete. Start the app with: pnpm dev"
}

main "$@"
