import type Connection from './connection';
import type SocketHandler from './sockethandler';
import type { HttpRequest, HttpResponse } from 'uws';

export default abstract class WebSocket {
    public addCallback?: (connection: Connection) => void;
    public initializedCallback?: () => void;

    protected constructor(
        protected host: string,
        protected port: number,
        protected socketHandler: SocketHandler
    ) {}

    /**
     * Returns an empty response if someone uses HTTP protocol
     * to access the server.
     */

    public httpResponse(response: HttpResponse, request: HttpRequest): void {
        // Paradox fork: serve the pre-built Astro client bundle from /client-dist
        // This lets us run the whole MMO as a single Railway service.
        // If the directory doesn't exist (dev mode), fall back to the original message.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const path = require('node:path');

        let url = request.getUrl() || '/';
        // Strip query string
        let cleanUrl = url.split('?')[0];

        // Resolve from a well-known absolute path — dist is copied to /app/client-dist
        // in the Dockerfile. Using process.cwd() would break after we changed WORKDIR
        // to /app/packages/server so Kaetram's ../../.env.defaults lookup succeeds.
        let clientRoot = process.env.PARADOX_CLIENT_DIST || '/app/client-dist';

        if (!fs.existsSync(clientRoot)) {
            response.writeStatus('200 OK');
            response.end('Paradox MMO server is running. The client bundle is not mounted here.');
            return;
        }

        // Map / to /index.html
        let filePath = cleanUrl === '/' ? '/index.html' : cleanUrl;
        let absolute = path.join(clientRoot, filePath);

        // Guard against path traversal
        if (!absolute.startsWith(clientRoot)) {
            response.writeStatus('403 Forbidden').end('forbidden');
            return;
        }

        // SPA fallback: if the file doesn't exist, serve index.html
        if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) {
            absolute = path.join(clientRoot, 'index.html');
        }

        if (!fs.existsSync(absolute)) {
            response.writeStatus('404 Not Found').end('not found');
            return;
        }

        // Minimal MIME map — covers what Astro produces
        let ext = path.extname(absolute).toLowerCase();
        let mimeMap: Record<string, string> = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.mjs': 'application/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
            '.ico': 'image/x-icon',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
            '.txt': 'text/plain; charset=utf-8',
            '.xml': 'application/xml',
            '.webmanifest': 'application/manifest+json'
        };
        let mime = mimeMap[ext] || 'application/octet-stream';

        // Streaming would be ideal but simple readFileSync keeps the diff tiny
        let buffer = fs.readFileSync(absolute);
        response.writeStatus('200 OK').writeHeader('Content-Type', mime);

        // Long-cache hashed assets (Astro emits hashed filenames under /_astro/)
        if (cleanUrl.startsWith('/_astro/') || /\.[a-f0-9]{8,}\./.test(cleanUrl))
            response.writeHeader('Cache-Control', 'public, max-age=31536000, immutable');

        response.end(buffer);
    }

    /**
     * Callback for when a connection is added.
     * @param callback Contains the connection that was just added.
     */

    public onAdd(callback: (connection: Connection) => void): void {
        this.addCallback = callback;
    }

    /**
     * Callback for when the web socket has finished initializing.
     */

    public onInitialize(callback: () => void): void {
        this.initializedCallback = callback;
    }
}
