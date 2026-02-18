# Contributing to RClone Manager

Thank you for your interest in contributing to RClone Manager! We appreciate contributions of all kinds — from bug reports and feature requests to code improvements and documentation updates.

---

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
  - [Reporting Bugs](#reporting-bugs)
  - [Suggesting Features](#suggesting-features)
  - [Contributing Code](#contributing-code)
  - [Improving Documentation](#improving-documentation)
  - [Adding Translations](#adding-translations)
- [Development Setup](#development-setup)
  - [Prerequisites](#prerequisites)
  - [Setting Up the Project](#setting-up-the-project)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
  - [Working on Features](#working-on-features)
  - [Code Style](#code-style)
  - [Testing](#testing)
- [Submitting Changes](#submitting-changes)
  - [Pull Request Process](#pull-request-process)
  - [PR Guidelines](#pr-guidelines)
- [Additional Resources](#additional-resources)

---

## Code of Conduct

We are committed to providing a welcoming and inspiring community for all. Please be respectful and constructive in your interactions with other contributors.

---

## How Can I Contribute?

### Reporting Bugs

If you find a bug, please [open a bug report](https://github.com/Zarestia-Dev/rclone-manager/issues/new?template=bug_report.md) with the following information:

- **Description**: A clear and concise description of the bug
- **Steps to Reproduce**: Detailed steps to reproduce the issue
- **Expected Behavior**: What you expected to happen
- **Actual Behavior**: What actually happened
- **Environment**: OS, version, and any other relevant details
- **Screenshots/Logs**: If applicable, add screenshots or error logs

### Suggesting Features

We love new ideas! To suggest a feature, please [open a feature request](https://github.com/Zarestia-Dev/rclone-manager/issues/new?template=feature_request.md) including:

- **Description**: A clear description of the feature
- **Use Case**: Why this feature would be useful
- **Alternatives**: Any alternative solutions you've considered
- **Additional Context**: Mockups, examples, or references

### Contributing Code

Before starting work on a significant change:

1. **Check existing issues** — See if someone is already working on it
2. **Open a discussion** — For major changes, open an issue to discuss your approach first
3. **Fork the repository** — Create your own fork to work on
4. **Create a branch** — Use a descriptive branch name (e.g., `feat/new-feature` or `fix/bug-name`)

### Improving Documentation

Documentation improvements are always welcome! This includes:

- Fixing typos or clarifying existing docs
- Adding examples or tutorials
- Updating the [Wiki](https://github.com/Zarestia-Dev/rclone-manager/wiki)
- Improving code comments

### Adding Translations

We use BCP-47 language tags (e.g., `en-US`, `tr-TR`, `de-DE`) for internationalization.

> [!IMPORTANT]
> **We use Crowdin for translations.**
> Please contribute translations here: https://crowdin.com/project/rclone-manger
> You can still submit fixes via **Pull Requests** if you prefer.

#### Steps to Add a New Language

1. **Create the translation directory**:

   ```bash
   mkdir -p resources/i18n/YOUR-LANG
   ```

2. **Copy base translation files**:

   ```bash
   cp -r resources/i18n/en-US/* resources/i18n/YOUR-LANG/
   ```

3. **Update the backend schema** (`src-tauri/src/core/settings/schema.rs`):

   Add your language to `SUPPORTED_LANGUAGES` and the language options:

   ```rust
   // Add your BCP-47 code here
   const SUPPORTED_LANGUAGES: &[&str] = &["en-US", "tr-TR", "de-DE"];

   // Add your language option (use native language name)
   options(
       ("en-US", "English (US)"),
       ("tr-TR", "Türkçe (Türkiye)"),
       ("de-DE", "Deutsch (Deutschland)")  // ← New language
   )
   ```

4. **Translate the JSON files**:

   Translate all string values in the files under `resources/i18n/YOUR-LANG/`.
   - `main.json`: General UI strings.
   - `rclone.json`: Rclone flag names and help texts.

   Keep the JSON keys unchanged.

5. **Test your translation**:
   ```bash
   npm run tauri dev
   ```
   Then change the language in Settings → General → Language.

#### Translation Guidelines

- **Use native language names** for the language selector (e.g., "Deutsch" not "German")
- **Keep placeholders intact** — Don't translate `{{variable}}` placeholders
- **Maintain JSON structure** — Only translate string values, not keys
- **Test special characters** — Ensure UTF-8 encoding works correctly
- **Use formal/informal consistently** — Choose one register and stick to it

#### README Translation (Optional but Appreciated!)

If you'd like to go the extra mile, you can also translate the README:

1. Copy `README.md` to `README.YOUR-LANG.md` (e.g., `README.de-DE.md`)
2. Translate the content (keep badges and links working)
3. Add your language to the language selector at the top of all README files:
   ```html
   <p align="center">
     <a href="README.md">English</a> • <a href="README.tr-TR.md">Türkçe</a> •
     <a href="README.de-DE.md">Deutsch</a>
     <!-- New -->
   </p>
   ```

#### BCP-47 Language Codes

Common language codes:
| Code | Language |
|------|----------|
| `en-US` | English (US) |
| `tr-TR` | Turkish (Turkey) |
| `de-DE` | German (Germany) |
| `fr-FR` | French (France) |
| `zh-CN` | Chinese (Simplified) |

### Cron Expressions

The application uses `cronstrue` to display human-readable cron schedules. To support a new language:

1.  **Register the Locale**: Import the locale in `src/app/core/i18n/cron-locale.mapper.ts`.
    ```typescript
    import 'cronstrue/locales/fr'; // Example for French
    ```
2.  **Verify Mapping**: Ensure `getCronstrueLocale` correctly maps your app locale (e.g., `fr-FR`) to the `cronstrue` locale (e.g., `fr`).

---

### Managing Rclone Flags

The Rclone flags (options) are stored in `resources/i18n/{lang}/rclone.json`. These are used to provide translated titles and help text for Rclone's various options.

#### Updating Flag Definitions

To update the flag definitions from a running Rclone instance:

1. **Start the app in dev mode**:

   ```bash
   npm run tauri dev
   ```

2. **Find the RC port**:
   Check the console logs or `ps aux | grep rclone` for the `--rc-addr` port (e.g., `51900`).

3. **Fetch new definitions**:

   ```bash
   curl -X POST http://127.0.0.1:PORT/options/info -d "{}" -o flags.json
   ```

4. **Process and Update**:
   Extract the `Name` and `Help` fields and update the `rclone.json` files. Maintain the flat structure:
   ```json
   {
     "options": {
       "flag_name": {
         "title": "Title",
         "help": "Description"
       }
     }
   }
   ```

---

## Development Setup

### Prerequisites

Before you begin, ensure you have the following installed:

#### Required

- **Node.js** (v18 or higher) and **npm**
- **Rust** (latest stable version via [rustup](https://rustup.rs/))
- **Rclone** (for runtime functionality)

#### Platform-Specific Requirements

- **Linux**: Standard build tools (`build-essential` on Debian/Ubuntu)
- **macOS**: Xcode Command Line Tools
- **Windows**: Visual Studio Build Tools or MSVC

For detailed platform-specific prerequisites, see the [Building Wiki](https://github.com/Zarestia-Dev/rclone-manager/wiki/Building).

### Setting Up the Project

1. **Clone your fork**:

   ```bash
   git clone https://github.com/YOUR_USERNAME/rclone-manager.git
   cd rclone-manager
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Run in development mode**:

   ```bash
   npm run tauri dev
   ```

4. **Run headless mode (development)** (optional):

   ```bash
   npm run headless-dev
   ```

5. **Run headless mode (production)** (optional):

   ```bash
   npm run headless
   ```

---

## Project Structure

```
rclone-manager/
├── .github/           # GitHub workflows and configurations
├── src/               # Angular frontend source code
│   ├── app/          # Application components, services, and modules
│   ├── assets/       # Static assets (images, icons)
│   └── styles/       # Global styles and themes
├── src-tauri/         # Rust backend (Tauri)
│   ├── src/          # Rust source code
│   │   ├── core/     # Core backend logic
│   │   ├── server/   # Web server implementation (headless mode)
│   │   ├── rclone/   # Rclone backend logic
│   │   └── utils/    # Utility functions
│   └── tauri.conf.json # Tauri configuration
│   └── tauri.conf.headless.json # Tauri configuration (headless mode)
│   └── Cargo.toml    # Rust dependencies and configuration
├── headless/          # Headless/web server mode documentation
└── package.json       # Node.js dependencies and scripts
```

### Key Directories

- **`src/app/`**: Angular components, services, and application logic
- **`src-tauri/src/core/`**: Core Rust backend logic (scheduler, settings, security)
- **`src-tauri/src/server/`**: Web server implementation for headless mode
- **`src-tauri/src/rclone/`**: Rclone backend logic
- **`.github/workflows/`**: CI/CD workflows for building and releasing

---

## Development Workflow

### Working on Features

1. **Create a feature branch**:

   ```bash
   git checkout -b feat/your-feature-name
   ```

2. **Make your changes** in the appropriate directory:
   - Frontend changes → `src/`
   - Backend changes → `src-tauri/src/`
   - Documentation → `README.md`, Wiki, or `*.md` files

3. **Test your changes**:

   ```bash
   npm run tauri dev
   ```

4. **Commit your changes** with clear, descriptive messages:
   ```bash
   git commit -m "feat: add new feature description"
   ```

### Code Style

We use automated linting and formatting to maintain code quality. **All code must pass linting checks before being merged.**

#### Frontend (TypeScript/Angular)

- **Linting**: ESLint with Angular-specific rules
- **Formatting**: Prettier

```bash
# Run linter
npm run lint

# Fix linting issues automatically
npm run lint:fix

# Format code
npm run format

# Check formatting
npm run format:check
```

#### Backend (Rust)

- **Linting**: Clippy
- **Formatting**: rustfmt

```bash
# Run Rust linter
npm run lint:rust

# Format Rust code
npm run format:rust

# Check Rust formatting
npm run format:rust:check
```

#### Run All Checks

```bash
# Check everything
npm run lint:all

# Fix everything automatically
npm run fix:all
```

**Note**: We use [Husky](https://typicode.github.io/husky/) and [lint-staged](https://github.com/okonet/lint-staged) to automatically lint and format code on commit. See [LINTING.md](LINTING.md) for detailed information.

### Testing

Currently, the project uses manual testing. We welcome contributions to add automated tests!

**Manual Testing Checklist**:

- Test on your target platform (Linux/macOS/Windows)
- Verify the feature works as expected
- Check for console errors or warnings
- Test edge cases and error handling
- Ensure UI remains responsive

---

## Submitting Changes

### Pull Request Process

1. **Ensure your code passes all checks**:

   ```bash
   npm run lint:all
   ```

2. **Push your branch to your fork**:

   ```bash
   git push origin feat/your-feature-name
   ```

3. **Open a Pull Request** against the `main` branch of the original repository

4. **Fill out the PR template** with:
   - Description of changes
   - Related issue(s)
   - Testing performed
   - Screenshots (if UI changes)

5. **Wait for review** — Maintainers will review your PR and may request changes

6. **Address feedback** — Make requested changes and push updates

7. **Merge** — Once approved, a maintainer will merge your PR

### PR Guidelines

#### Good PR Practices

- ✅ **Keep PRs focused** — One feature or bug fix per PR
- ✅ **Write clear commit messages** — Use [Conventional Commits](https://www.conventionalcommits.org/) format:
  - `feat:` for new features
  - `fix:` for bug fixes
  - `docs:` for documentation
  - `refactor:` for code refactoring
  - `style:` for formatting changes
  - `chore:` for maintenance tasks
- ✅ **Update documentation** — If your PR changes behavior, update relevant docs
- ✅ **Test thoroughly** — Ensure your changes work on your platform
- ✅ **Include screenshots** — For UI changes, include before/after screenshots

#### What to Avoid

- ❌ Large PRs with multiple unrelated changes
- ❌ Committing generated files (`node_modules/`, `dist/`, etc.)
- ❌ Breaking existing functionality without discussion
- ❌ Incomplete or untested features

---

## Additional Resources

### Documentation

- **[Wiki](https://github.com/Zarestia-Dev/rclone-manager/wiki)** — Building instructions, installation guides, and more
- **[LINTING.md](LINTING.md)** — Detailed linting and formatting guide
- **[ISSUES.md](ISSUES.md)** — Known issues and workarounds
- **[CHANGELOG.md](CHANGELOG.md)** — Version history and changes

### Communication

- **[GitHub Issues](https://github.com/Zarestia-Dev/rclone-manager/issues)** — Bug reports and feature requests
- **[GitHub Discussions](https://github.com/Zarestia-Dev/rclone-manager/discussions)** — General questions and ideas
- **[Project Board](https://github.com/users/Zarestia-Dev/projects/2)** — Development roadmap and progress

### Learning Resources

- **[Tauri Documentation](https://tauri.app/)** — Tauri framework docs
- **[Angular Documentation](https://angular.io/)** — Angular framework docs
- **[Rclone Documentation](https://rclone.org/)** — Rclone tool documentation
- **[Rust Book](https://doc.rust-lang.org/book/)** — Learning Rust
- **[TypeScript Handbook](https://www.typescriptlang.org/docs/)** — Learning TypeScript

---

## 🙏 Thank You

Your contributions make RClone Manager better for everyone. We appreciate your time and effort!

---

<p align="center">
  Made with ❤️ by the Zarestia Dev Team and contributors<br>
  <sub>Licensed under GNU GPLv3</sub>
</p>
