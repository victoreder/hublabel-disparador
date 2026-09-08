import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from '../meta/httpError.js';

const MIME_OGG = 'audio/ogg';

function jaEhOggOpus(mimetype, originalname) {
  const mime = String(mimetype || '').toLowerCase();
  const name = String(originalname || '').toLowerCase();
  return (
    mime.includes('ogg') ||
    mime.includes('opus') ||
    name.endsWith('.ogg') ||
    name.endsWith('.opus')
  );
}

function converterComFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        inputPath,
        '-c:a',
        'libopus',
        '-b:a',
        '48k',
        '-ar',
        '48000',
        '-ac',
        '1',
        '-vn',
        '-f',
        'ogg',
        outputPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    proc.on('error', (error) => {
      if (error?.code === 'ENOENT') {
        reject(new HttpError('ffmpeg nao encontrado para converter o audio.', 500));
        return;
      }
      reject(error);
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new HttpError(`Falha ao converter audio para ogg/opus. ${stderr.trim()}`.trim(), 502));
    });
  });
}

export async function prepararAudioOficial(file) {
  if (!file?.buffer?.length) throw new HttpError('Arquivo obrigatorio.', 400);

  if (jaEhOggOpus(file.mimetype, file.originalname)) {
    return {
      buffer: file.buffer,
      originalname: String(file.originalname || 'audio.ogg').replace(/\.[^.]+$/, '') + '.ogg',
      mimetype: MIME_OGG,
      convertido: false,
    };
  }

  const id = randomUUID();
  const inputPath = join(tmpdir(), `${id}-in`);
  const outputPath = join(tmpdir(), `${id}.ogg`);

  await writeFile(inputPath, file.buffer);
  try {
    await converterComFfmpeg(inputPath, outputPath);
    const buffer = await readFile(outputPath);
    if (!buffer.length) throw new HttpError('Conversao de audio gerou arquivo vazio.', 502);
    return {
      buffer,
      originalname: 'audio.ogg',
      mimetype: MIME_OGG,
      convertido: true,
    };
  } finally {
    await Promise.all([unlink(inputPath).catch(() => {}), unlink(outputPath).catch(() => {})]);
  }
}
