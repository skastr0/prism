# Prism CLI

This package is the npm runner entrypoint for Prism.

It exposes the `prism` command through a small Node launcher and delegates to the matching prebuilt Bun standalone binary package for the current platform.

```bash
npx @skastr0/prism --version
bunx @skastr0/prism --version
pnpm dlx @skastr0/prism --version
```

The source repository and package documentation live at <https://github.com/skastr0/prism>.
