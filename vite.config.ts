import { defineConfig } from 'vite';

export default defineConfig({
  // Versione della build: serve a rigenerare le miniature salvate dopo un aggiornamento
  define: { __BUILD__: JSON.stringify(Date.now().toString(36)) },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Librerie in file separati: cambiano di rado, il browser le tiene in cache tra un aggiornamento e l'altro
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/@supabase')) return 'supabase';
          return undefined;
        },
      },
    },
  },
});
