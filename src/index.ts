import { z } from 'zod';
import jwt from 'jsonwebtoken';

// Increment and deploy to invalidate cache
const CACHE_NAME = 'items-v1';

import { compositeImages } from './image';

// Shopify API stuff
const BASE_URL = 'https://www.blackwhiteroasters.com';
const SECTION_NAME = 'specialty-instant-coffee';
const PRODUCTS_ENDPOINT = `${BASE_URL}/collections/${SECTION_NAME}/products.json`;

const ShopifyProductsSchema = z.object({
	products: z.array(
		z.object({
			title: z.string(),
			handle: z.string(),
			published_at: z.string(),
			variants: z.array(
				z.object({
					title: z.string(),
					available: z.boolean(),
					price: z.string(),
				})
			),
			images: z.array(z.object({ src: z.string() })),
		})
	),
});

const JwtPayloadSchema = z.object({
	images: z.array(z.string()),
});

interface Coffee {
	title: string;
	handle: string;
	price: string;
	imageUrl: string;
}

export default {
	async scheduled(event, env, ctx) {
		try {
			await sendDiagnostic(env, 'Bot started');

			const { coffees, cacheRepr, updatedAt } = await getAvailableCoffees(env);

			const imageUrls = coffees.map((coffee) => coffee.imageUrl);
			const imagePayload = JwtPayloadSchema.parse({ images: imageUrls });
			const imageToken = jwt.sign(imagePayload, env.JWT_SECRET);
			const imageUrl = new URL(env.PUBLIC_URL);
			imageUrl.searchParams.set('payload', imageToken);
			const cachedCoffees = await cacheGet(env);

			await sendDiagnostic(env, `Cached: ${cachedCoffees?.join(',') ?? '<none>'}`);
			await sendDiagnostic(env, `New: ${cacheRepr.join(',')}`);

			if (cachedCoffees && arrayIsSubset(cacheRepr, cachedCoffees)) {
				await sendDiagnostic(env, 'No new products, skipping');
			} else {
				await sendDiagnostic(env, '**New products found**');
				let botMessage: string[] = [];

				if (coffees.length === 0) {
					sendDiagnostic(env, 'Black & White no longer has any instant coffees available.');
				} else {
					botMessage.push(`Black & White has a new selection of instant coffees:`);

					for (let coffee of coffees) {
						const price = `$${coffee.price}`;
						botMessage.push(`- ☕️ ${coffee.title.replace(' - Instant Coffee', '')} (${price})`);
					}

					botMessage.push(`→ [View the collection](${BASE_URL}/collections/${SECTION_NAME})`);
				}

				if (updatedAt) {
					botMessage.push(
						`-# Black & White's instant coffee inventory last changed on ${updatedAt.toLocaleTimeString('en-US', {
							month: 'long',
							day: 'numeric',
							year: 'numeric',
							timeZone: 'America/New_York',
						})} ET[.](${imageUrl.toString()})`
						//     ^ To be stealthy with the link.
					);
				}

				cachePut(env, cacheRepr);
				await sendFriendlyMessage(env, botMessage.join('\n'));
			}

			await sendDiagnostic(env, 'Bot finished successfully');
		} catch (error) {
			await sendDiagnostic(env, `Bot failed:\n\`\`\`\n${(error as any).message}\n${(error as any).stack}\n\`\`\``);

			throw error;
		}
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const payload = new URL(request.url).searchParams.get('payload');

		if (!payload) {
			return new Response('No payload provided', { status: 400 });
		}

		const verifiedPayload = JwtPayloadSchema.parse(jwt.verify(payload, env.JWT_SECRET));
		const imageTransformer = await compositeImages(env, verifiedPayload.images);
		return imageTransformer.response();
	},
} satisfies ExportedHandler<Env>;

async function getAvailableCoffees(env: Env): Promise<{ coffees: Coffee[]; cacheRepr: string[]; updatedAt: Date | null }> {
	const request = await fetch(PRODUCTS_ENDPOINT, { headers: { 'User-Agent': 'Mozilla/5.0' } });
	const json = await request.json();
	const products = ShopifyProductsSchema.parse(json).products;

	const coffees: Coffee[] = products.flatMap((product) => {
		if (product.variants.length !== 1) throw new Error(`Expected exactly one variant per product, response was ${JSON.stringify(product)}`);

		return product.variants
			.filter((variant) => variant.available)
			.map((variant) => {
				return {
					title: product.title,
					handle: product.handle,
					price: variant.price,
					imageUrl: product.images[0].src,
				};
			})
			.sort((a, b) => a.title.localeCompare(b.title));
	});

	const cacheRepr = coffees.map((coffee) => coffee.handle);

	const updatedAt =
		products.length > 0
			? products.reduce(
					(latest, variant) => (new Date(variant.published_at) > latest ? new Date(variant.published_at) : latest),
					new Date(0)
			  )
			: null;

	return { coffees, cacheRepr, updatedAt };
}

async function cachePut(env: Env, value: any) {
	await env.instant_coffee.put(CACHE_NAME, JSON.stringify(value));
}

async function cacheGet(env: Env): Promise<string[] | null> {
	const value = await env.instant_coffee.get(CACHE_NAME);
	try {
		return value ? JSON.parse(value) : null;
	} catch (error) {
		return null;
	}
}

function arrayIsSubset(subset: any[], arr: any[]): boolean {
	return subset.every((item) => arr.includes(item));
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
