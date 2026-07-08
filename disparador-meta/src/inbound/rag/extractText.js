import { createRequire } from 'node:module';
import mammoth from 'mammoth';
import { HttpError } from '../meta/httpError.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const TEXT_MIME = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/html',
]);

function extensionFromName(filename) {
  const match = String(filename ?? '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? '';
}

function mimeFromFile(file) {
  const explicit = String(file?.mimetype ?? '').split(';')[0].trim().toLowerCase();
  if (explicit && explicit !== 'application/octet-stream') return explicit;

  const ext = extensionFromName(file?.originalname);
  const byExt = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    html: 'text/html',
  };
  return byExt[ext] ?? explicit;
}

async function extractPdf(buffer) {
  const result = await pdfParse(buffer);
  return String(result?.text ?? '').trim();
}

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return String(result?.value ?? '').trim();
}

function extractPlain(buffer) {
  return buffer.toString('utf8').trim();
}

export async function extractTextFromFile(file) {
  if (!file?.buffer?.length) {
    throw new HttpError('Arquivo do documento é obrigatório', 400);
  }

  const mime = mimeFromFile(file);
  const filename = file.originalname || 'documento';

  let text = '';

  if (mime === 'application/pdf' || extensionFromName(filename) === 'pdf') {
    text = await extractPdf(file.buffer);
  } else if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    extensionFromName(filename) === 'docx'
  ) {
    text = await extractDocx(file.buffer);
  } else if (TEXT_MIME.has(mime) || ['txt', 'md', 'csv', 'json', 'html'].includes(extensionFromName(filename))) {
    text = extractPlain(file.buffer);
  } else {
    throw new HttpError(
      `Formato não suportado (${mime || filename}). Use PDF, DOCX, TXT, MD ou CSV.`,
      400,
    );
  }

  if (!text) {
    throw new HttpError('Não foi possível extrair texto do documento', 400);
  }

  return text;
}

export async function extractTextFromPlain(text) {
  const normalized = String(text ?? '').trim();
  if (!normalized) {
    throw new HttpError('Texto do conhecimento é obrigatório', 400);
  }
  return normalized;
}
