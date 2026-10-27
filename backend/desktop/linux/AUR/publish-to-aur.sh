#!/bin/bash
# Fully automated AUR publisher for rclone-manager.
#
# Packages (PKGBUILD templates live next to this script):
#   rclone-manager           PKGBUILD           desktop .deb from the v<version> release
#   rclone-manager-git       PKGBUILD-git       built from source, follows the stable version
#   rclone-manager-headless  PKGBUILD-headless  server + tray .deb from the headless-v<version> release
#   rclone-manager-server    PKGBUILD-server    pure server zip (no GTK/WebKit) from headless-v<version>
#
# For every package it finds the newest stable GitHub release, takes the asset sha256 sums
# from the release, rewrites a copy of the template, regenerates .SRCINFO and pushes to the AUR
# only when something changed. The templates in the repository are never modified, and the AUR
# repository is the source of truth for what is already published. A release whose assets are
# not all uploaded yet is skipped and picked up by the next run.
#
# Usage:
#   ./publish-to-aur.sh [--dry-run] [--only <package>]... [ssh_key_or_dir]
#
# SSH key, first match wins:
#   1. AUR_SSH_PRIVATE_KEY environment variable (key contents, used by CI)
#   2. the [ssh_key_or_dir] argument
#   3. ~/.ssh/aur_ed25519, then backups in ~/Downloads/Arch Aur Keys and similar
# A key is only needed to push; --dry-run reads the AUR anonymously over HTTPS.
#
# Other environment variables:
#   GITHUB_TOKEN / GH_TOKEN  optional, raises the GitHub API rate limit
#   AUR_DIR                  local clone cache (default ~/.aur-repos)
#   AUR_GIT_NAME, AUR_GIT_EMAIL  commit identity when git has none configured

set -euo pipefail

REPO="Zarestia-Dev/rclone-manager"
AUR_DIR="${AUR_DIR:-$HOME/.aur-repos}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'
print_info()    { echo -e "${BLUE}ℹ${NC} $1"; }
print_success() { echo -e "${GREEN}✓${NC} $1"; }
print_warning() { echo -e "${YELLOW}⚠${NC} $1"; }
print_error()   { echo -e "${RED}✗${NC} $1" >&2; }
print_header()  { echo -e "\n${CYAN}═══${NC} $1 ${CYAN}═══${NC}"; }

DRY_RUN=0
ONLY=()
KEY_ARG=""
SSH_KEY=""
RELEASES_JSON=""
LATEST_STABLE_VERSION=""

show_help() { sed -n '2,/^set -/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; }

# Find a private key file within a directory
find_key_in_dir() {
    local dir="$1" found
    [ -d "$dir" ] || return 1
    found=$(find "$dir" -type f -name "aur_ed25519" 2>/dev/null | head -n 1)
    if [ -z "$found" ]; then
        found=$(find "$dir" -maxdepth 4 -type f ! -name "*.pub" -exec grep -l -- "BEGIN .*PRIVATE KEY" {} + 2>/dev/null | head -n 1)
    fi
    [ -n "$found" ] && echo "$found"
}

# Resolve SSH_KEY and the git ssh command. Never touches ~/.ssh.
setup_ssh_auth() {
    print_header "Setting up SSH Authentication"

    if [ -n "${AUR_SSH_PRIVATE_KEY:-}" ]; then
        SSH_KEY="$WORK_DIR/aur_key"
        # Secrets are often stored with escaped or CRLF line endings.
        printf '%s\n' "$AUR_SSH_PRIVATE_KEY" | tr -d '\r' > "$SSH_KEY"
        chmod 600 "$SSH_KEY"
        print_info "Using key from AUR_SSH_PRIVATE_KEY"
    elif [ -n "$KEY_ARG" ]; then
        local path="${KEY_ARG/#\~/$HOME}"
        if [ -d "$path" ]; then
            SSH_KEY=$(find_key_in_dir "$path") || { print_error "No SSH private key found in: $path"; return 1; }
        elif [ -f "$path" ]; then
            SSH_KEY="${path%.pub}"
            [ -f "$SSH_KEY" ] || { print_error "Private key not found: $SSH_KEY"; return 1; }
        else
            print_error "Provided path does not exist: $KEY_ARG"
            return 1
        fi
    elif [ -f "$HOME/.ssh/aur_ed25519" ]; then
        SSH_KEY="$HOME/.ssh/aur_ed25519"
    else
        local dir
        for dir in "$HOME/Downloads/Arch Aur Keys" "$HOME/vm-lab/Arch Aur Keys" "$HOME/Downloads" "$HOME/Documents"; do
            SSH_KEY=$(find_key_in_dir "$dir" || true)
            [ -n "$SSH_KEY" ] && break
        done
        if [ -z "$SSH_KEY" ]; then
            print_error "AUR SSH key not found. Set AUR_SSH_PRIVATE_KEY or pass the key (or its folder) as an argument."
            return 1
        fi
    fi
    chmod 600 "$SSH_KEY" 2>/dev/null || true

    export GIT_SSH_COMMAND="ssh -i \"$SSH_KEY\" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

    print_info "Verifying SSH access to aur.archlinux.org..."
    if ! ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
        aur@aur.archlinux.org help >/dev/null 2>&1; then
        print_error "SSH authentication to aur@aur.archlinux.org failed with $SSH_KEY."
        print_info "Add the matching public key at https://aur.archlinux.org/account"
        return 1
    fi
    print_success "Authenticated on AUR with $SSH_KEY"
}

fetch_releases() {
    local auth=()
    local token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
    [ -n "$token" ] && auth=(-H "Authorization: Bearer $token")
    RELEASES_JSON=$(curl -fsSL "${auth[@]}" -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/$REPO/releases?per_page=50") || {
        print_error "Could not fetch the release list from GitHub"
        return 1
    }
}

# Newest published, non-pre-release version for a tag prefix ('v' or 'headless-v'). Prints "<tag> <version>".
latest_release() {
    jq -r --arg p "$1" '
        [.[] | select(.draft == false and .prerelease == false)
             | select(.tag_name | startswith($p))
             | {tag: .tag_name, v: (.tag_name | ltrimstr($p))}
             | select(.v | test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))]
        | sort_by(.v | split(".") | map(tonumber)) | last // empty
        | "\(.tag) \(.v)"' <<<"$RELEASES_JSON"
}

# sha256 of a release asset. Uses the digest GitHub records for the asset, and downloads it only
# when there is none. Prints nothing when the asset does not exist (yet).
asset_sha256() {
    local tag="$1" name="$2" digest
    digest=$(jq -r --arg t "$tag" --arg n "$name" '
        .[] | select(.tag_name == $t) | .assets[] | select(.name == $n)
        | (.digest // "") | sub("^sha256:"; "")' <<<"$RELEASES_JSON")
    if [ -z "$digest" ] && jq -e --arg t "$tag" --arg n "$name" \
        'any(.[] | select(.tag_name == $t) | .assets[]; .name == $n)' <<<"$RELEASES_JSON" >/dev/null; then
        curl -fsSL -o "$WORK_DIR/asset" "https://github.com/$REPO/releases/download/$tag/$name" || return 0
        digest=$(sha256sum "$WORK_DIR/asset" | cut -d' ' -f1)
        rm -f "$WORK_DIR/asset"
    fi
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] && echo "$digest"
    return 0
}

pkgbuild_var() { grep -m1 "^$2=" "$1" | cut -d= -f2- | tr -d "'\"[:space:]"; }

# Stage a release-based PKGBUILD at $WORK_DIR/<name>/PKGBUILD. Returns 2 when the release is not ready.
# stage_release_pkgbuild <name> <template> <tag prefix> <x86_64 asset> <aarch64 asset>   (assets use %s for the version)
stage_release_pkgbuild() {
    local name="$1" template="$2" prefix="$3" asset_x86="$4" asset_arm="$5"
    local latest tag version sha_x86 sha_arm out="$WORK_DIR/$name/PKGBUILD"

    latest=$(latest_release "$prefix")
    if [ -z "$latest" ]; then
        print_warning "No stable ${prefix}<version> release found; skipping $name"
        return 2
    fi
    read -r tag version <<<"$latest"

    # shellcheck disable=SC2059
    sha_x86=$(asset_sha256 "$tag" "$(printf "$asset_x86" "$version")")
    # shellcheck disable=SC2059
    sha_arm=$(asset_sha256 "$tag" "$(printf "$asset_arm" "$version")")
    if [ -z "$sha_x86" ] || [ -z "$sha_arm" ]; then
        print_warning "$tag does not have all assets yet; skipping $name (a later run will pick it up)"
        return 2
    fi

    mkdir -p "$WORK_DIR/$name"
    cp "$template" "$out"
    sed -i -E \
        -e "s/^(releasetag=).*/\1${version}/" \
        -e "s/^(pkgver=).*/\1${version}/" \
        -e "s/^(sha256sums_x86_64=\().*(\))/\1'${sha_x86}'\2/" \
        -e "s/^(sha256sums_aarch64=\().*(\))/\1'${sha_arm}'\2/" "$out"
    print_info "$name: $tag"
}

# The -git package builds from source; its pkgver() is recomputed on every build, so only follow the stable version.
stage_git_pkgbuild() {
    local name="$1" template="$2" out="$WORK_DIR/$1/PKGBUILD"
    mkdir -p "$WORK_DIR/$name"
    cp "$template" "$out"
    if [ -n "$LATEST_STABLE_VERSION" ]; then
        sed -i -E "s/^(pkgver=).*/\1${LATEST_STABLE_VERSION}/" "$out"
    fi
}

# pkgrel is 1 for a new pkgver, and bumped when the same pkgver is republished with other changes.
resolve_pkgrel() {
    local staged="$1" published="$2" new_ver old_ver old_rel
    [ -f "$published" ] || return 0
    new_ver=$(pkgbuild_var "$staged" pkgver)
    old_ver=$(pkgbuild_var "$published" pkgver)
    old_rel=$(pkgbuild_var "$published" pkgrel)
    [ "$new_ver" = "$old_ver" ] || return 0

    if diff -q <(grep -v '^pkgrel=' "$staged") <(grep -v '^pkgrel=' "$published") >/dev/null; then
        sed -i -E "s/^(pkgrel=).*/\1${old_rel}/" "$staged"
    else
        sed -i -E "s/^(pkgrel=).*/\1$((old_rel + 1))/" "$staged"
    fi
}

# Clone (or refresh) the AUR repository and reset it to the remote state.
sync_aur_repo() {
    local name="$1" dir="$AUR_DIR/$name"
    local read_url="https://aur.archlinux.org/${name}.git" push_url="ssh://aur@aur.archlinux.org/${name}.git"

    if [ ! -d "$dir/.git" ]; then
        rm -rf "$dir"
        git clone -q "$read_url" "$dir" 2>/dev/null || { mkdir -p "$dir"; git -C "$dir" init -q; }
    fi
    git -C "$dir" remote get-url origin >/dev/null 2>&1 || git -C "$dir" remote add origin "$read_url"
    git -C "$dir" remote set-url origin "$read_url"
    git -C "$dir" remote set-url --push origin "$push_url"

    if git -C "$dir" fetch -q origin master 2>/dev/null; then
        git -C "$dir" checkout -q -B master origin/master
        git -C "$dir" reset -q --hard origin/master
    else
        # Package does not exist on the AUR yet; the first push creates it.
        git -C "$dir" symbolic-ref HEAD refs/heads/master
    fi
    git -C "$dir" clean -qfd
}

publish_package() {
    local name="$1" dir="$AUR_DIR/$1" staged="$WORK_DIR/$1/PKGBUILD"

    print_header "Processing: $name"
    sync_aur_repo "$name" || return 1
    resolve_pkgrel "$staged" "$dir/PKGBUILD"

    cp "$staged" "$dir/PKGBUILD"
    [ -f "$SCRIPT_DIR/$name.install" ] && cp "$SCRIPT_DIR/$name.install" "$dir/"
    (cd "$dir" && makepkg --printsrcinfo > .SRCINFO) || { print_error "makepkg --printsrcinfo failed for $name"; return 1; }

    git -C "$dir" add -A
    if git -C "$dir" diff --cached --quiet; then
        print_success "$name is already up to date ($(pkgbuild_var "$dir/PKGBUILD" pkgver)-$(pkgbuild_var "$dir/PKGBUILD" pkgrel))"
        return 0
    fi

    local version pkgrel message
    version=$(pkgbuild_var "$dir/PKGBUILD" pkgver)
    pkgrel=$(pkgbuild_var "$dir/PKGBUILD" pkgrel)
    message="Update to $version-$pkgrel"
    git -C "$dir" rev-parse --verify -q HEAD >/dev/null || message="Initial commit: $version-$pkgrel"

    print_info "Changes in $name:"
    git -C "$dir" --no-pager diff --cached --stat
    if [ "$DRY_RUN" = 1 ]; then
        print_warning "Dry run: not committing '$message'"
        git -C "$dir" --no-pager diff --cached -- PKGBUILD | grep -E '^[+-](pkgver|pkgrel|releasetag|sha256sums)' || true
        return 0
    fi

    git -C "$dir" \
        -c "user.name=${AUR_GIT_NAME:-$(git config user.name || echo 'Hakan İSMAİL')}" \
        -c "user.email=${AUR_GIT_EMAIL:-$(git config user.email || echo 'hakanismail53@gmail.com')}" \
        commit -q -m "$message"
    git -C "$dir" push origin HEAD:master || { print_error "Push to AUR failed for $name"; return 1; }
    print_success "Published $name ($version-$pkgrel): https://aur.archlinux.org/packages/$name"
}

main() {
    while [ $# -gt 0 ]; do
        case "$1" in
            -h|--help|help) show_help; exit 0 ;;
            -n|--dry-run)   DRY_RUN=1 ;;
            --only)         [ $# -ge 2 ] || { print_error "--only needs a package name"; exit 1; }; ONLY+=("$2"); shift ;;
            -*)             print_error "Unknown option: $1"; exit 1 ;;
            *)              [ -z "$KEY_ARG" ] || { print_error "Only one key argument is accepted"; exit 1; }; KEY_ARG="$1" ;;
        esac
        shift
    done

    local tool
    for tool in git makepkg ssh curl jq sha256sum; do
        command -v "$tool" >/dev/null || { print_error "Required tool '$tool' is not installed"; exit 1; }
    done

    mkdir -p "$AUR_DIR"
    [ "$DRY_RUN" = 1 ] || setup_ssh_auth || exit 1

    print_header "Checking Latest Releases"
    fetch_releases || exit 1
    LATEST_STABLE_VERSION=$(latest_release "v" | cut -d' ' -f2)

    local packages=(rclone-manager rclone-manager-git rclone-manager-headless rclone-manager-server)
    local failed=() name rc
    for name in "${packages[@]}"; do
        if [ ${#ONLY[@]} -gt 0 ] && [[ ! " ${ONLY[*]} " == *" $name "* ]]; then continue; fi

        rc=0
        case "$name" in
            rclone-manager)
                stage_release_pkgbuild "$name" "$SCRIPT_DIR/PKGBUILD" "v" \
                    'RClone.Manager_%s_amd64.deb' 'RClone.Manager_%s_arm64.deb' || rc=$? ;;
            rclone-manager-git)
                stage_git_pkgbuild "$name" "$SCRIPT_DIR/PKGBUILD-git" || rc=$? ;;
            rclone-manager-headless)
                stage_release_pkgbuild "$name" "$SCRIPT_DIR/PKGBUILD-headless" "headless-v" \
                    'RClone.Manager.Headless_%s_amd64.deb' 'RClone.Manager.Headless_%s_arm64.deb' || rc=$? ;;
            rclone-manager-server)
                stage_release_pkgbuild "$name" "$SCRIPT_DIR/PKGBUILD-server" "headless-v" \
                    'server-linux-x86_64-%s.zip' 'server-linux-aarch64-%s.zip' || rc=$? ;;
        esac
        [ "$rc" = 2 ] && continue   # release not ready, retry on the next run
        if [ "$rc" != 0 ] || ! publish_package "$name"; then failed+=("$name"); fi
    done

    print_header "AUR Publication Complete"
    if [ ${#failed[@]} -gt 0 ]; then
        print_error "Failed: ${failed[*]}"
        exit 1
    fi
    print_success "All packages are synchronized with the AUR"
}

main "$@"
