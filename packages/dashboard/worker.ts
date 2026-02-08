// Simple CF Worker to serve the dashboard as a static site
import html from './dist/index.html'

export default {
  async fetch(request: Request): Promise<Response> {
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'public, max-age=60',
      },
    })
  },
}
