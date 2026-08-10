#!/usr/bin/env node
/**
 * @file assert-english.mjs
 * @description Fail if residual Spanish prose remains in tracked project files.
 *
 * Fixed rules (not skeptic-derived wordlists):
 * 1. Spanish-accented letters (and inverted punctuation) via Unicode code points
 * 2. High-precision unaccented Spanish tech lemmas (word-boundary)
 *
 * Usage: node scripts/assert-english.mjs
 * Exit 0 = clean; exit 1 = residuals listed on stderr.
 *
 * This file is excluded from its own scan so the lemma table can list Spanish
 * tokens as detection targets without self-failing.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.resolve(fileURLToPath(import.meta.url));

/** Paths relative to repo root to scan. */
const SCAN_ROOTS = ["src", "test", "docs"];
const SCAN_FILES = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE",
  ".env.example",
  "package.json",
];

/**
 * Accent / inverted-punct classes built from code points so this source file
 * does not contain Spanish characters in its own text.
 */
const ACCENT_RE = new RegExp(
  "[" +
    [
      0xe1, 0xe9, 0xed, 0xf3, 0xfa, 0xf1, 0xfc, // aeiounu with accents
      0xc1, 0xc9, 0xcd, 0xd3, 0xda, 0xd1, 0xdc, // AEIOUNU with accents
      0xbf, 0xa1, // inverted ? !
    ]
      .map((c) => String.fromCharCode(c))
      .join("") +
    "]",
);

/**
 * High-precision unaccented Spanish lemmas (avoid bare de/a/la/el/no/es).
 * Fixed list — expand only for clear Spanish tech prose.
 * Accented forms are covered by ACCENT_RE on any line that still uses them.
 */
const SPANISH_LEMMA_RE = new RegExp(
  String.raw`\b(?:` +
    [
      "otros?",
      "otras?",
      "tambien",
      "requiere",
      "argumentos?",
      "conectad[oa]s?",
      "remotas?",
      "nombres?",
      "falta",
      "documentar",
      "credenciales?",
      "van\\s+a",
      "o\\s+argumentos",
      "debe(?:n)?",
      "por\\s+defecto",
      "sin\\s+token",
      "sin\\s+secret",
      "canonico",
      "invalido",
      "desconocido",
      "fallo",
      "resolviendo",
      "autorizacion",
      "preferi",
      "shippeado",
      "sincronico",
      "deberia",
      "path\\s+escrito",
      "puente",
      "reenvia",
      "mensajes",
      "operador",
      "denego",
      "devolvio",
      "aceptamos",
      "escucha",
      "minimo",
      "clasico",
      "recomendado",
      "aleatorio",
      "coincide",
      "registrado",
      "documentado",
      "normaliza",
      "guarda",
      "promesa",
      "canje",
      "exito",
      "configurado",
      "disponible",
      "respuesta",
      "invalidadas",
      "manualmente",
      "esperando",
      "listo",
      "borra",
      "persiste",
      "exporta",
      "envia",
      "refresca",
      "aisla",
      "deriva",
      "simula",
      "lanza",
      "llama",
      "cuando",
      "tampoco",
      "politica",
      "directorio",
      "margen",
      "validez",
      "setear",
      "reiniciar",
      "extrae",
      "asociad[oa]s?",
      "existia",
      "rotables",
      "emite",
      "fuerza",
      "traen",
    ].join("|") +
    String.raw`)\b`,
  "i",
);

/**
 * @param {string} dir
 * @param {string[]} out
 */
function walkFiles(dir, out) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") {
      continue;
    }
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      walkFiles(full, out);
    } else if (/\.(mjs|js|md|example|json|yml|yaml|toml)$/i.test(name) || name === "LICENSE") {
      out.push(full);
    }
  }
}

/**
 * @returns {string[]}
 */
function collectFiles() {
  /** @type {string[]} */
  const files = [];
  for (const rel of SCAN_ROOTS) {
    walkFiles(path.join(root, rel), files);
  }
  for (const rel of SCAN_FILES) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) {
      files.push(full);
    }
  }
  return [...new Set(files)].filter((f) => path.resolve(f) !== SELF).sort();
}

/**
 * @param {string} filePath
 * @param {string} content
 * @returns {{ kind: string, line: number, text: string }[]}
 */
function scanFile(filePath, content) {
  /** @type {{ kind: string, line: number, text: string }[]} */
  const hits = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;
    if (ACCENT_RE.test(line)) {
      hits.push({ kind: "accent", line: lineNo, text: line.trim().slice(0, 160) });
    }
    if (SPANISH_LEMMA_RE.test(line)) {
      hits.push({ kind: "lemma", line: lineNo, text: line.trim().slice(0, 160) });
    }
  }
  return hits;
}

function main() {
  const files = collectFiles();
  /** @type {{ file: string, kind: string, line: number, text: string }[]} */
  const all = [];

  for (const file of files) {
    const rel = path.relative(root, file);
    if (rel === "package-lock.json") {
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const hit of scanFile(file, content)) {
      all.push({ file: rel, ...hit });
    }
  }

  if (all.length === 0) {
    console.error(
      `[assert-english] OK: scanned ${files.length} files, 0 residual Spanish hits`,
    );
    process.exit(0);
  }

  console.error(
    `[assert-english] FAIL: ${all.length} residual Spanish hit(s) in ${files.length} files`,
  );
  for (const h of all) {
    console.error(`  ${h.file}:${h.line} [${h.kind}] ${h.text}`);
  }
  process.exit(1);
}

main();
