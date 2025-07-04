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
