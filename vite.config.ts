import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_PORT = Number(process.env.WC_PORT ?? 8787);

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'local-nexus-runtime',
      configureServer(server) {
        server.middlewares.use('/nexus-runtime/', (req, res, next) => {
          const name = req.url?.split('?')[0]?.replace(/^\//, '');
          if (!name || !/^ort-wasm-simd-threaded(?:\.jsep)?\.(?:wasm|mjs)$/.test(name))
            return next();
          res.setHeader(
            'Content-Type',
            name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
          );
          res.end(
            readFileSync(join(import.meta.dirname, 'node_modules/onnxruntime-web/dist', name)),
          );
        });
      },
      generateBundle() {
        for (const suffix of ['.wasm', '.mjs', '.jsep.wasm', '.jsep.mjs']) {
          const name = `ort-wasm-simd-threaded${suffix}`;
          this.emitFile({
            type: 'asset',
            fileName: `nexus-runtime/${name}`,
            source: readFileSync(
              join(import.meta.dirname, 'node_modules/onnxruntime-web/dist', name),
            ),
          });
        }
      },
    },
  ],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
        // Generation is SSE — buffering would break token streaming.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache, no-transform';
          });
          proxy.on('proxyReq', (proxyReq, _req, res) => {
            res.on('close', () => {
              if (!res.writableEnded) proxyReq.destroy();
            });
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
