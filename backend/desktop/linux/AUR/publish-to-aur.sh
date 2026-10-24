#!/bin/bash
# Fully Automated AUR Package Publisher for rclone-manager
#
# Usage:
#   ./publish-to-aur.sh [ssh_key_or_dir]
#
# Arguments:
#   [ssh_key_or_dir] (optional)
#       Path to custom AUR SSH key or backup directory containing the key.
#       Example: ./publish-to-aur.sh "/home/hakan/Downloads/Arch Aur Keys"
#
# If no argument is provided, the script automatically uses ~/.ssh/aur_ed25519
# or auto-detects backed-up AUR keys from ~/Downloads/Arch Aur Keys, etc.

set -e

# Output formatting colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Directories and paths
AUR_DIR="$HOME/.aur-repos"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STABLE_PKGBUILD="$SCRIPT_DIR/PKGBUILD"
GIT_PKGBUILD="$SCRIPT_DIR/PKGBUILD-git"
HEADLESS_PKGBUILD="$SCRIPT_DIR/PKGBUILD-headless"

print_info()    { echo -e "${BLUE}ℹ${NC} $1"; }
print_success() { echo -e "${GREEN}✓${NC} $1"; }
print_warning() { echo -e "${YELLOW}⚠${NC} $1"; }
print_error()   { echo -e "${RED}✗${NC} $1"; }
print_header()  { echo -e "\n${CYAN}═══${NC} $1 ${CYAN}═══${NC}"; }

show_help() {
    echo -e "${BLUE}AUR Package Auto-Publisher for rclone-manager${NC}"
    echo ""
    echo -e "${YELLOW}Usage:${NC}"
    echo "    ./publish-to-aur.sh [ssh_key_or_dir]"
    echo ""
    echo -e "${YELLOW}Arguments:${NC}"
    echo "    [ssh_key_or_dir]   Optional path to custom SSH key file or backup folder."
    echo "                       Examples:"
    echo '                         ./publish-to-aur.sh "/home/hakan/Downloads/Arch Aur Keys"'
    echo '                         ./publish-to-aur.sh ~/.ssh/aur_ed25519'
    echo ""
    echo -e "${YELLOW}Automatic Behavior:${NC}"
    echo "    1. Detects and installs SSH key to ~/.ssh/aur_ed25519 (chmod 600)."
    echo "    2. Configures ~/.ssh/config and known_hosts for aur.archlinux.org."
    echo "    3. Verifies SSH authentication with AUR."
    echo "    4. Checks GitHub releases, updates PKGBUILDs and computes sha256 sums automatically."
    echo "    5. For all 3 packages (stable, git, headless):"
    echo "       - Syncs / clones AUR repository in ~/.aur-repos/"
    echo "       - Copies PKGBUILD and regenerates .SRCINFO"
    echo "       - Commits and pushes changes automatically if any update is detected"
    echo ""
}

# Find private key file within a directory
find_key_in_dir() {
    local search_dir="$1"
    if [ ! -d "$search_dir" ]; then
        return 1
    fi
    
    # 1. Look specifically for 'aur_ed25519'
    local found
    found=$(find "$search_dir" -type f -name "aur_ed25519" 2>/dev/null | head -n 1)
    if [ -n "$found" ] && [ -f "$found" ]; then
        echo "$found"
        return 0
    fi
    
    # 2. Look for any private key by header (excluding .pub)
    found=$(find "$search_dir" -maxdepth 4 -type f ! -name "*.pub" -exec grep -l -- "BEGIN .*PRIVATE KEY" {} + 2>/dev/null | head -n 1)
    if [ -n "$found" ] && [ -f "$found" ]; then
        echo "$found"
        return 0
    fi
    
    return 1
}

# Resolve, install and configure SSH key
setup_ssh_auth() {
    local input_arg="$1"
    local key_file=""
    local pub_key_file=""
    local target_key="$HOME/.ssh/aur_ed25519"
    local target_pub="$HOME/.ssh/aur_ed25519.pub"
    
    print_header "Setting up SSH Authentication"
    
    # If custom argument provided
    if [ -n "$input_arg" ]; then
        local expanded_path="${input_arg/#\~/$HOME}"
        
        if [ ! -e "$expanded_path" ]; then
            print_error "Provided path does not exist: $input_arg"
            exit 1
        fi
        
        if [ -d "$expanded_path" ]; then
            print_info "Searching for AUR SSH key in: $expanded_path"
            key_file=$(find_key_in_dir "$expanded_path" || true)
            if [ -z "$key_file" ]; then
                print_error "No SSH private key found in directory: $expanded_path"
                exit 1
            fi
        elif [ -f "$expanded_path" ]; then
            if [[ "$expanded_path" == *.pub ]]; then
                local priv="${expanded_path%.pub}"
                if [ -f "$priv" ]; then
                    key_file="$priv"
                    pub_key_file="$expanded_path"
                else
                    print_error "Public key provided but corresponding private key '$priv' not found."
                    exit 1
                fi
            else
                key_file="$expanded_path"
            fi
        fi
    else
        # Auto-detection mode (no arguments provided)
        if [ -f "$target_key" ]; then
            key_file="$target_key"
        else
            print_info "Searching for backed-up AUR SSH keys in common locations..."
            local backup_candidates=(
                "$HOME/Downloads/Arch Aur Keys"
                "$HOME/vm-lab/Arch Aur Keys"
                "$HOME/Downloads"
                "$HOME/Documents"
            )
            for cand in "${backup_candidates[@]}"; do
                if [ -d "$cand" ]; then
                    key_file=$(find_key_in_dir "$cand" || true)
                    if [ -n "$key_file" ]; then
                        print_info "Found AUR SSH key in backup location: $key_file"
                        break
                    fi
                fi
            done
        fi
        
        if [ -z "$key_file" ]; then
            print_error "AUR SSH key not found in ~/.ssh/aur_ed25519 or common backup locations."
            echo ""
            print_info "Please provide the key or backup directory as an argument:"
            print_info "    ./publish-to-aur.sh \"/path/to/Arch Aur Keys\""
            echo ""
            exit 1
        fi
    fi
    
    # Identify matching public key if not already set
    if [ -z "$pub_key_file" ]; then
        if [ -f "${key_file}.pub" ]; then
            pub_key_file="${key_file}.pub"
        else
            local candidate_pub
            candidate_pub=$(find "$(dirname "$key_file")" -maxdepth 2 -type f -name "*.pub" 2>/dev/null | head -n 1)
            if [ -n "$candidate_pub" ]; then
                pub_key_file="$candidate_pub"
            fi
        fi
    fi
    
    # Ensure ~/.ssh exists with strict permissions
    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    
    # Install key to ~/.ssh/aur_ed25519 if it's located elsewhere
    if [ "$key_file" != "$target_key" ]; then
        print_info "Installing AUR key from '$key_file' to '$target_key'..."
        cp -f "$key_file" "$target_key"
    fi
    chmod 600 "$target_key"
    
    if [ -n "$pub_key_file" ] && [ -f "$pub_key_file" ]; then
        if [ "$pub_key_file" != "$target_pub" ]; then
            cp -f "$pub_key_file" "$target_pub"
        fi
        chmod 644 "$target_pub"
    fi
    print_success "AUR private key configured at $target_key (chmod 600)"
    
    # Ensure ~/.ssh/config contains aur.archlinux.org host entry
    touch "$HOME/.ssh/config"
    chmod 600 "$HOME/.ssh/config"
    if ! grep -q "Host aur.archlinux.org" "$HOME/.ssh/config" 2>/dev/null; then
        print_info "Configuring ~/.ssh/config for aur.archlinux.org..."
        cat >> "$HOME/.ssh/config" << 'EOF'

Host aur.archlinux.org
    User aur
    IdentityFile ~/.ssh/aur_ed25519
EOF
        print_success "Added aur.archlinux.org host entry to ~/.ssh/config"
    fi
    
    # Ensure aur.archlinux.org host key is in known_hosts to prevent interactive prompts
    touch "$HOME/.ssh/known_hosts"
    chmod 644 "$HOME/.ssh/known_hosts"
    if ! ssh-keygen -F aur.archlinux.org >/dev/null 2>&1; then
        print_info "Adding aur.archlinux.org host key to ~/.ssh/known_hosts..."
        ssh-keyscan -t ed25519,rsa,ecdsa aur.archlinux.org >> "$HOME/.ssh/known_hosts" 2>/dev/null || true
        print_success "Added host key to known_hosts"
    fi
    
    # Export Git SSH command override
    export GIT_SSH_COMMAND="ssh -i $target_key -o StrictHostKeyChecking=accept-new"
    
    # Verify SSH authentication with AUR
    print_info "Verifying SSH connection to aur@aur.archlinux.org..."
    local auth_output
    auth_output=$(ssh -i "$target_key" -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new aur@aur.archlinux.org 2>&1 || true)
    
    if echo "$auth_output" | grep -qi "Welcome to AUR"; then
        local aur_user
        aur_user=$(echo "$auth_output" | grep -o "Welcome to AUR, [^!]*" | sed 's/Welcome to AUR, //' || echo "authenticated user")
        print_success "Successfully authenticated on AUR as ${GREEN}$aur_user${NC}"
    else
        print_error "SSH authentication to aur@aur.archlinux.org failed."
        echo -e "${YELLOW}$auth_output${NC}"
        print_info "Make sure your public key (${target_key}.pub) is added to your AUR account at https://aur.archlinux.org/account"
        exit 1
    fi
}

# Ensure Git user name and email are configured
setup_git_identity() {
    if [ -z "$(git config --get user.name 2>/dev/null)" ]; then
        print_warning "Git user.name not set. Configuring fallback 'Hakan İSMAİL'..."
        git config --global user.name "Hakan İSMAİL"
    fi
    if [ -z "$(git config --get user.email 2>/dev/null)" ]; then
        print_warning "Git user.email not set. Configuring fallback 'hakanismail53@gmail.com'..."
        git config --global user.email "hakanismail53@gmail.com"
    fi
}

# Calculate SHA-256 hash of a remote file directly into memory
calc_url_sha256() {
    local url=$1
    local sum
    sum=$(curl -sL "$url" | sha256sum | awk '{print $1}')
    if [ ${#sum} -eq 64 ]; then
        echo "$sum"
        return 0
    fi
    return 1
}

# Fetch the latest release tag from GitHub matching a prefix (e.g., 'v' or 'headless-v')
fetch_latest_github_tag() {
    local prefix=$1
    local tag
    tag=$(curl -sL "https://api.github.com/repos/Zarestia-Dev/rclone-manager/releases" 2>/dev/null | \
        grep -o '"tag_name": *"[^"]*"' | \
        cut -d'"' -f4 | \
        grep "^${prefix}[0-9]" | head -n 1)
    
    if [ -z "$tag" ]; then
        # Fallback to local git tag or package.json
        if [ "$prefix" = "v" ]; then
            tag=$(git tag -l "v[0-9]*" --sort=-v:refname 2>/dev/null | head -n 1)
            if [ -z "$tag" ] && [ -f "$SCRIPT_DIR/../../../../package.json" ]; then
                local ver
                ver=$(grep -m1 '"version"' "$SCRIPT_DIR/../../../../package.json" | cut -d'"' -f4)
                tag="v${ver}"
            fi
        elif [ "$prefix" = "headless-v" ]; then
            tag=$(git tag -l "headless-v[0-9]*" --sort=-v:refname 2>/dev/null | head -n 1)
            if [ -z "$tag" ] && [ -f "$SCRIPT_DIR/../../../../package.json" ]; then
                local ver
                ver=$(grep -m1 '"version"' "$SCRIPT_DIR/../../../../package.json" | cut -d'"' -f4)
                tag="headless-v${ver}"
            fi
        fi
    fi
    echo "$tag"
}

# Automatically sync PKGBUILD and PKGBUILD-headless with the latest release & sha256 sums
sync_pkgbuilds() {
    print_header "Checking Latest Releases & Checksums"
    
    # 1. Desktop version check
    local stable_tag
    stable_tag=$(fetch_latest_github_tag "v")
    if [ -n "$stable_tag" ]; then
        local stable_ver="${stable_tag#v}"
        local current_stable_ver
        current_stable_ver=$(grep -m1 '^pkgver=' "$STABLE_PKGBUILD" | cut -d'=' -f2 | tr -d "'\"[:space:]")
        
        print_info "Desktop Release: v${stable_ver} (PKGBUILD: v${current_stable_ver})"
        if [ "$stable_ver" != "$current_stable_ver" ]; then
            print_info "Fetching sha256 checksums for desktop v${stable_ver}..."
            local x86_url="https://github.com/Zarestia-Dev/rclone-manager/releases/download/v${stable_ver}/RClone.Manager_${stable_ver}_amd64.deb"
            local arm_url="https://github.com/Zarestia-Dev/rclone-manager/releases/download/v${stable_ver}/RClone.Manager_${stable_ver}_arm64.deb"
            
            local sha_x86 sha_arm
            sha_x86=$(calc_url_sha256 "$x86_url" || true)
            sha_arm=$(calc_url_sha256 "$arm_url" || true)
            
            if [ -n "$sha_x86" ] && [ -n "$sha_arm" ]; then
                sed -i -E "s/^(releasetag=).*/\1${stable_ver}/" "$STABLE_PKGBUILD"
                sed -i -E "s/^(pkgver=).*/\1${stable_ver}/" "$STABLE_PKGBUILD"
                sed -i -E "s/^(pkgrel=).*/\11/" "$STABLE_PKGBUILD"
                sed -i -E "s/^(sha256sums_x86_64=\().*(\))/\1'${sha_x86}'\2/" "$STABLE_PKGBUILD"
                sed -i -E "s/^(sha256sums_aarch64=\().*(\))/\1'${sha_arm}'\2/" "$STABLE_PKGBUILD"
                print_success "Auto-updated PKGBUILD to v${stable_ver} with fresh sha256 checksums"
            else
                print_warning "Could not fetch release assets for v${stable_ver}; keeping existing PKGBUILD"
            fi
        else
            print_success "PKGBUILD is up to date (v${stable_ver})"
        fi
        
        # Keep PKGBUILD-git pkgver synced
        local current_git_ver
        current_git_ver=$(grep -m1 '^pkgver=' "$GIT_PKGBUILD" | cut -d'=' -f2 | tr -d "'\"[:space:]")
        if [ "$stable_ver" != "$current_git_ver" ]; then
            sed -i -E "s/^(pkgver=).*/\1${stable_ver}/" "$GIT_PKGBUILD"
            sed -i -E "s/^(pkgrel=).*/\11/" "$GIT_PKGBUILD"
            print_success "Auto-updated PKGBUILD-git base version to v${stable_ver}"
        else
            print_success "PKGBUILD-git is up to date (v${stable_ver})"
        fi
    fi
    
    # 2. Headless version check
    local headless_tag
    headless_tag=$(fetch_latest_github_tag "headless-v")
    if [ -n "$headless_tag" ]; then
        local headless_ver="${headless_tag#headless-v}"
        local current_headless_ver
        current_headless_ver=$(grep -m1 '^pkgver=' "$HEADLESS_PKGBUILD" | cut -d'=' -f2 | tr -d "'\"[:space:]")
        
        print_info "Headless Release: headless-v${headless_ver} (PKGBUILD: v${current_headless_ver})"
        if [ "$headless_ver" != "$current_headless_ver" ]; then
            print_info "Fetching sha256 checksums for headless-v${headless_ver}..."
            local x86_url="https://github.com/Zarestia-Dev/rclone-manager/releases/download/headless-v${headless_ver}/RClone.Manager.Headless_${headless_ver}_amd64.deb"
            local arm_url="https://github.com/Zarestia-Dev/rclone-manager/releases/download/headless-v${headless_ver}/RClone.Manager.Headless_${headless_ver}_arm64.deb"
            
            local sha_x86 sha_arm
            sha_x86=$(calc_url_sha256 "$x86_url" || true)
            sha_arm=$(calc_url_sha256 "$arm_url" || true)
            
            if [ -n "$sha_x86" ] && [ -n "$sha_arm" ]; then
                sed -i -E "s/^(releasetag=).*/\1${headless_ver}/" "$HEADLESS_PKGBUILD"
                sed -i -E "s/^(pkgver=).*/\1${headless_ver}/" "$HEADLESS_PKGBUILD"
                sed -i -E "s/^(pkgrel=).*/\11/" "$HEADLESS_PKGBUILD"
                sed -i -E "s/^(sha256sums_x86_64=\().*(\))/\1'${sha_x86}'\2/" "$HEADLESS_PKGBUILD"
                sed -i -E "s/^(sha256sums_aarch64=\().*(\))/\1'${sha_arm}'\2/" "$HEADLESS_PKGBUILD"
                print_success "Auto-updated PKGBUILD-headless to v${headless_ver} with fresh sha256 checksums"
            else
                print_warning "Could not fetch release assets for headless-v${headless_ver}; keeping existing PKGBUILD"
            fi
        else
            print_success "PKGBUILD-headless is up to date (v${headless_ver})"
        fi
    fi
}

# Publish a single AUR package
publish_package() {
    local pkg_name=$1
    local source_pkgbuild=$2
    local pkg_url="ssh://aur@aur.archlinux.org/${pkg_name}.git"
    local pkg_dir="$AUR_DIR/$pkg_name"
    
    print_header "Processing: $pkg_name"
    
    if [ ! -f "$source_pkgbuild" ]; then
        print_error "Source PKGBUILD not found: $source_pkgbuild"
        return 1
    fi
    
    # 1. Clone or initialize repository if missing
    if [ ! -d "$pkg_dir" ]; then
        print_info "Cloning $pkg_name from AUR..."
        if git clone "$pkg_url" "$pkg_dir" 2>/dev/null; then
            print_success "Cloned $pkg_name repository"
        else
            print_warning "Repository not yet created on AUR. Initializing empty repository..."
            mkdir -p "$pkg_dir"
            git -C "$pkg_dir" init --initial-branch=master
            git -C "$pkg_dir" remote add origin "$pkg_url"
        fi
    fi
    
    cd "$pkg_dir"
    
    # Ensure remote URL is current
    git remote set-url origin "$pkg_url" 2>/dev/null || git remote add origin "$pkg_url"
    
    # 2. Pull remote changes
    print_info "Pulling latest changes from AUR..."
    git fetch origin master 2>/dev/null || true
    git pull origin master --rebase 2>/dev/null || git pull origin master 2>/dev/null || true
    
    # 3. Copy source PKGBUILD
    print_info "Syncing PKGBUILD..."
    cp "$source_pkgbuild" "$pkg_dir/PKGBUILD"
    
    # Copy .install file if present
    local source_dir="$(dirname "$source_pkgbuild")"
    if [ -f "$source_dir/${pkg_name}.install" ]; then
        cp "$source_dir/${pkg_name}.install" "$pkg_dir/${pkg_name}.install"
    fi
    
    # 4. Generate .SRCINFO
    print_info "Generating .SRCINFO with makepkg..."
    makepkg --printsrcinfo > .SRCINFO
    
    # 5. Check for changes
    local untracked
    untracked=$(git ls-files --others --exclude-standard)
    local has_commits
    has_commits=$(git rev-parse --verify HEAD 2>/dev/null || true)
    
    if git diff --quiet && git diff --cached --quiet && [ -z "$untracked" ]; then
        print_success "$pkg_name is already up to date (no changes detected)"
        return 0
    fi
    
    # 6. Show changes summary
    print_info "Detected changes in $pkg_name:"
    git status --short
    
    # 7. Stage files
    git add PKGBUILD .SRCINFO
    if [ -f "${pkg_name}.install" ]; then
        git add "${pkg_name}.install"
    fi
    
    # 8. Commit
    local version pkgrel commit_msg
    version=$(grep -m1 '^pkgver=' PKGBUILD | cut -d'=' -f2 | tr -d "'\"[:space:]")
    pkgrel=$(grep -m1 '^pkgrel=' PKGBUILD | cut -d'=' -f2 | tr -d "'\"[:space:]")
    
    if [ -z "$has_commits" ]; then
        commit_msg="Initial commit: $version-$pkgrel"
    else
        commit_msg="Update to $version-$pkgrel"
    fi
    
    print_info "Committing: '$commit_msg'..."
    git commit -m "$commit_msg"
    
    # 9. Push to AUR
    print_info "Pushing to AUR..."
    git push origin master
    
    print_success "Successfully published $pkg_name ($version-$pkgrel) to AUR!"
    print_info "Package URL: https://aur.archlinux.org/packages/$pkg_name"
}

main() {
    # Check required tools
    for tool in git makepkg ssh ssh-keygen ssh-keyscan curl; do
        if ! command -v "$tool" &>/dev/null; then
            print_error "Required tool '$tool' is not installed or not in PATH."
            exit 1
        fi
    done
    
    # Handle help or argument count validation
    if [ "$1" = "-h" ] || [ "$1" = "--help" ] || [ "$1" = "help" ]; then
        show_help
        exit 0
    fi
    
    if [ "$#" -gt 1 ]; then
        print_error "Too many arguments. This script accepts only one optional argument (custom SSH key or backup directory)."
        print_info "Usage: ./publish-to-aur.sh [ssh_key_or_dir]"
        exit 1
    fi
    
    local custom_key_path="$1"
    
    # 1. Setup and verify SSH authentication
    setup_ssh_auth "$custom_key_path"
    
    # 2. Ensure git user identity is present
    setup_git_identity
    
    # 3. Ensure AUR base dir exists
    mkdir -p "$AUR_DIR"
    
    # 4. Automatically sync PKGBUILD files with latest GitHub releases & sha256 checksums
    sync_pkgbuilds
    
    # 5. Auto-publish all packages to AUR
    print_header "Publishing Packages to AUR"
    publish_package "rclone-manager" "$STABLE_PKGBUILD"
    publish_package "rclone-manager-git" "$GIT_PKGBUILD"
    publish_package "rclone-manager-headless" "$HEADLESS_PKGBUILD"
    
    print_header "AUR Publication Complete"
    print_success "All packages have been checked and synchronized with AUR!"
}

main "$@"
