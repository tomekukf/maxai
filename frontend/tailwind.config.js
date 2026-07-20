/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Branding maxfliz
        brand: { DEFAULT: '#760039', dark: '#5c002d', light: '#8f1a52' }, // burgund
        accent: { DEFAULT: '#108474', dark: '#0c6b5e' }, // turkus
      },
      fontFamily: {
        sans: ['Jost', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.04), 0 6px 16px rgba(0,0,0,0.06)',
      },
    },
  },
  plugins: [],
};
