#!/usr/bin/env node
/**
 * Career-Ops Web Dashboard — Anthropic API edition
 * Run:  node web-dashboard.mjs
 * Open: http://localhost:3333
 *
 * Requires: ANTHROPIC_API_KEY in .env or environment
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3333;
const BASE = __dirname;
const HTML_FILE = path.join(BASE, 'dashboard', 'web', 'index.html');

// ─── Load .env ────────────────────────────────────────────────────────────────
const ENV_FILE = path.join(BASE, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}


// ─── Context loader ───────────────────────────────────────────────────────────
function readFile(relPath) {
  try { return fs.readFileSync(path.join(BASE, ...relPath.split('/')), 'utf8'); }
  catch { return null; }
}

const MODE_FILES = {
  oferta:           'modes/oferta.md',
  pipeline:         'modes/pipeline.md',
  ofertas:          'modes/ofertas.md',
  tracker:          'modes/tracker.md',
  scan:             'modes/scan.md',
  pdf:              'modes/pdf.md',
  deep:             'modes/deep.md',
  contacto:         'modes/contacto.md',
  apply:            'modes/apply.md',
  'interview-prep': 'modes/interview-prep.md',
  training:         'modes/training.md',
  project:          'modes/project.md',
  batch:            'modes/batch.md',
};

function buildSystemPrompt() {
  const parts = [];
  parts.push('# Career-Ops AI Assistant\n');
  parts.push('You are an AI job search assistant running the career-ops pipeline. You have full access to the candidate\'s CV, profile, and system instructions below.\n');

  const shared = readFile('modes/_shared.md');
  if (shared) parts.push('---\n' + shared);

  const profile = readFile('modes/_profile.md');
  if (profile) parts.push('---\n' + profile);

  const cv = readFile('cv.md');
  if (cv) parts.push('---\n# Candidate CV\n\n' + cv);

  const profileYml = readFile('config/profile.yml');
  if (profileYml) parts.push('---\n# Candidate Profile Config\n\n```yaml\n' + profileYml + '\n```');

  const articleDigest = readFile('article-digest.md');
  if (articleDigest) parts.push('---\n# Article Digest (Proof Points)\n\n' + articleDigest);

  parts.push('---\n# Working Directory\n\nAll files are relative to: ' + BASE);
  parts.push('Today\'s date: ' + new Date().toISOString().slice(0, 10));

  // List existing reports for context
  try {
    const reports = fs.readdirSync(path.join(BASE, 'reports')).filter(f => f.endsWith('.md'));
    if (reports.length) {
      parts.push('Existing reports: ' + reports.slice(-10).join(', '));
    }
  } catch {}

  return parts.join('\n\n');
}

function buildUserMessage(body) {
  const parts = [];

  // Load the mode instruction file
  const modeFile = body.mode && MODE_FILES[body.mode] ? readFile(MODE_FILES[body.mode]) : null;
  if (modeFile) {
    parts.push('# Mode Instructions\n\n' + modeFile);
    parts.push('---');
  }

  // Attach user inputs
  if (body.url && body.url.trim()) {
    parts.push('**Job URL:** ' + body.url.trim());
  }
  if (body.jdText && body.jdText.trim()) {
    parts.push('**Job Description:**\n\n' + body.jdText.trim());
  }
  if (body.company && body.company.trim()) {
    parts.push('**Company:** ' + body.company.trim());
  }
  if (body.extra && body.extra.trim()) {
    parts.push('**Additional context:** ' + body.extra.trim());
  }

  // If no mode instructions, just send the raw message
  if (!modeFile && !parts.length) {
    return body.message || '/career-ops';
  }

  return parts.join('\n\n');
}

// ─── Job runner (SSE-based, Anthropic streaming) ──────────────────────────────
// Each job: { chunks[], done, error, clients[], abortController }
const jobs = new Map();

async function runJob(body) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = { id, chunks: [], done: false, error: null, clients: [], abortController: new AbortController() };
  jobs.set(id, job);

  function broadcast(chunk) {
    job.chunks.push(chunk);
    const line = 'data: ' + JSON.stringify(chunk) + '\n\n';
    job.clients.forEach(c => { try { c.write(line); } catch {} });
  }

  // Run async, don't await here
  (async () => {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error('ANTHROPIC_API_KEY not set. Please configure it in Settings.');

      const client = new Anthropic({ apiKey: key });
      const systemPrompt = buildSystemPrompt();

      // For chat mode: use provided messages array; for commands: build fresh
      let messages;
      if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) {
        messages = body.messages; // already formatted { role, content }
      } else if (body.message) {
        messages = [{ role: 'user', content: body.message }];
      } else {
        const userMsg = buildUserMessage(body);
        messages = [{ role: 'user', content: userMsg }];
      }

      // .stream() is synchronous — do NOT await it
      const stream = client.messages.stream({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 8096,
        system: systemPrompt,
        messages,
      });

      // Wire up abort
      job.abortController.signal.addEventListener('abort', () => stream.abort());

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          broadcast({ type: 'out', text: event.delta.text });
        }
      }

      job.done = true;
      broadcast({ type: 'done', code: 0 });
    } catch (err) {
      job.done = true;
      job.error = err.message;
      const aborted = err.name === 'AbortError' || err.name === 'APIUserAbortError' || job.abortController.signal.aborted;
      if (!aborted) {
        broadcast({ type: 'err', text: '\n[Error] ' + err.message + '\n' });
      }
      broadcast({ type: 'done', code: aborted ? 0 : 1 });
    }

    job.clients.forEach(c => { try { c.end(); } catch {} });
    job.clients = [];
    setTimeout(() => jobs.delete(id), 10 * 60 * 1000);
  })();

  return id;
}

// ─── Data helpers ─────────────────────────────────────────────────────────────
function parseApplications() {
  try {
    const raw = fs.readFileSync(path.join(BASE, 'data', 'applications.md'), 'utf8');
    const apps = [];
    for (const line of raw.split('\n')) {
      if (!line.startsWith('|')) continue;
      const cols = line.split('|').slice(1, -1).map(s => s.trim());
      if (cols.length < 8) continue;
      const [num, date, company, role, score, status, pdf, report, ...rest] = cols;
      if (!num || num === '#' || /^[-\s]+$/.test(num)) continue;
      if (company === 'Company') continue;
      const rm = report && report.match(/\[(\d+)\]\((.*?)\)/);
      apps.push({
        num: parseInt(num) || 0, date, company, role,
        score: parseFloat(score) || 0, status,
        pdf: !!(pdf && pdf.includes('\u2705')),
        reportPath: rm ? rm[2] : null,
        notes: rest.join(' | ').trim(),
      });
    }
    return apps.filter(a => a.company);
  } catch { return []; }
}

function parsePipeline() {
  try {
    const raw = fs.readFileSync(path.join(BASE, 'data', 'pipeline.md'), 'utf8');
    const pending = [], processed = [];
    let section = 'pending';
    for (const line of raw.split('\n')) {
      if (/##\s*(Procesadas|Processed)/i.test(line)) { section = 'processed'; continue; }
      if (/##\s*(Pendientes|Pending)/i.test(line)) { section = 'pending'; continue; }
      const pm = line.match(/^- \[ \] (.+)/);
      const dm = line.match(/^- \[x\] (.+)/i);
      const m = pm || dm;
      if (!m) continue;
      const parts = m[1].split(' | ');
      const entry = { url: (parts[0]||'').trim(), company: (parts[1]||'').trim(), title: (parts[2]||'').trim(), done: !!dm };
      if (dm || section === 'processed') processed.push(entry);
      else pending.push(entry);
    }
    return { pending, processed };
  } catch { return { pending: [], processed: [] }; }
}

function listReports() {
  try {
    return fs.readdirSync(path.join(BASE, 'reports'))
      .filter(f => f.endsWith('.md'))
      .sort((a, b) => b.localeCompare(a))
      .map(f => {
        const m = f.match(/^(\d+)-(.+)-(\d{4}-\d{2}-\d{2})\.md$/);
        return { filename: f, num: m ? m[1] : '', slug: m ? m[2] : f.replace('.md',''), date: m ? m[3] : '' };
      });
  } catch { return []; }
}

function computeStats(apps) {
  const bd = {};
  let sum = 0, cnt = 0;
  for (const a of apps) {
    bd[a.status] = (bd[a.status] || 0) + 1;
    if (a.score > 0) { sum += a.score; cnt++; }
  }
  return {
    total: apps.length,
    evaluated: bd['Evaluated'] || 0, applied: bd['Applied'] || 0,
    interview: bd['Interview'] || 0, offer: bd['Offer'] || 0,
    rejected: bd['Rejected'] || 0, discarded: bd['Discarded'] || 0,
    responded: bd['Responded'] || 0, skip: bd['SKIP'] || 0,
    avgScore: cnt > 0 ? (sum / cnt).toFixed(2) : null,
    breakdown: bd,
  };
}

function updateApplicationStatus(num, newStatus) {
  const fp = path.join(BASE, 'data', 'applications.md');
  const lines = fs.readFileSync(fp, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('|')) continue;
    const cols = lines[i].split('|');
    if (parseInt((cols[1]||'').trim()) === num) {
      cols[6] = ' ' + newStatus + ' ';
      lines[i] = cols.join('|');
      break;
    }
  }
  fs.writeFileSync(fp, lines.join('\n'), 'utf8');
}

function addToPipeline(url, company, title) {
  const fp = path.join(BASE, 'data', 'pipeline.md');
  let content = fs.readFileSync(fp, 'utf8');
  const parts = [url];
  if (company) parts.push(company);
  if (title) parts.push(title);
  const entry = '- [ ] ' + parts.join(' | ');
  if (/##\s*(Pendientes|Pending)/i.test(content)) {
    content = content.replace(/##\s*(Pendientes|Pending)\s*\n/, m => m + entry + '\n');
  } else {
    content += '\n' + entry + '\n';
  }
  fs.writeFileSync(fp, content, 'utf8');
}

function saveJD(filename, content) {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = path.join(BASE, 'jds');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, safe), content, 'utf8');
  return safe;
}

// API key management (stored in .env)
function getApiKey() {
  return process.env.ANTHROPIC_API_KEY || null;
}

function setApiKey(key) {
  process.env.ANTHROPIC_API_KEY = key;
  // Persist to .env
  let envContent = '';
  if (fs.existsSync(ENV_FILE)) {
    envContent = fs.readFileSync(ENV_FILE, 'utf8');
    envContent = envContent.replace(/^ANTHROPIC_API_KEY=.*$/m, '');
    envContent = envContent.replace(/\n+/g, '\n').trim();
    if (envContent) envContent += '\n';
  }
  envContent += 'ANTHROPIC_API_KEY=' + key + '\n';
  fs.writeFileSync(ENV_FILE, envContent, 'utf8');
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function jsonRes(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // ── Run a career-ops command via Anthropic API ──
    if (urlPath === '/api/run' && method === 'POST') {
      const body = await readBody(req);

      if (!process.env.ANTHROPIC_API_KEY) {
        jsonRes(res, { error: 'ANTHROPIC_API_KEY not configured. Go to Settings to add your key.' }, 400);
        return;
      }

      // Save inline JD text to a temp file
      if (body.jdText && body.jdText.trim()) {
        const fname = 'temp-' + Date.now() + '.md';
        saveJD(fname, body.jdText);
        body.jdRef = 'jds/' + fname;
        // Add to the message context
        body._jdSaved = fname;
      }

      const jobId = await runJob(body);
      jsonRes(res, { jobId });

    // ── SSE stream ──
    } else if (urlPath.startsWith('/api/stream/') && method === 'GET') {
      const jobId = urlPath.slice('/api/stream/'.length);
      const job = jobs.get(jobId);
      if (!job) { jsonRes(res, { error: 'Not found' }, 404); return; }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      for (const chunk of job.chunks) {
        res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      }
      if (job.done) {
        res.write('data: ' + JSON.stringify({ type: 'done', code: job.error ? 1 : 0 }) + '\n\n');
        res.end();
      } else {
        job.clients.push(res);
        req.on('close', () => { job.clients = job.clients.filter(c => c !== res); });
      }

    // ── Kill a job ──
    } else if (urlPath.startsWith('/api/kill/') && method === 'POST') {
      const jobId = urlPath.slice('/api/kill/'.length);
      const job = jobs.get(jobId);
      if (job && !job.done && job.abortController) {
        job.abortController.abort();
      }
      jsonRes(res, { ok: true });

    // ── API key management ──
    } else if (urlPath === '/api/settings/apikey' && method === 'GET') {
      const key = getApiKey();
      jsonRes(res, { configured: !!key, preview: key ? key.slice(0, 7) + '...' + key.slice(-4) : null });

    } else if (urlPath === '/api/settings/apikey' && method === 'POST') {
      const body = await readBody(req);
      if (!body.key || !body.key.startsWith('sk-ant-')) {
        jsonRes(res, { error: 'Invalid key. Must start with sk-ant-' }, 400); return;
      }
      setApiKey(body.key.trim());
      jsonRes(res, { ok: true });

    // ── Data APIs ──
    } else if (urlPath === '/api/stats' && method === 'GET') {
      const apps = parseApplications();
      const pip = parsePipeline();
      jsonRes(res, { ...computeStats(apps), pipelinePending: pip.pending.length });

    } else if (urlPath === '/api/applications' && method === 'GET') {
      jsonRes(res, parseApplications());

    } else if (/^\/api\/applications\/\d+\/status$/.test(urlPath) && method === 'PUT') {
      const num = parseInt(urlPath.split('/')[3]);
      const body = await readBody(req);
      updateApplicationStatus(num, body.status);
      jsonRes(res, { ok: true });

    } else if (urlPath === '/api/pipeline' && method === 'GET') {
      jsonRes(res, parsePipeline());

    } else if (urlPath === '/api/pipeline/add' && method === 'POST') {
      const body = await readBody(req);
      if (!body.url) { jsonRes(res, { error: 'url required' }, 400); return; }
      addToPipeline(body.url, body.company || '', body.title || '');
      jsonRes(res, { ok: true });

    } else if (urlPath === '/api/reports' && method === 'GET') {
      jsonRes(res, listReports());

    } else if (urlPath.startsWith('/api/reports/') && method === 'GET') {
      const filename = path.basename(decodeURIComponent(urlPath.slice('/api/reports/'.length)));
      try {
        jsonRes(res, { content: fs.readFileSync(path.join(BASE, 'reports', filename), 'utf8') });
      } catch { jsonRes(res, { error: 'Not found' }, 404); }

    } else if (urlPath === '/api/cv' && method === 'GET') {
      try { jsonRes(res, { content: fs.readFileSync(path.join(BASE, 'cv.md'), 'utf8') }); }
      catch { jsonRes(res, { content: '' }); }

    } else if (urlPath === '/api/profile' && method === 'GET') {
      try { jsonRes(res, { content: fs.readFileSync(path.join(BASE, 'config', 'profile.yml'), 'utf8') }); }
      catch { jsonRes(res, { content: '' }); }

    } else if (urlPath === '/api/jd' && method === 'POST') {
      const body = await readBody(req);
      const saved = saveJD(body.filename || 'job-description.md', body.content || '');
      jsonRes(res, { ok: true, saved });

    // ── Frontend ──
    } else if (urlPath === '/' || urlPath === '/index.html') {
      try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(HTML_FILE, 'utf8'));
      } catch {
        res.writeHead(500); res.end('Missing: dashboard/web/index.html');
      }
    } else {
      jsonRes(res, { error: 'Not found' }, 404);
    }
  } catch (err) {
    console.error(err);
    jsonRes(res, { error: err.message }, 500);
  }
});

server.listen(PORT, () => {
  const url = 'http://localhost:' + PORT;
  console.log('\n  Career-Ops Web Dashboard (API mode)');
  console.log('  ────────────────────────────────────');
  console.log('  Running at: ' + url);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  ⚠  No ANTHROPIC_API_KEY found. Open the dashboard and go to Settings.\n');
  } else {
    console.log('  ✓  API key loaded\n');
  }
  try {
    const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false }).unref();
  } catch {}
});

process.on('SIGINT', () => { console.log('\n  Shutting down.'); process.exit(0); });
