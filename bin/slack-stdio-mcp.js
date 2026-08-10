#!/usr/bin/env node
/**
 * CLI entry for the `slack-stdio-mcp` bin (stable path for npm/npx).
 * Loads the ESM server entry; that module runs the bridge on import.
 */
import "../src/server.mjs";
