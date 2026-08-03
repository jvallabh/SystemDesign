import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import mdx from '@astrojs/mdx';

export default defineConfig({
  site: 'https://jvallabh.github.io',
  base: '/SystemDesign',
  output: 'static',
  integrations: [preact({ compat: true }), mdx()],
});
