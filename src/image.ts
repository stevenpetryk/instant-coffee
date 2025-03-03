import { Buffer } from 'node:buffer';

const WHITE_1PX_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

export async function compositeImages(env: Env, imageUrls: string[]): Promise<ImageTransformationResult> {
	// @ts-expect-error - Wrangler is just not generating the types for this binding :/
	const IMAGES: ImagesBinding = env.IMAGES;

	const pixelRatio = 2;
	const squareSize = 300 * pixelRatio;
	const spacing = 20 * pixelRatio;
	const numImages = imageUrls.length;
	const totalWidth = squareSize * numImages + spacing * (2 + numImages - 1);
	const totalHeight = squareSize + spacing * 2;

	const whitePngBuffer = Buffer.from(WHITE_1PX_PNG, 'base64');

	// @ts-expect-error - idk how buffer types work but they're all lies
	let composite = await IMAGES.input(whitePngBuffer).transform({ width: totalWidth, height: totalHeight, fit: 'pad' });

	for (const [index, imageUrl] of imageUrls.entries()) {
		const image = await fetch(imageUrl);
		if (!image.body) throw new Error(`Failed to fetch image: ${imageUrl}`);

		const transformedImage = await IMAGES.input(image.body).transform({ width: squareSize, height: squareSize, fit: 'pad' });

		const left = spacing + index * (squareSize + spacing);
		composite = composite.draw(transformedImage, { left, top: spacing });
	}

	return await composite.output({ format: 'image/avif' });
}
