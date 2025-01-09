import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

// Increment and deploy to invalidate cache
const CACHE_NAME = 'items-v1';

// Shopify API stuff
const BASE_URL = 'https://www.blackwhiteroasters.com';
const SECTION_NAME = 'specialty-instant-coffee';
const PRODUCTS_ENDPOINT = `${BASE_URL}/collections/${SECTION_NAME}/products.json`;

const ShopifyProductsSchema = z.object({
	products: z.array(
		z.object({
			title: z.string(),
			handle: z.string(),
			variants: z.array(
				z.object({
					title: z.string(),
					available: z.boolean(),
					price: z.string(),
					updated_at: z.string(),
				})
			),
		})
	),
});

interface Coffee {
	title: string;
	handle: string;
	price: string;
	updatedAt: Date;
}

export default {
	async scheduled(event, env, ctx) {
		try {
			await sendDiagnostic(env, 'Bot started');

			const { coffees, cacheRepr, updatedAt } = await getAvailableCoffees(env);

			if ((await env.instant_coffee.get(CACHE_NAME)) === cacheRepr) {
				await sendDiagnostic(env, 'No products changed, skipping');
			} else {
				let botMessage: string[] = [];

				if (coffees.length === 0) {
					botMessage.push('Black & White no longer has any instant coffees available.');
				} else {
					botMessage.push('Black & White has a new selection of instant coffees:');
					for (let coffee of coffees) {
						const price = `$${coffee.price}`;
						botMessage.push(`- ☕️ ${coffee.title.replace(' - Instant Coffee', '')} (${price})`);
					}

					botMessage.push(`→ [View the collection](${BASE_URL}/collections/${SECTION_NAME})`);
				}

				if (updatedAt) {
					botMessage.push(
						`-# Black & White's instant coffee inventory last changed on ${new Date(updatedAt).toLocaleTimeString('en-US', {
							month: 'long',
							day: 'numeric',
							year: 'numeric',
							timeZone: 'UTC',
						})} UTC.`
					);
				}

				env.instant_coffee.put(CACHE_NAME, cacheRepr);
				await sendFriendlyMessage(env, botMessage.join('\n'));
			}

			await sendDiagnostic(env, 'Bot finished successfully');
		} catch (error) {
			await sendDiagnostic(env, `Bot failed: ${(error as any).message}`);
			throw error;
		}
	},
} satisfies ExportedHandler<Env>;

async function getAvailableCoffees(env: Env): Promise<{ coffees: Coffee[]; cacheRepr: string; updatedAt: Date | null }> {
	const request = await fetch(PRODUCTS_ENDPOINT, { headers: { 'User-Agent': 'Mozilla/5.0' } });
	const json = await request.json();
	const products = ShopifyProductsSchema.parse(json).products;

	sendDiagnostic(env, 'Received response from Shopify:\n```json\n' + JSON.stringify(products, null, 2) + '\n```');

	const coffees: Coffee[] = products.flatMap((product) => {
		if (product.variants.length !== 1) throw new Error(`Expected exactly one variant per product, response was ${JSON.stringify(product)}`);

		return product.variants
			.filter((variant) => variant.available)
			.map((variant) => {
				return {
					title: product.title,
					handle: product.handle,
					price: variant.price,
					updatedAt: new Date(variant.updated_at),
				};
			})
			.sort((a, b) => a.title.localeCompare(b.title));
	});

	const cacheKey = coffees.map((coffee) => coffee.handle).join('-');

	const updatedAt =
		products.length > 0
			? products
					.flatMap((product) => product.variants)
					.reduce((latest, variant) => (new Date(variant.updated_at) > latest ? new Date(variant.updated_at) : latest), new Date(0))
			: null;

	return { coffees, cacheRepr: cacheKey, updatedAt };
}

async function sendFriendlyMessage(env: Env, message: string) {
	await sendDiscordMessage(env.DISCORD_WEBHOOK_URL, message);
}

async function sendDiagnostic(env: Env, message: string) {
	await sendDiscordMessage(env.DISCORD_WEBHOOK_HEARTBEAT_URL, message);
}

async function sendDiscordMessage(url: string, message: string) {
	await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ content: message }),
	});
}
