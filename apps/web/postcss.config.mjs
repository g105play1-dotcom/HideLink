/**
 * Tailwind CSS 4 is wired in through its PostCSS plugin; there is no
 * `tailwind.config.js` any more. Design tokens live in `src/app/globals.css`.
 */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
