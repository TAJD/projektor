import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,tsx,ts,js}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: 'var(--accent)',
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'text-base': 'var(--text)',
        'text-muted': 'var(--text-muted)',
        border: 'var(--border)',
      },
      typography: () => ({
        DEFAULT: {
          css: {
            color: 'var(--text)',
            a: { color: 'var(--accent)', '&:hover': { opacity: '0.8' } },
            'h1,h2,h3,h4': { color: 'var(--text)' },
            code: { color: 'var(--code-color)', background: 'var(--code-bg)', borderRadius: '4px', padding: '0.1em 0.3em' },
            'code::before': { content: '""' },
            'code::after': { content: '""' },
            pre: { color: 'var(--code-color)', background: 'var(--code-bg)', border: '1px solid var(--border)' },
            'pre code': { background: 'transparent', padding: '0' },
            strong: { color: 'var(--text-strong)', fontWeight: '600' },
            em: { color: 'inherit' },
            blockquote: { borderLeftColor: 'var(--accent)', color: 'var(--text-muted)' },
            'thead th': { color: 'var(--text)' },
            hr: { borderColor: 'var(--border)' },
          },
        },
      }),
    },
  },
  plugins: [typography],
};
