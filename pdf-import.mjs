#!/usr/bin/env node

/**
 * pdf-import.mjs — Import a PDF resume into career-ops
 *
 * Reads any PDF resume, sends it to Claude for structured markdown
 * extraction, and saves the result as cv.md (the canonical CV source).
 *
 * Usage:
 *   node pdf-import.mjs <path/to/resume.pdf>
 *   node pdf-import.mjs <path/to/resume.pdf> --output cv.md
 *   node pdf-import.mjs <path/to/resume.pdf> --dry-run
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// ── Argument parsing ────────────────────────────────────────────────

const args = process.argv.slice(2);
let pdfPath = null;
let outputPath = 'cv.md';
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') {
    dryRun = true;
  } else if (args[i] === '--output' && args[i + 1]) {
    outputPath = args[++i];
  } else if (!pdfPath) {
    pdfPath = args[i];
  }
}

if (!pdfPath) {
  console.error('Usage: node pdf-import.mjs <path/to/resume.pdf> [--output cv.md] [--dry-run]');
  console.error('');
  console.error('Options:');
  console.error('  --output <file>   Output file (default: cv.md)');
  console.error('  --dry-run         Preview extracted content without writing');
  process.exit(1);
}

// ── Validate input ──────────────────────────────────────────────────

const resolvedPdfPath = resolve(pdfPath);

if (!existsSync(resolvedPdfPath)) {
  console.error(`Error: File not found: ${resolvedPdfPath}`);
  process.exit(1);
}

if (!resolvedPdfPath.toLowerCase().endsWith('.pdf')) {
  console.error(`Error: Input file must be a .pdf file. Got: ${resolvedPdfPath}`);
  process.exit(1);
}

// ── Read PDF ────────────────────────────────────────────────────────

console.log(`📄 Reading: ${resolvedPdfPath}`);

const pdfBuffer = readFileSync(resolvedPdfPath);
const pdfBase64 = pdfBuffer.toString('base64');
const fileSizeKB = (pdfBuffer.length / 1024).toFixed(1);

console.log(`📦 Size: ${fileSizeKB} KB`);
console.log(`🤖 Extracting CV content via Claude...\n`);

// ── Call Claude ─────────────────────────────────────────────────────

const response = await client.messages.create({
  model: 'claude-opus-4-6',
  max_tokens: 4096,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: pdfBase64,
          },
        },
        {
          type: 'text',
          text: `Convert this PDF resume into clean, well-structured Markdown.

Requirements:
- Use standard CV sections as H2 headers (## Summary, ## Experience, ## Projects, ## Education, ## Skills, ## Certifications). Omit sections that are empty.
- For each Experience entry:
  - ### Company Name
  - **Role Title** | Location | Start – End (or Present)
  - Bullet points (-) for achievements and responsibilities
- Preserve all metrics, numbers, and achievements exactly as written — do NOT paraphrase or summarize
- Skills section: group by category if applicable (e.g., Languages, Frameworks, Tools, Databases)
- Keep dates in their original format
- Output ONLY the Markdown — no preamble, no explanation, no code fences`,
        },
      ],
    },
  ],
});

const markdown = response.content[0].text;

// ── Preview ─────────────────────────────────────────────────────────

const previewLength = 600;
console.log('--- Preview ---');
console.log(markdown.slice(0, previewLength));
if (markdown.length > previewLength) console.log('... (truncated)');
console.log('---------------\n');

// ── Write output ────────────────────────────────────────────────────

if (dryRun) {
  console.log(`(dry run — not written)`);
  console.log(`\nFull output: ${markdown.length} characters`);
  console.log(`Would save to: ${outputPath}`);
} else {
  if (existsSync(outputPath)) {
    const existing = readFileSync(outputPath, 'utf-8');
    if (existing.trim().length > 0) {
      const existingKB = (existing.length / 1024).toFixed(1);
      console.log(`⚠️  ${outputPath} already exists (${existingKB} KB). Overwriting.`);
    }
  }

  writeFileSync(outputPath, markdown, 'utf-8');
  const writtenKB = (markdown.length / 1024).toFixed(1);
  console.log(`✅ Saved to ${outputPath} (${writtenKB} KB)`);
  console.log(`\nNext steps:`);
  console.log(`  1. Review ${outputPath} and correct any extraction errors`);
  console.log(`  2. Run: node cv-sync-check.mjs`);
  console.log(`  3. Paste a job URL or run: node scan.mjs`);
}
