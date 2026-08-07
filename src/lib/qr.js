import QRCode from 'qrcode';

/** QR as an SVG string — scales cleanly on print and event slides. */
export function qrSvg(url) {
  return QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
}

/** QR as a PNG buffer. */
export function qrPng(url, width = 512) {
  return QRCode.toBuffer(url, { type: 'png', width, margin: 1, errorCorrectionLevel: 'M' });
}
