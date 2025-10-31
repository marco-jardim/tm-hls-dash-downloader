# Contributing Guide

Thanks for your interest in contributing! This project is small and straightforward, and we welcome improvements.

## Ways to contribute
- Report bugs or edge cases
- Improve parsing for HLS/DASH variants
- Refine UI/UX
- Documentation and examples
- Performance or reliability improvements

## Getting started
1. Fork the repo and create your branch:
   ```bash
   git checkout -b feat/short‑description
   ```
2. Make your changes in `src/hls-dash-downloader.user.js` (or docs).
3. Run through the **Manual test checklist** below.
4. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add support for EXT-X-MAP
   fix: handle relative DASH segment paths
   docs: clarify install steps
   ```
5. Push your branch and open a Pull Request.

## Manual test checklist
- [ ] HLS playlist with explicit segments
- [ ] HLS master playlist (confirm failure mode is clear, or improve handling)
- [ ] DASH manifest with `media="..."` segments
- [ ] Cross‑origin segments via `GM_xmlhttpRequest`
- [ ] Large file (>500 MB) memory behavior
- [ ] File plays in at least one common player

## Coding style
- Keep the userscript self‑contained and dependency‑free.
- Prefer clear, defensive code to micro‑optimizations.
- Avoid breaking sites by being too invasive in the page; keep hooks small and safe.

## Opening issues
When filing a bug, include:
- Browser and version
- Userscript manager and version (e.g., Tampermonkey)
- A public test URL if possible (or repro steps)
- Console logs / errors

## License
By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
