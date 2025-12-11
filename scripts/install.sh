#!/bin/bash
set -e

INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="agentpkg"

echo "Installing ${BINARY_NAME}..."

# Create install directory
mkdir -p "$INSTALL_DIR"

# Check if we have a local build
if [ -f "dist/cli.js" ]; then
    echo "Installing from local build..."
    cp "dist/cli.js" "$INSTALL_DIR/$BINARY_NAME"
    chmod +x "$INSTALL_DIR/$BINARY_NAME"
    echo "Successfully installed to $INSTALL_DIR/$BINARY_NAME"
else
    echo "Error: dist/cli.js not found"
    echo "Run 'bun run build' first"
    exit 1
fi

echo ""
echo "Make sure $INSTALL_DIR is in your PATH:"
echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
echo ""
echo "Then run: $BINARY_NAME --help"
