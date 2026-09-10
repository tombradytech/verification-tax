import type { APIRoute } from 'astro';
import { SITE } from '../config';

export const GET: APIRoute = () =>
  new Response(
    `User-agent: *\nAllow: /\n\nSitemap: ${SITE.origin}/sitemap-index.xml\n`,
    { headers: { 'content-type': 'text/plain; charset=utf-8' } }
  );
