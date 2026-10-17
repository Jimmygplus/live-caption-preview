// Filled after deploying relay/. Keeping this in one tiny module lets both the
// host page and QR input page use the same endpoint.
// relay.capsie.io, not *.workers.dev, which mainland China blocks (#419);
// the workers.dev address still answers for older pages and app builds.
export const AUDIENCE_RELAY_URL = 'https://relay.capsie.io';
