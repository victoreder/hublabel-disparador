module.exports = {
  content: [process.env.TW_CONTENT],
  theme: { extend: {
    fontFamily: { sans: ['"Plus Jakarta Sans"', 'sans-serif'] },
    colors: { brand: { 50: '#ecfdf5', 100: '#d1fae5', 500: '#25D366', 600: 'color-mix(in srgb, #25D366 82%, #000000)', 700: '#047857' }, wa: { light: '#dcf8c6', dark: '#075e54' }, surface: '#fbfcfd' },
    boxShadow: { soft: '0 8px 32px rgba(0, 0, 0, 0.03)' } } },
};
