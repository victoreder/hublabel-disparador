import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export function createS3Client(s3Config) {
  return new S3Client({
    endpoint: s3Config.endpoint,
    region: s3Config.region,
    credentials: {
      accessKeyId: s3Config.accessKeyId,
      secretAccessKey: s3Config.secretAccessKey,
    },
    forcePathStyle: s3Config.forcePathStyle,
  });
}

export async function uploadBuffer({ client, bucket, key, body, contentType }) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    }),
  );
}

export function sanitizeS3FileName(fileName, fallback = 'arquivo') {
  const cleaned = String(fileName || '')
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1F\x7F]/g, '_');

  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned;
}

export function withFileExtension(fileName, ext) {
  const cleanExt = String(ext || '').replace(/^\.+/, '').trim();
  if (!cleanExt || /\.[^./\\]+$/.test(fileName)) return fileName;
  return `${fileName}.${cleanExt}`;
}

export function buildPublicS3Url(publicBaseUrl, key) {
  const encodedKey = String(key || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

  return `${String(publicBaseUrl || '').replace(/\/+$/, '')}/${encodedKey}`;
}
