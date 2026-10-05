// Filled after deploying trial/. Keep the paid trial control plane separate from
// the encrypted caption-room relay so each service has one narrow trust boundary.
// api.capsie.io, not *.workers.dev, which mainland China blocks (#419);
// the workers.dev address still answers for older pages and app builds.
export const TRIAL_BROKER_URL = 'https://api.capsie.io';
