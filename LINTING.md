# Linting and Code Quality Setup

This project uses a comprehensive linting and formatting setup to maintain code quality across both TypeScript/Angular and Rust codebases.

## Tools Used

### TypeScript/Angular

- **ESLint**: Linting for TypeScript and Angular code
- **Prettier**: Code formatting
- **Angular ESLint**: Angular-specific linting rules

### Rust

- **Clippy**: Official Rust linter
- **Rustfmt**: Official Rust code formatter

### Git Hooks

- **Husky**: Git hooks management
- **lint-staged**: Run linters on staged files

## Available Scripts

### Frontend (Angular/TypeScript)

```bash
npm run lint          # Run ESLint
npm run lint:fix      # Run ESLint with auto-fix
npm run format        # Format code with Prettier
npm run format:check  # Check if code is formatted
```

### Backend (Rust)

```bash
npm run lint:rust        # Run Clippy
npm run format:rust      # Format Rust code
npm run format:rust:check # Check Rust formatting
```

### Combined

```bash
npm run lint:all  # Run all linters and formatters (check only)
npm run fix:all   # Run all linters and formatters with auto-fix
```

## Pre-commit Hooks

The project automatically runs linting and formatting on staged files before each commit. This ensures:

- Code quality standards are maintained
- Consistent formatting across the codebase
- Early detection of potential issues

### Troubleshooting Pre-commit Issues

If you encounter errors during pre-commit:

1. **Rust formatting errors**: Ensure you're in the project root directory and `src-tauri/Cargo.toml` exists
2. **ESLint/Prettier SIGKILL errors**: Usually caused by insufficient memory or conflicting processes
3. **To bypass hooks temporarily**: Use `git commit --no-verify` (not recommended for main branch)

## Troubleshooting

### Pre-commit Hook Failures

If the pre-commit hooks fail, you'll see errors like:

```
✖ cargo fmt --:
`cargo metadata` exited with an error: error: could not find `Cargo.toml` in `/home/hakan/Documents/GitHub/rclone-manager` or any parent directory
```

This usually indicates that the Rust commands are not running from the correct directory. The fix is to ensure that the lint-staged configuration uses shell commands that properly change to the `src-tauri` directory.

### Common Issues and Solutions

1. **TOML Parse Errors**: If you see "duplicate key" errors, check:
   - `src-tauri/Cargo.toml` for duplicate keys
   - `src-tauri/rustfmt.toml` for conflicting configuration options
   - Ensure the Rust edition is valid (2015, 2018, 2021)

2. **ESLint Errors**: The project has strict linting rules. Common issues:
   - `@typescript-eslint/no-explicit-any`: Replace `any` types with proper types
   - `@typescript-eslint/no-unused-vars`: Remove unused variables
   - `@angular-eslint/prefer-inject`: Use `inject()` instead of constructor injection

3. **Cargo Clippy Warnings**: Rust linter warnings that should be addressed:
   - Run `npm run lint:rust` to see detailed warnings
   - Fix warnings or use `#[allow(clippy::warning_name)]` if necessary

### Manual Commands

If the pre-commit hooks fail, you can run the linting tools manually:

```bash
# Frontend linting
npm run lint          # Check for errors
npm run lint:fix      # Auto-fix errors
npm run format        # Format code

# Rust linting (run from project root)
npm run lint:rust     # Check for warnings
npm run format:rust   # Format code

# Or run directly in src-tauri directory
cd src-tauri
cargo fmt             # Format code
cargo clippy -- -D warnings  # Check for warnings
```

### Bypassing Pre-commit Hooks

**Not recommended for production**, but for testing:

```bash
git commit --no-verify -m "commit message"
```

## Configuration Files

- `.eslintrc.js` - ESLint configuration
- `.prettierrc.json` - Prettier configuration
- `.prettierignore` - Prettier ignore patterns
- `src-tauri/.clippy.toml` - Clippy configuration
- `src-tauri/rustfmt.toml` - Rustfmt configuration
- `.vscode/settings.json` - VS Code integration settings

## VS Code Integration

The project includes VS Code settings for:

- Format on save
- ESLint integration
- Rust analyzer configuration
- Automatic code actions

## Recommended VS Code Extensions

- ESLint (dbaeumer.vscode-eslint)
- Prettier (esbenp.prettier-vscode)
- Rust Analyzer (rust-lang.rust-analyzer)
- Angular Language Service (Angular.ng-template)

## Getting Started

1. Install dependencies: `npm install`
2. The linting tools are automatically configured
3. Pre-commit hooks are set up automatically
4. Start coding with confidence!
