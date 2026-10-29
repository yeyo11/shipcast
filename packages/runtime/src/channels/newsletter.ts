import { batchReader } from '@shipcast/engine';
import { Brevo } from '@shipcast/connectors';
import { newsletter, tagHtmlLinks, utmFor } from '@shipcast/schema';
import { channelAdapter } from './adapter.ts';

/** The newsletter, sent through Brevo: one campaign per language to brand.yml's lists, and its numbers */
export const newsletterAdapter = channelAdapter({
  definition: newsletter,
  connect: {
    kind: 'account',
    provider: 'Brevo',
    network: {
      id: 'brevo',
      auth: 'form',
      fields: [{ key: 'apiKey', label: 'API key', secret: true }],
      permissions: ['Creates and sends one campaign per language', 'Reads sends, opens, clicks and unsubscribes'],
      howTo: 'Brevo → Settings → SMTP & API → API keys → Generate a new API key. The sender and lists live in brand.yml.',
      env: [{ name: 'BREVO_API_KEY', key: 'apiKey', secret: true }],
      build: ({ need, fetch }) => {
        const connector = new Brevo({ apiKey: need('apiKey'), fetch });
        return { connector, check: () => connector.check(), profileStats: () => connector.profileStats() };
      },
    },
  },
  // Without lists in brand.yml there is nobody to send it to
  usable: (brand) => Boolean(brand.newsletter),
  // Each issue's links, its button and its body's, say which language's list the visit came from
  publisher: (c) => ({
    subscribers: (listId) => c.subscribers(listId),
    send: (campaign, tracking) => c.send(tracking ? { ...campaign, html: tagHtmlLinks(campaign.html, tracking.site, utmFor('newsletter', tracking.campaign, tracking.lang)) } : campaign),
  }),
  // One piece a call for the six-hourly reads as they were; many per call for the hourly ones
  metrics: (c) => ({ metrics: (id: string) => c.metrics(id), read: batchReader((ids) => c.metricsMany(ids)).read }),
});
