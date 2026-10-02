#!/usr/bin/env bash
# Build Glint from source and install it to /Applications (macOS 14.2+). Run it again to update.
#
# One line, from anywhere:
#   curl -fsSL https://raw.githubusercontent.com/TeXtUtility/Glint/main/install.sh | bash
# From a checkout, it builds that checkout instead:
#   ./install.sh
# Downloaded, it builds main; GLINT_BRANCH picks another branch (Glint's beta updates set it to beta):
#   curl -fsSL https://raw.githubusercontent.com/TeXtUtility/Glint/beta/install.sh | GLINT_BRANCH=beta bash
# Glint's Update button also sets GLINT_COMMIT to the full commit it listed, so the build is exactly that one even if
# the branch has moved on since.
#
# Everything is inside main(), called on the last line, so bash reads the whole script before running any of it.
# Piped through `| bash`, a command that reads stdin could otherwise eat the rest of the script.
set -euo pipefail

REPO="TeXtUtility/Glint"
BRANCH="${GLINT_BRANCH:-main}"
COMMIT="${GLINT_COMMIT:-}"
# Empty when piped in. Read here: inside a function a piped script reports "main" instead.
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
CERT="Glint Signing"
# The signing key lives in a keychain of its own, locked except while an install signs, so no other app can sign as
# Glint and take over its Microphone, Screen Recording and keychain access. Its password is asked each install.
SIGNING_KC="$HOME/Library/Keychains/glint-signing.keychain-db"
# Before, the key sat in the login keychain, where any app could sign with it without asking.
OLD_CERT="Glint Local Dev"

die() { echo "error: $*" >&2; exit 1; }
step() { echo "==> $*"; }

cleanup_dirs=()
cleanup() {
  for d in "${cleanup_dirs[@]+"${cleanup_dirs[@]}"}"; do rm -rf "$d"; done
  if [[ -f "$SIGNING_KC" ]]; then security lock-keychain "$SIGNING_KC" 2>/dev/null || true; fi
}
trap cleanup EXIT

check_mac() {
  [[ "$(uname)" == Darwin ]] || die "Glint builds on macOS only for now."
  local os
  os="$(sw_vers -productVersion)"
  [[ "$(printf '%s\n' 14.2 "$os" | sort -V | head -1)" == 14.2 ]] || die "macOS 14.2 or later is needed (this Mac has $os)."
}

check_node() {
  if ! command -v node >/dev/null; then
    command -v brew >/dev/null || die "Node.js is not installed. Get version 22.18 or later from https://nodejs.org, then run this again."
    step "Installing Node.js with Homebrew"
    brew install node </dev/null
  fi
  # The build tools need 22.12; the tests need 22.18, the first 22 that runs TypeScript without a flag.
  [[ "$(printf '%s\n' 22.18 "$(node -p process.versions.node)" | sort -V | head -1)" == 22.18 ]] \
    || die "Node.js 22.18 or later is needed (found $(node -v)). Update it (brew upgrade node, or https://nodejs.org), then run this again."
}

# Build from the checkout this script sits in, or fetch a fresh copy when it was piped in.
enter_source() {
  # Piped in (`| bash`): always download, even when run from inside a checkout.
  local here=""
  if [[ -n "$SCRIPT_PATH" ]]; then here="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"; fi
  if [[ -n "$here" && -f "$here/package.json" ]] && grep -q '"name": "glint"' "$here/package.json"; then
    cd "$here"
    return
  fi
  # The macOS git is a stub until Apple's command line tools are installed.
  xcode-select -p >/dev/null 2>&1 || die "Apple's command line tools are needed first. Run: xcode-select --install, then run this again."
  local src
  src="$(mktemp -d)/Glint"
  cleanup_dirs+=("$(dirname "$src")")
  if [[ -n "$COMMIT" ]]; then
    step "Downloading Glint ($BRANCH at ${COMMIT:0:7})"
    # A clone only takes a branch's newest commit, so fetch this one by name.
    git init -q "$src"
    git -C "$src" fetch -q --depth 1 "https://github.com/$REPO.git" "$COMMIT" </dev/null \
      || die "couldn't download commit ${COMMIT:0:7} of Glint. If $BRANCH was rewritten since, check for updates again."
    git -C "$src" checkout -q FETCH_HEAD
    cd "$src"
    return
  fi
  step "Downloading Glint ($BRANCH)"
  git clone --depth 1 --quiet --branch "$BRANCH" "https://github.com/$REPO.git" "$src" </dev/null \
    || die "couldn't download Glint. Check the internet connection, then run this again."
  cd "$src"
}

# Quoted for `security -i`, which reads its commands from stdin, so a password never shows in the process list.
sec_quote() { local q=${1//\\/\\\\}; q=${q//\"/\\\"}; printf '"%s"' "$q"; }

# A dialog rather than the terminal: Glint's Update button runs this with no terminal to type in.
ask_password() {
  /usr/bin/osascript -e 'on run argv' \
    -e 'display dialog (item 1 of argv) default answer "" with hidden answer with title "Glint" buttons {"Cancel", "OK"} default button "OK"' \
    -e 'text returned of result' -e 'end run' "$1" 2>/dev/null
}

# codesign only finds identities in keychains on the search list.
add_to_search_list() {
  local list=() line
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"; line="${line#\"}"; line="${line%\"}"
    [[ "$line" == "$SIGNING_KC" ]] && return
    [[ -n "$line" ]] && list+=("$line")
  done < <(security list-keychains -d user)
  security list-keychains -d user -s "${list[@]+"${list[@]}"}" "$SIGNING_KC"
}

# macOS ties Microphone, Screen Recording and keychain grants to the signature's designated requirement. An ad-hoc
# signature changes it on every build; a fixed self-signed cert keeps it the same.
signing_pw=""
ensure_cert() {
  local login=~/Library/Keychains/login.keychain-db
  # The old key goes, so the signature Glint's keychain item still trusts can't be made by anyone.
  if security find-identity -p codesigning "$login" | grep -q "\"$OLD_CERT\""; then
    step "Removing the old \"$OLD_CERT\" certificate (any app could sign with it)"
    security delete-identity -c "$OLD_CERT" "$login" >/dev/null 2>&1 \
      || echo "warning: couldn't remove it. Delete \"$OLD_CERT\" in Keychain Access, under login > My Certificates." >&2
  fi
  if [[ -f "$SIGNING_KC" ]]; then add_to_search_list; return; fi

  step "Creating Glint's signing key (one time)"
  local pw again tmp
  pw="$(ask_password "Choose a password for Glint's signing key. Each install and update asks for it, so nothing installs as Glint without you. Your Mac password is fine.")" \
    || die "cancelled, so Glint wasn't installed."
  [[ -n "$pw" ]] || die "the password can't be empty. Run this again."
  again="$(ask_password "Type the password for Glint's signing key again.")" || die "cancelled, so Glint wasn't installed."
  [[ "$pw" == "$again" ]] || die "the passwords didn't match. Run this again."
  printf 'create-keychain -p %s %s\n' "$(sec_quote "$pw")" "$(sec_quote "$SIGNING_KC")" | security -i >/dev/null \
    || die "couldn't create Glint's signing keychain."
  security set-keychain-settings -l -u -t 120 "$SIGNING_KC" # also locks on sleep, and after 2 minutes if an install stops midway
  add_to_search_list
  tmp="$(mktemp -d)"
  cleanup_dirs+=("$tmp")
  /usr/bin/openssl req -new -x509 -nodes -newkey rsa:2048 -days 3650 -subj "/CN=$CERT" \
    -addext "basicConstraints=critical,CA:false" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
  # security import rejects a .p12 with an empty password.
  /usr/bin/openssl pkcs12 -export -name "$CERT" -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
    -passout pass:glint -out "$tmp/cert.p12"
  security import "$tmp/cert.p12" -k "$SIGNING_KC" -P glint -T /usr/bin/codesign >/dev/null
  security lock-keychain "$SIGNING_KC"
  signing_pw="$pw"
}

# Grants made for another signature don't match this one; cleared once the new Glint is in place, so macOS asks once
# (a failed install leaves the old Glint's grants alone).
requirement() { codesign -dr - "$1" 2>/dev/null | sed -n 's/^designated => //p'; }

reset_grants() {
  local appid
  appid="$(node -p "require('./package.json').build.appId")"
  for service in Microphone ScreenCapture AudioCapture ListenEvent AppleEvents Calendar; do
    tccutil reset "$service" "$appid" >/dev/null 2>&1 || true
  done
}

# Asked at the start, checked, and kept until the build is ready to sign: the keychain stays locked meanwhile.
check_signing_password() {
  [[ -n "$signing_pw" ]] && return
  local pw
  for _ in 1 2 3; do
    pw="$(ask_password "Type the password for Glint's signing key to install this version.")" \
      || die "cancelled, so Glint wasn't installed. The Glint you have is unchanged."
    if unlock_with "$pw"; then
      security lock-keychain "$SIGNING_KC"
      signing_pw="$pw"
      return
    fi
  done
  die "wrong password three times. If it's lost, run: security delete-keychain \"$SIGNING_KC\", then install again (macOS asks for Glint's permissions once more)."
}

unlock_with() { printf 'unlock-keychain -p %s %s\n' "$(sec_quote "$1")" "$(sec_quote "$SIGNING_KC")" | security -i >/dev/null 2>&1; }

quit_running() {
  # Started by Glint's own Update button: ask it to quit, and wait. It quits once no session is live, so an update
  # never cuts off a call, however long that takes.
  if [[ -n "${GLINT_PID:-}" ]] && kill -0 "$GLINT_PID" 2>/dev/null; then
    step "Waiting for Glint to quit (it finishes a live session first)"
    kill -USR2 "$GLINT_PID"
    while kill -0 "$GLINT_PID" 2>/dev/null; do sleep 1; done
    return
  fi
  # -a: pgrep leaves out its own ancestors by default, and Glint is one when an older Glint started this installer.
  pgrep -a -xq Glint || return 0
  step "Quitting the running Glint"
  osascript -e 'tell application "Glint" to quit'
  for _ in {1..20}; do pgrep -a -xq Glint || break; sleep 0.5; done
  if pgrep -a -xq Glint; then die "Glint is still running. Quit it from the tray icon and run this again."; fi
}

main() {
  check_mac
  check_node
  enter_source
  ensure_cert
  check_signing_password

  step "Installing dependencies"
  npm ci --no-audit --no-fund </dev/null

  # Before anything is built or copied, so a failing build never replaces the Glint that's installed.
  step "Checking the code"
  npm run typecheck </dev/null || die "this version of Glint fails its type check, so it wasn't installed. The Glint you have is unchanged."
  npm test </dev/null || die "this version of Glint fails its tests, so it wasn't installed. The Glint you have is unchanged."

  step "Building (takes a minute or two)"
  npm run package </dev/null

  local app
  app="$(ls -d dist/mac*/Glint.app 2>/dev/null | head -1)"
  [[ -n "$app" && -d "$app" ]] || die "build finished but no Glint.app was found in dist/."

  step "Signing with \"$CERT\""
  unlock_with "$signing_pw" || die "couldn't unlock Glint's signing keychain."
  signing_pw=""
  # Hardened runtime: no injected libraries or debugger. The code is packed in app.asar, whose hash is in the signed
  # Info.plist (Electron checks it), so changing the code invalidates the signature.
  codesign --force --deep --options runtime --entitlements build/entitlements.mac.plist --keychain "$SIGNING_KC" --sign "$CERT" "$app"
  security lock-keychain "$SIGNING_KC"

  # Copy in beside the old app while it still runs, then swap by renaming: a failed copy leaves the old Glint
  # untouched, and Glint is gone only for the moment the swap takes.
  local staged=/Applications/.Glint-new.app old=/Applications/.Glint-old.app
  step "Copying into /Applications"
  rm -rf "$staged" "$old"
  cleanup_dirs+=("$staged")
  ditto "$app" "$staged"

  # A new signing key (the first install with it, or a lost password) changes it; then the old grants don't apply.
  local resign=""
  [[ "$(requirement /Applications/Glint.app)" == "$(requirement "$app")" ]] || resign=1

  quit_running
  step "Installing to /Applications"
  if [[ -d /Applications/Glint.app ]]; then mv /Applications/Glint.app "$old"; fi
  if ! mv "$staged" /Applications/Glint.app; then
    [[ -d "$old" ]] && mv "$old" /Applications/Glint.app && open /Applications/Glint.app
    die "couldn't move the new Glint into /Applications; the previous version was reopened."
  fi
  rm -rf "$old"
  if [[ -n "$resign" ]]; then reset_grants; fi

  step "Done: Glint $(node -p "require('./package.json').version") is in /Applications. Opening it."
  if [[ -n "$resign" ]]; then
    step "Glint is newly signed: macOS asks for its permissions again, and once to let it use \"Glint Safe Storage\" in your keychain. Click Always Allow there, or your history and keys can't be read."
  fi
  open /Applications/Glint.app
}

main "$@"
