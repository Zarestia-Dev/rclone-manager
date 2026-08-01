<!--
Thank you for contributing to rclone-manager!

Please discuss anything more than a trivial fix in an issue FIRST - see the
"Linked issue" section below. Then fill in the sections below to help us review.
-->

#### What does this change do?

<!-- Describe the change here. -->

#### Linked issue

<!--
Put `Closes #1234` here if this closes an issue, or `#1234` to link without closing.

IMPORTANT: Anything beyond a trivial fix (typo, doc tweak, small obvious bug fix)
should be discussed and agreed in an issue BEFORE you open a pull request.
Pull requests for larger changes that have not been discussed in an issue first
may be closed. This saves everyone's time if the change needs a different approach
or isn't a good fit.
-->

Closes #

#### Type of Change

- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)
- [ ] ✨ New feature (non-breaking change that adds functionality)
- [ ] 💥 Breaking change (fix or feature that would cause existing functionality to change)
- [ ] 📚 Documentation update
- [ ] 🌍 Translation (i18n) update
- [ ] 🔧 Maintenance / Refactoring

#### Platform & Target Testing

- [ ] Desktop (Linux / macOS / Windows)
- [ ] Portable mode
- [ ] Headless / Web Server mode
- [ ] Mobile (Android)

#### Checklist

- [ ] This change is trivial **OR** it has been discussed and agreed in the linked issue.
- [ ] I have read the [contribution guidelines](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).
- [ ] **(If I used AI tools to help write this code)** I have read and understood the AI-assisted contributions guidance in [AGENTS.md](AGENTS.md), and I have compiled, linted, tested, and take full ownership of this change myself.
- [ ] I have run frontend lints (`npx eslint "**/*.{ts,html}"` & `npx prettier --check "**/*.{ts,html,scss,json}"`) or `npm run fix:all`.
- [ ] I have run backend Clippy & formatting checks (`cargo clippy` and `cargo fmt -- --check` in `src-tauri`).
- [ ] I have added tests or updated documentation where appropriate.
- [ ] This Pull Request is ready for review.
