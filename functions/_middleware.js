// Send visitors on the old pages.dev address to the shop's own domain.
// Preview deployments (<hash>.elite-cuts-4qn.pages.dev) are left alone.
const OLD_HOST = 'elite-cuts-4qn.pages.dev';
const NEW_ORIGIN = 'https://elite-cuts-barbershop.app';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname === OLD_HOST) {
    return Response.redirect(NEW_ORIGIN + url.pathname + url.search, 301);
  }
  return context.next();
}
