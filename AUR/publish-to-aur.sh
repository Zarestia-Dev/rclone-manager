#!/bin/bash
# Advanced AUR Package Management Script for rclone-manager
# Usage: ./publish-to-aur.sh [command] [package]
#
# Commands:
#   init [stable|git|all]     - Initialize AUR repositories (first time setup)
#   update [stable|git|all]   - Update existing AUR packages
#   status [stable|git|all]   - Check status of AUR repositories
#   diff [stable|git|all]     - Show differences before committing
#   push [stable|git|all]     - Push changes to AUR
#   help                      - Show this help message

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
AUR_DIR="$HOME/.aur-repos"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STABLE_PKGBUILD="$SCRIPT_DIR/PKGBUILD"
GIT_PKGBUILD="$SCRIPT_DIR/PKGBUILD-git"

# Print colored output
print_info() { echo -e "${BLUE}ℹ${NC} $1"; }
print_success() { echo -e "${GREEN}✓${NC} $1"; }
print_warning() { echo -e "${YELLOW}⚠${NC} $1"; }
print_error() { echo -e "${RED}✗${NC} $1"; }
print_header() { echo -e "\n${BLUE}═══${NC} $1 ${BLUE}═══${NC}"; }

# Show help message
show_help() {
    echo -e "${BLUE}AUR Package Manager for rclone-manager${NC}"
    echo ""
    echo -e "${YELLOW}Usage:${NC}"
    echo "    ./publish-to-aur.sh [command] [package]"
    echo ""
    echo -e "${YELLOW}Commands:${NC}"
    echo "    init [stable|git|all]     Initialize AUR repositories (first time)"
    echo "    update [stable|git|all]   Update existing AUR packages"
    echo "    status [stable|git|all]   Check status of AUR repositories"
    echo "    diff [stable|git|all]     Show differences before committing"
    echo "    push [stable|git|all]     Push changes to AUR"
    echo "    help                      Show this help message"
    echo ""
    echo -e "${YELLOW}Packages:${NC}"
    echo "    stable                    rclone-manager (stable releases)"
    echo "    git                       rclone-manager-git (development version)"
    echo "    all                       Both packages (default)"
    echo ""
    echo -e "${YELLOW}Examples:${NC}"
    echo "    ./publish-to-aur.sh init all          # Initialize both repositories"
    echo "    ./publish-to-aur.sh update git        # Update only git version"
    echo "    ./publish-to-aur.sh status stable     # Check status of stable package"
    echo "    ./publish-to-aur.sh push all          # Push both packages to AUR"
    echo ""
}

# Initialize AUR repository
init_package() {
    local pkg_name=$1
    local pkg_url="ssh://aur@aur.archlinux.org/${pkg_name}.git"
    
    print_header "Initializing $pkg_name"
    
    cd "$AUR_DIR"
    
    if [ -d "$pkg_name" ]; then
        print_warning "Repository $pkg_name already exists"
        cd "$pkg_name"
        git pull origin master 2>/dev/null || print_info "No remote content yet"
    else
        print_info "Creating new repository..."
        mkdir -p "$pkg_name"
        cd "$pkg_name"
        git init
        git remote add origin "$pkg_url"
        print_success "Repository initialized"
    fi
}

# Update package files
update_package() {
    local pkg_name=$1
    local source_pkgbuild=$2
    
    print_header "Updating $pkg_name"
    
    if [ ! -f "$source_pkgbuild" ]; then
        print_error "Source PKGBUILD not found: $source_pkgbuild"
        return 1
    fi
    
    # Ensure repo exists
    if [ ! -d "$AUR_DIR/$pkg_name" ]; then
        print_warning "Repository not initialized, initializing now..."
        init_package "$pkg_name"
    fi
    
    cd "$AUR_DIR/$pkg_name"
    
    # Pull latest changes
    print_info "Pulling latest changes from AUR..."
    git pull origin master 2>/dev/null || print_info "No remote changes"
    
    # Copy PKGBUILD
    print_info "Copying PKGBUILD..."
    cp "$source_pkgbuild" "$AUR_DIR/$pkg_name/PKGBUILD"
    
    # Generate .SRCINFO
    print_info "Generating .SRCINFO..."
    makepkg --printsrcinfo > .SRCINFO
    
    # Show changes
    if git diff --quiet; then
        print_success "No changes detected"
        return 0
    fi
    
    print_success "Package updated!"
    print_info "Changes:"
    git diff --stat
}

# Show status of package
status_package() {
    local pkg_name=$1
    
    print_header "Status: $pkg_name"
    
    if [ ! -d "$AUR_DIR/$pkg_name" ]; then
        print_error "Repository not found: $pkg_name"
        print_info "Run: ./publish-to-aur.sh init $pkg_name"
        return 1
    fi
    
    cd "$AUR_DIR/$pkg_name"
    
    # Git status
    print_info "Git status:"
    git status --short
    
    # Show branch info
    local branch=$(git branch --show-current)
    print_info "Branch: $branch"
    
    # Check if ahead/behind
    git fetch origin master 2>/dev/null || true
    local ahead=$(git rev-list --count origin/master..HEAD 2>/dev/null || echo "0")
    local behind=$(git rev-list --count HEAD..origin/master 2>/dev/null || echo "0")
    
    if [ "$ahead" -gt 0 ]; then
        print_warning "Ahead by $ahead commit(s)"
    fi
    if [ "$behind" -gt 0 ]; then
        print_warning "Behind by $behind commit(s)"
    fi
    
    # Show last commit
    print_info "Last commit:"
    git log -1 --oneline
}

# Show diff for package
diff_package() {
    local pkg_name=$1
    
    print_header "Diff: $pkg_name"
    
    if [ ! -d "$AUR_DIR/$pkg_name" ]; then
        print_error "Repository not found: $pkg_name"
        return 1
    fi
    
    cd "$AUR_DIR/$pkg_name"
    
    if git diff --quiet; then
        print_success "No changes"
    else
        git diff --color=always
    fi
}

# Push package to AUR
push_package() {
    local pkg_name=$1
    
    print_header "Pushing $pkg_name to AUR"
    
    if [ ! -d "$AUR_DIR/$pkg_name" ]; then
        print_error "Repository not found: $pkg_name"
        return 1
    fi
    
    cd "$AUR_DIR/$pkg_name"
    
    # Check if there are changes
    if git diff --quiet && git diff --cached --quiet; then
        print_warning "No changes to commit"
        return 0
    fi
    
    # Show what will be committed
    print_info "Changes to be committed:"
    git diff --cached --stat || git diff --stat
    
    # Ask for confirmation
    echo ""
    read -p "$(echo -e ${YELLOW}Continue with commit and push? [y/N]:${NC} )" -n 1 -r
    echo
    
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_warning "Aborted"
        return 0
    fi
    
    # Stage changes if nothing is staged yet
    # `git diff --cached --quiet` returns true when there are NO staged changes,
    # so add PKGBUILD and .SRCINFO when that's the case.
    if git diff --cached --quiet; then
        print_info "Staging changes..."
        git add PKGBUILD .SRCINFO
    fi
    
    # Get commit message
    local version=$(grep -m1 '^pkgver=' PKGBUILD | cut -d'=' -f2)
    local pkgrel=$(grep -m1 '^pkgrel=' PKGBUILD | cut -d'=' -f2)
    
    echo ""
    read -p "$(echo -e ${YELLOW}Commit message [Update to $version-$pkgrel]:${NC} )" commit_msg
    commit_msg=${commit_msg:-"Update to $version-$pkgrel"}
    
    # Commit
    print_info "Committing..."
    git commit -m "$commit_msg"
    
    # Push
    print_info "Pushing to AUR..."
    git push origin master
    
    print_success "Successfully pushed to AUR!"
    print_info "Package URL: https://aur.archlinux.org/packages/$pkg_name"
}

# Process command for package(s)
process_command() {
    local command=$1
    local package=$2
    
    case $package in
        stable)
            "${command}_package" "rclone-manager" "$STABLE_PKGBUILD"
            ;;
        git)
            "${command}_package" "rclone-manager-git" "$GIT_PKGBUILD"
            ;;
        all|"")
            "${command}_package" "rclone-manager" "$STABLE_PKGBUILD"
            echo ""
            "${command}_package" "rclone-manager-git" "$GIT_PKGBUILD"
            ;;
        *)
            print_error "Unknown package: $package"
            print_info "Valid packages: stable, git, all"
            exit 1
            ;;
    esac
}

# Main script logic
main() {
    # Create AUR directory if it doesn't exist
    mkdir -p "$AUR_DIR"
    
    # Parse command
    local command=${1:-help}
    local package=${2:-all}
    
    case $command in
        init)
            process_command "init" "$package"
            ;;
        update)
            process_command "update" "$package"
            ;;
        status)
            process_command "status" "$package"
            ;;
        diff)
            process_command "diff" "$package"
            ;;
        push)
            process_command "push" "$package"
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            print_error "Unknown command: $command"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

# Run main function
main "$@"
