export function normalizeMediaType(tipoArquivo, url, mime) {
  const t = String(tipoArquivo || '').toLowerCase();
  if (t === 'imagem' || t === 'image') return 'image';
  if (t === 'video') return 'video';
  if (t === 'audio') return 'audio';
  if (t === 'pdf') return 'pdf';
  if (t === 'documento' || t === 'document' || t === 'file') return 'file';

  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf' || m.includes('pdf')) return 'pdf';

  const ext = String(url || '').toLowerCase().split('?')[0].split('.').pop();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm'].includes(ext)) return 'video';
  if (['mp3', 'ogg', 'wav', 'm4a'].includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  return 'file';
}
